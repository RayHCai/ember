package connector

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"ember/internal/edgeproto"
)

const (
	// maxPending caps detections held while edge-manager is unreachable; the oldest go first.
	maxPending = 2000
	// maxPerUpdate keeps one update well under the manager's frame limit.
	maxPerUpdate = 200
	// seenFor is how long a detections frame is remembered for dedupe.
	seenFor = 5 * time.Minute
)

// aggregate is what the connector has to send up that is not plain drone state: detections not yet
// taken by the manager, and which frames it has already seen. Guarded by Connector.mu.
type aggregate struct {
	seq     int64
	nextN   int64
	pending []pendingDetections
	seen    map[frameKey]time.Time
	dropped int
}

type pendingDetections struct {
	n   int64
	raw json.RawMessage
}

type frameKey struct {
	droneID    string
	frameID    int64
	capturedAt string
}

func newAggregate() aggregate {
	return aggregate{seen: map[frameKey]time.Time{}}
}

type telemetryHead struct {
	DroneID    string  `json:"droneId"`
	SentAt     string  `json:"sentAt"`
	BatteryPct float64 `json:"batteryPct"`
	Mode       string  `json:"mode"`
	Pose       struct {
		Lat  float64 `json:"lat"`
		Lng  float64 `json:"lng"`
		AltM float64 `json:"altM"`
	} `json:"pose"`
}

type detectionsHead struct {
	DroneID    string `json:"droneId"`
	FrameID    *int64 `json:"frameId"`
	CapturedAt string `json:"capturedAt"`
}

// uplink takes one message a drone sent on its session.
func (c *Connector) uplink(droneID string, raw []byte) error {
	kind, err := edgeproto.LinkType(raw)
	if err != nil {
		return err
	}
	switch kind {
	case edgeproto.TypeTelemetry:
		var t telemetryHead
		if err := decodeFrom(raw, droneID, &t, &t.DroneID); err != nil {
			return err
		}
		sentAt, err := time.Parse(time.RFC3339Nano, t.SentAt)
		if err != nil {
			return fmt.Errorf("telemetry: sentAt %q: %w", t.SentAt, err)
		}
		c.onTelemetry(droneID, raw, t, sentAt)
	case edgeproto.TypeDetections:
		var d detectionsHead
		if err := decodeFrom(raw, droneID, &d, &d.DroneID); err != nil {
			return err
		}
		if d.FrameID == nil {
			return fmt.Errorf("detections: missing frameId")
		}
		c.onDetections(droneID, raw, frameKey{droneID, *d.FrameID, d.CapturedAt})
	case edgeproto.TypeMissionStatus:
		var s edgeproto.MissionStatus
		if err := decodeFrom(raw, droneID, &s, &s.DroneID); err != nil {
			return err
		}
		c.onStatus(droneID, raw, s)
	case edgeproto.TypeSwarm:
		var env edgeproto.SwarmEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("swarm: %w", err)
		}
		c.relay(droneID, env)
	default:
		return fmt.Errorf("unexpected %q message", kind)
	}
	return nil
}

// decodeFrom decodes a drone message and checks it speaks for the drone whose session carried it.
func decodeFrom(raw []byte, droneID string, into any, claimed *string) error {
	if err := json.Unmarshal(raw, into); err != nil {
		return err
	}
	if *claimed != droneID {
		return fmt.Errorf("message for drone %q on the link of %q", *claimed, droneID)
	}
	return nil
}

// onTelemetry keeps the latest telemetry by the drone's own clock; a repeat or a late one is dropped.
func (c *Connector) onTelemetry(droneID string, raw []byte, t telemetryHead, sentAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.drones[droneID]
	d.lastSeen = time.Now()
	if !sentAt.After(d.telemetryAt) {
		return
	}
	d.telemetry, d.telemetryAt = raw, sentAt
	d.health = health{
		droneID: droneID, lastSeen: d.lastSeen, batteryPct: t.BatteryPct, mode: t.Mode, phase: d.phase,
		lat: t.Pose.Lat, lng: t.Pose.Lng, altM: t.Pose.AltM,
	}
	d.dirty = true
}

// onDetections queues a frame's detections once, however many times it arrives.
func (c *Connector) onDetections(droneID string, raw []byte, key frameKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.drones[droneID].lastSeen = now
	a := &c.agg
	if _, dup := a.seen[key]; dup {
		return
	}
	a.seen[key] = now
	if len(a.pending) >= maxPending {
		a.pending = a.pending[1:]
		a.dropped++
	}
	a.nextN++
	a.pending = append(a.pending, pendingDetections{n: a.nextN, raw: raw})
}

// onStatus keeps a drone's latest mission status for the current run.
func (c *Connector) onStatus(droneID string, raw []byte, s edgeproto.MissionStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.drones[droneID]
	d.lastSeen = time.Now()
	r := c.run
	if r == nil || r.mission.RunID != s.RunID {
		return
	}
	d.status, d.statusAt, d.phase = raw, d.lastSeen, s.Phase
	d.health.phase = s.Phase
	if s.Coverage > r.coverage {
		r.coverage = s.Coverage
	}
}

// tickResult is one update and what the connector owes the store and the manager for it.
type tickResult struct {
	update  edgeproto.EdgeUpdate
	health  []health
	ended   *storedRun
	upToN   int64
	cells   int
	dropped int
}

// snapshot builds the next update. Detections and new cells stay queued until ack, so an update
// the manager never took is sent again in the next one.
func (c *Connector) snapshot() tickResult {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	out := tickResult{update: edgeproto.EdgeUpdate{
		Type:         edgeproto.TypeUpdate,
		EdgeServerID: c.ID,
		Seq:          c.agg.seq + 1,
		SentAt:       edgeproto.Stamp(now),
		Drones:       make([]edgeproto.EdgeDrone, 0, len(c.drones)),
		Detections:   []json.RawMessage{},
	}}

	ids := make([]string, 0, len(c.drones))
	for id := range c.drones {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		d := c.drones[id]
		out.update.Drones = append(out.update.Drones, edgeproto.EdgeDrone{
			DroneID:   d.id,
			Hello:     d.hello,
			Connected: c.sessions[id] != nil,
			LastSeen:  edgeproto.Stamp(d.lastSeen),
			Telemetry: d.telemetry,
			Status:    d.status,
		})
		if d.dirty {
			out.health = append(out.health, d.health)
			d.dirty = false
		}
	}

	if r := c.run; r != nil {
		if r.state != edgeproto.RunDone && c.finished(r, now) {
			r.state, r.endedAt = edgeproto.RunDone, now
			ended := r.stored()
			out.ended = &ended
		}
		out.cells = len(r.newCells)
		out.update.Run = &edgeproto.EdgeRun{
			RunID: r.mission.RunID, ZoneID: r.mission.ZoneID, State: r.state,
			StartedAt: edgeproto.Stamp(r.startedAt), Swarm: r.mission.Swarm,
			EdgeServer: r.mission.EdgeServer, ConnectivityRadiusM: r.mission.ConnectivityRadiusM,
			CellSizeM: r.mission.CellSizeM, Coverage: r.coverage,
			NewCells: append([]int{}, r.newCells...),
		}
	}

	a := &c.agg
	for _, p := range a.pending[:min(len(a.pending), maxPerUpdate)] {
		out.update.Detections = append(out.update.Detections, p.raw)
		out.upToN = p.n
	}
	for k, at := range a.seen {
		if now.Sub(at) > seenFor {
			delete(a.seen, k)
		}
	}
	out.dropped, a.dropped = a.dropped, 0
	return out
}

// ack removes what the manager took: detections up to upToN and the first cells new cells of runID.
func (c *Connector) ack(seq, upToN int64, runID string, cells int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	a := &c.agg
	a.seq = seq
	i := 0
	for i < len(a.pending) && a.pending[i].n <= upToN {
		i++
	}
	a.pending = a.pending[i:]
	if r := c.run; r != nil && r.mission.RunID == runID && cells <= len(r.newCells) {
		r.newCells = r.newCells[cells:]
	}
}
