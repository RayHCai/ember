package manager

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ember/internal/edgeproto"
)

const (
	recordTimeout = 10 * time.Second
	// frameBacklog bounds the detections frames held per edge server while the api is away; the
	// oldest go first.
	frameBacklog   = 2000
	frameChunk     = 500
	recordRetry    = time.Second
	recordRetryMax = 30 * time.Second
)

// Recorder tells the api about the edge servers, drones, runs and detections the connectors report.
// Nothing is queued whole: updates merge into per-edge-server state under a mutex and one worker
// sends what is pending, so a slow api costs the uplinks nothing and loses no delta.
type Recorder struct {
	url    string
	key    string
	client *http.Client
	log    *slog.Logger
	wake   chan struct{}
	// retryMin and retryMax bound the backoff between passes while the api fails; tests shorten them.
	retryMin, retryMax time.Duration

	dropped atomic.Int64

	mu    sync.Mutex
	edges map[string]*edgeRecord

	// quiet and lastDropLog belong to Run's goroutine.
	quiet       map[string]*quietLog
	lastDropLog time.Time
}

type quietLog struct {
	last    time.Time
	skipped int
}

// edgeRecord is what the api has yet to be told about one edge server.
type edgeRecord struct {
	url string
	// registering holds back the drones and detections: the api refuses drones of an edge server it
	// does not know, and places a frame by the zone of the edge server it is sent for.
	registering bool
	drones      map[string]*droneRecord
	runs        map[string]*runRecord
	frames      frameQueue
}

type droneFields struct{ name, kind string }

type droneRecord struct {
	want, sent droneFields
	sentOnce   bool
}

func (d *droneRecord) pending() bool { return !d.sentOnce || d.want != d.sent }

type runRecord struct {
	latest edgeproto.EdgeRun
	// cells are mapped cells the api has not acknowledged.
	cells        map[int]struct{}
	sent         bool
	sentState    string
	sentCoverage float64
	// dead is set when the api refused the run for good, so the connector's repeats of it are ignored.
	dead bool
}

func (r *runRecord) pending() bool {
	return !r.dead && (len(r.cells) > 0 || !r.sent || r.latest.State != r.sentState || r.latest.Coverage != r.sentCoverage)
}

// frameQueue holds frames oldest first. base counts the frames that have left the front, so a send
// in flight can tell afterwards which of its frames are still queued.
type frameQueue struct {
	items []json.RawMessage
	base  int
}

// add appends frames, drops the oldest beyond frameBacklog and returns how many it dropped.
func (q *frameQueue) add(frames []json.RawMessage) int {
	q.items = append(q.items, frames...)
	over := len(q.items) - frameBacklog
	if over <= 0 {
		return 0
	}
	q.items = slices.Delete(q.items, 0, over)
	q.base += over
	return over
}

// head is the next chunk to send and the position just past it.
func (q *frameQueue) head() ([]json.RawMessage, int) {
	n := min(len(q.items), frameChunk)
	return slices.Clone(q.items[:n]), q.base + n
}

// release forgets the frames before end, a position head returned.
func (q *frameQueue) release(end int) {
	if n := end - q.base; n > 0 {
		q.items = slices.Delete(q.items, 0, n)
		q.base = end
	}
}

// NewRecorder records at apiURL with the shared edge key; an empty apiURL disables recording.
func NewRecorder(apiURL, key string, client *http.Client, log *slog.Logger) *Recorder {
	return &Recorder{
		url:      strings.TrimSuffix(apiURL, "/"),
		key:      key,
		client:   client,
		log:      log,
		wake:     make(chan struct{}, 1),
		retryMin: recordRetry,
		retryMax: recordRetryMax,
		edges:    map[string]*edgeRecord{},
		quiet:    map[string]*quietLog{},
	}
}

// Register notes that a connector registered, so the api is told of its edge server before its drones.
func (r *Recorder) Register(edgeServerID, url string) {
	if r.url == "" {
		return
	}
	r.mu.Lock()
	e := r.edge(edgeServerID)
	e.url, e.registering = url, true
	r.mu.Unlock()
	r.signal()
}

// Update merges one connector update into what is pending. It never blocks on the api.
func (r *Recorder) Update(u *edgeproto.EdgeUpdate) {
	if r.url == "" {
		return
	}
	r.mu.Lock()
	e := r.edge(u.EdgeServerID)
	for _, d := range u.Drones {
		e.noteDrone(d)
	}
	if u.Run != nil {
		e.noteRun(*u.Run)
	}
	dropped := e.frames.add(u.Detections)
	r.mu.Unlock()
	r.dropped.Add(int64(dropped))
	r.signal()
}

func (r *Recorder) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *Recorder) edge(id string) *edgeRecord {
	e := r.edges[id]
	if e == nil {
		e = &edgeRecord{drones: map[string]*droneRecord{}, runs: map[string]*runRecord{}}
		r.edges[id] = e
	}
	return e
}

func (e *edgeRecord) noteDrone(d edgeproto.EdgeDrone) {
	if d.DroneID == "" {
		return
	}
	rec := e.drones[d.DroneID]
	if rec == nil {
		rec = &droneRecord{}
		e.drones[d.DroneID] = rec
	}
	if !present(d.Hello) {
		return
	}
	var hello struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if json.Unmarshal(d.Hello, &hello) == nil {
		rec.want = droneFields{hello.Name, hello.Kind}
	}
}

func (e *edgeRecord) noteRun(run edgeproto.EdgeRun) {
	// A run the connector has moved on from is forgotten once the api has all of it.
	for id, old := range e.runs {
		if id != run.RunID && !old.pending() {
			delete(e.runs, id)
		}
	}
	rec := e.runs[run.RunID]
	if rec == nil {
		rec = &runRecord{cells: map[int]struct{}{}}
		e.runs[run.RunID] = rec
	}
	if rec.dead {
		return
	}
	for _, c := range run.NewCells {
		rec.cells[c] = struct{}{}
	}
	run.NewCells = nil
	if run.Swarm == nil {
		run.Swarm = []string{}
	}
	rec.latest = run
}
