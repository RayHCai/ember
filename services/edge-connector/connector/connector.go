// Package connector is one edge server's drone network: pairing, runs, swarm relay and the
// aggregated update it sends edge-manager.
package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"ember/internal/edgeproto"
)

// A drone of a run silent this long counts as out of it (dropped off, or restarted idle and so no
// longer reporting), so the run can end without it.
const lostAfter = 2 * time.Minute

// Connector holds every paired drone and the current run. One mutex guards all of it: messages
// arrive at a few per second per drone, far below where contention matters.
type Connector struct {
	ID    string
	URL   string
	store *Store
	log   *slog.Logger

	// links counts open drone sockets, so shutdown can wait for their last store writes.
	links sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
	drones   map[string]*drone
	run      *run
	agg      aggregate
}

type drone struct {
	id          string
	hello       json.RawMessage
	lastSeen    time.Time
	telemetry   json.RawMessage
	telemetryAt time.Time
	status      json.RawMessage
	statusAt    time.Time
	phase       string
	health      health
	dirty       bool
}

type run struct {
	mission   edgeproto.MappingMission
	state     string
	startedAt time.Time
	endedAt   time.Time
	// since is when this process took the run on: its start, or the boot that resumed it.
	since     time.Time
	coverage  float64
	cells     map[int]struct{}
	newCells  []int
	gridCells int
}

func newRun(m edgeproto.MappingMission, state string, startedAt time.Time) *run {
	cols := gridCols(m.ConnectivityRadiusM, m.CellSizeM)
	return &run{mission: m, state: state, startedAt: startedAt, since: startedAt, cells: map[int]struct{}{}, gridCells: cols * cols}
}

func (r *run) stored() storedRun {
	return storedRun{mission: r.mission, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt}
}

// gridCols follows the grid MappingMission defines: ceil(2 * radius / cell) a side.
func gridCols(radiusM, cellM float64) int {
	n := 2 * radiusM / cellM
	cols := int(n)
	if float64(cols) < n {
		cols++
	}
	return cols
}

// New loads the drones and any interrupted run from the store.
func New(ctx context.Context, id, url string, store *Store, log *slog.Logger) (*Connector, error) {
	c := &Connector{
		ID: id, URL: url, store: store, log: log,
		sessions: map[string]*session{},
		drones:   map[string]*drone{},
		agg:      newAggregate(),
	}
	paired, err := store.Drones(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range paired {
		c.drones[p.id] = &drone{id: p.id, hello: p.hello, lastSeen: p.lastSeen}
	}
	active, err := store.ActiveRun(ctx)
	if err != nil {
		return nil, err
	}
	if active != nil {
		c.run = newRun(active.mission, active.state, active.startedAt)
		c.run.since = time.Now()
		log.Info("resuming run", "run", active.mission.RunID, "state", active.state, "swarm", active.mission.Swarm)
	}
	return c, nil
}

// Wait returns once every drone socket has closed and recorded it.
func (c *Connector) Wait() { c.links.Wait() }

// taskError is a task the connector refuses, with the HTTP status that says why.
type taskError struct {
	status int
	msg    string
}

func (e *taskError) Error() string { return e.msg }

// Start sends a run to every connected drone. Starting the active run again answers with its swarm.
func (c *Connector) Start(ctx context.Context, m edgeproto.MappingMission) (edgeproto.ConnectorTaskResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r := c.run; r != nil && r.state != edgeproto.RunDone {
		if r.mission.RunID == m.RunID {
			return edgeproto.ConnectorTaskResult{RunID: m.RunID, Drones: r.mission.Swarm}, nil
		}
		return edgeproto.ConnectorTaskResult{}, &taskError{http.StatusConflict,
			fmt.Sprintf("edge server %s: run %s is still %s", c.ID, r.mission.RunID, r.state)}
	}
	swarm := make([]string, 0, len(c.sessions))
	for id := range c.sessions {
		swarm = append(swarm, id)
	}
	if len(swarm) == 0 {
		return edgeproto.ConnectorTaskResult{}, &taskError{http.StatusConflict,
			fmt.Sprintf("edge server %s: no drones connected", c.ID)}
	}
	slices.Sort(swarm)
	m.Swarm = swarm

	next := newRun(m, edgeproto.RunMapping, time.Now())
	// Persisted before any drone hears of it, so a restart mid-run resumes it.
	if err := c.store.SaveRun(ctx, next.stored()); err != nil {
		return edgeproto.ConnectorTaskResult{}, err
	}
	c.run = next
	for _, id := range swarm {
		d := c.drones[id]
		d.status, d.statusAt, d.phase = nil, time.Time{}, ""
	}
	msg := mustJSON(edgeproto.StartMapping{Type: edgeproto.TypeStartMapping, Mission: m})
	for _, id := range swarm {
		c.sessions[id].queue(msg)
	}
	c.log.Info("run started", "run", m.RunID, "zone", m.ZoneID, "swarm", swarm)
	return edgeproto.ConnectorTaskResult{RunID: m.RunID, Drones: swarm}, nil
}

// Stop sends the run's drones home. Stopping a run already stopping or done answers with its swarm.
func (c *Connector) Stop(ctx context.Context, runID string) (edgeproto.ConnectorTaskResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := c.run
	if r == nil || r.mission.RunID != runID {
		return edgeproto.ConnectorTaskResult{}, &taskError{http.StatusNotFound,
			fmt.Sprintf("edge server %s: no run %s", c.ID, runID)}
	}
	out := edgeproto.ConnectorTaskResult{RunID: runID, Drones: r.mission.Swarm}
	if r.state == edgeproto.RunDone {
		return out, nil
	}
	if r.state == edgeproto.RunMapping {
		stopping := r.stored()
		stopping.state = edgeproto.RunStopping
		if err := c.store.SaveRun(ctx, stopping); err != nil {
			return edgeproto.ConnectorTaskResult{}, err
		}
		r.state = edgeproto.RunStopping
	}
	msg := mustJSON(edgeproto.StopMapping{Type: edgeproto.TypeStopMapping, RunID: runID})
	for _, id := range r.mission.Swarm {
		if s := c.sessions[id]; s != nil {
			s.queue(msg)
		}
	}
	c.log.Info("run stopping", "run", runID)
	return out, nil
}

// attach makes s the drone's live session, replacing an older one, and puts a drone that drops
// back in mid-run back on its run.
func (c *Connector) attach(ctx context.Context, s *session, hello edgeproto.DroneHello, raw []byte) error {
	now := time.Now()
	if err := c.store.PairDrone(ctx, hello, raw, now); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old := c.sessions[hello.DroneID]; old != nil {
		old.kick()
	}
	c.sessions[hello.DroneID] = s
	d := c.drones[hello.DroneID]
	if d == nil {
		d = &drone{id: hello.DroneID}
		c.drones[hello.DroneID] = d
	}
	d.hello, d.lastSeen = raw, now

	s.queue(mustJSON(edgeproto.EdgeWelcome{Type: edgeproto.TypeWelcome, EdgeServerID: c.ID, ServerTime: edgeproto.Stamp(now)}))
	r := c.run
	if r == nil || r.state == edgeproto.RunDone || !slices.Contains(r.mission.Swarm, hello.DroneID) {
		return nil
	}
	// Only a drone this process saw flying the run: a start to one that has landed would fly the
	// run again. The runtime ignores a start for the run it is flying, so this revives a restart.
	if d.phase == "" || d.phase == "landed" {
		return nil
	}
	if r.state == edgeproto.RunMapping {
		s.queue(mustJSON(edgeproto.StartMapping{Type: edgeproto.TypeStartMapping, Mission: r.mission}))
	} else {
		s.queue(mustJSON(edgeproto.StopMapping{Type: edgeproto.TypeStopMapping, RunID: r.mission.RunID}))
	}
	c.log.Info("drone rejoined run", "drone", hello.DroneID, "run", r.mission.RunID, "state", r.state)
	return nil
}

func (c *Connector) detach(ctx context.Context, s *session) {
	now := time.Now()
	c.mu.Lock()
	current := c.sessions[s.droneID] == s
	if current {
		delete(c.sessions, s.droneID)
		c.drones[s.droneID].lastSeen = now
	}
	c.mu.Unlock()
	if !current {
		return
	}
	if err := c.store.Disconnected(ctx, s.droneID, now); err != nil {
		c.log.Error("drone disconnect not saved", "drone", s.droneID, "err", err)
	}
}

// relay sends a swarm message to the other drones of the run, stamped with its sender, and folds
// coverage into the run's mapped cells.
func (c *Connector) relay(from string, env edgeproto.SwarmEnvelope) {
	var payload struct {
		Kind  string `json:"kind"`
		Cells []int  `json:"cells"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		c.log.Warn("swarm message dropped", "drone", from, "err", err)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	r := c.run
	if r == nil || r.state == edgeproto.RunDone || r.mission.RunID != env.RunID || !slices.Contains(r.mission.Swarm, from) {
		return
	}
	env.From = from
	msg := mustJSON(env)
	for _, id := range r.mission.Swarm {
		if s := c.sessions[id]; s != nil && id != from {
			s.queue(msg)
		}
	}
	if payload.Kind != "coverage" {
		return
	}
	for _, cell := range payload.Cells {
		if cell < 0 || cell >= r.gridCells {
			continue
		}
		if _, seen := r.cells[cell]; !seen {
			r.cells[cell] = struct{}{}
			r.newCells = append(r.newCells, cell)
		}
	}
}

// finished reports whether every drone of the run has landed or been silent long enough to count out.
func (c *Connector) finished(r *run, now time.Time) bool {
	for _, id := range r.mission.Swarm {
		d := c.drones[id]
		if d == nil || d.phase == "landed" {
			continue
		}
		last := d.statusAt
		if last.Before(r.since) {
			last = r.since
		}
		if now.Sub(last) <= lostAfter {
			return false
		}
	}
	return true
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("edge link message: %v", err))
	}
	return b
}
