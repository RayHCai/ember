package manager

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ember/internal/edgehttp"
	"ember/internal/edgeproto"
)

type apiCall struct {
	method, path, auth string
	body               []byte
}

// apiStub stands in for the api: it records every request and answers with reply's status, 200 when
// reply is nil. A reply of 0 cuts the connection.
type apiStub struct {
	srv   *httptest.Server
	mu    sync.Mutex
	got   []apiCall
	reply func(apiCall) int
}

func newAPIStub(t *testing.T, reply func(apiCall) int) *apiStub {
	t.Helper()
	s := &apiStub{reply: reply}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c := apiCall{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		s.mu.Lock()
		s.got = append(s.got, c)
		s.mu.Unlock()
		status := http.StatusOK
		if s.reply != nil {
			status = s.reply(c)
		}
		if status == 0 {
			panic(http.ErrAbortHandler)
		}
		if status != http.StatusOK {
			edgehttp.WriteJSON(w, status, edgeproto.ErrorBody{Error: "stub says " + http.StatusText(status)})
			return
		}
		edgehttp.WriteJSON(w, status, map[string]any{})
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *apiStub) calls(prefix string) []apiCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []apiCall
	for _, c := range s.got {
		if strings.HasPrefix(c.path, prefix) {
			out = append(out, c)
		}
	}
	return out
}

func (s *apiStub) waitFor(t *testing.T, prefix string, n int) []apiCall {
	t.Helper()
	var got []apiCall
	eventually(t, fmt.Sprintf("%d calls to %s", n, prefix), func() bool {
		got = s.calls(prefix)
		return len(got) >= n
	})
	return got
}

func (s *apiStub) paths() []string {
	var out []string
	for _, c := range s.calls("") {
		out = append(out, c.method+" "+c.path)
	}
	return out
}

func bodyOf[T any](t *testing.T, c apiCall) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(c.body, &v); err != nil {
		t.Fatalf("%s: %v", c.body, err)
	}
	return v
}

func newRecorder(apiURL string) *Recorder {
	r := NewRecorder(apiURL, testKey, http.DefaultClient, quiet())
	r.retryMin, r.retryMax = 5*time.Millisecond, 20*time.Millisecond
	return r
}

func startRecorder(t *testing.T, r *Recorder) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

func droneOf(id, hello string) edgeproto.EdgeDrone {
	return edgeproto.EdgeDrone{DroneID: id, Hello: json.RawMessage(hello), Connected: true}
}

func runOf(id, zone, state string, coverage float64, cells ...int) *edgeproto.EdgeRun {
	return &edgeproto.EdgeRun{
		RunID: id, ZoneID: zone, State: state, StartedAt: "t", Swarm: []string{"a"},
		EdgeServer: edgeproto.LatLng{Lat: 1, Lng: 2}, ConnectivityRadiusM: 300, CellSizeM: 10,
		Coverage: coverage, NewCells: cells,
	}
}

func framesFrom(first, n int) []json.RawMessage {
	out := make([]json.RawMessage, n)
	for i := range out {
		out[i] = json.RawMessage(fmt.Sprintf(`{"frameId":%d}`, first+i))
	}
	return out
}

func updateOf(edge string, drones []edgeproto.EdgeDrone, run *edgeproto.EdgeRun, frames []json.RawMessage) *edgeproto.EdgeUpdate {
	return &edgeproto.EdgeUpdate{Type: edgeproto.TypeUpdate, EdgeServerID: edge, Drones: drones, Run: run, Detections: frames}
}

const zoneID = "6f1c1c1e-3b0a-4b8e-9d57-0a1f6c7e2b11"

func TestUplinkIsRecordedAtTheAPI(t *testing.T) {
	stub := newAPIStub(t, nil)
	_, srv := newManagerWithAPI(t, "", stub.srv.URL)
	c := register(t, srv, "e1")

	reg := stub.waitFor(t, edgeproto.APIEdgeServersPath, 1)[0]
	if reg.method != http.MethodPut || reg.path != "/v1/edge-servers/e1" || reg.auth != "Bearer "+testKey ||
		string(reg.body) != `{"url":"http://10.0.0.5:8070"}` {
		t.Fatalf("registration %+v %s", reg, reg.body)
	}

	update := func(nameOfA string, frame int) string {
		return `{"type":"update","edgeServerId":"e1","seq":1,"sentAt":"t","drones":[` +
			`{"droneId":"a","hello":{"type":"hello","droneId":"a","name":"` + nameOfA + `","kind":"simulated"},"connected":true,"lastSeen":"t","telemetry":null,"status":null},` +
			`{"droneId":"b","hello":{"type":"hello","droneId":"b"},"connected":false,"lastSeen":"t","telemetry":null,"status":null}],` +
			`"run":null,"detections":[{"frameId":` + fmt.Sprint(frame) + `}]}`
	}
	c.send(update("scout", 1))
	drones := stub.waitFor(t, edgeproto.APIDronesPath, 2)
	if len(drones) != 2 || drones[0].method != http.MethodPut || drones[0].path != "/v1/drones/a" || drones[0].auth != "Bearer "+testKey ||
		string(drones[0].body) != `{"edgeServerId":"e1","name":"scout","kind":"simulated"}` ||
		drones[1].path != "/v1/drones/b" || string(drones[1].body) != `{"edgeServerId":"e1"}` {
		t.Fatalf("drones %+v", drones)
	}
	posted := stub.waitFor(t, edgeproto.APIDetectionsPath, 1)[0]
	if posted.method != http.MethodPost || string(posted.body) != `{"edgeServerId":"e1","frames":[{"frameId":1}]}` {
		t.Fatalf("detections %s", posted.body)
	}

	c.send(update("scout", 2))
	stub.waitFor(t, edgeproto.APIDetectionsPath, 2)
	if n := len(stub.calls(edgeproto.APIDronesPath)); n != 2 {
		t.Fatalf("an identical update sent drones again: %d requests", n)
	}

	c.send(update("renamed", 3))
	drones = stub.waitFor(t, edgeproto.APIDronesPath, 3)
	if len(drones) != 3 || string(drones[2].body) != `{"edgeServerId":"e1","name":"renamed","kind":"simulated"}` {
		t.Fatalf("drones after a rename %+v", drones)
	}
}

func TestDronesWaitForTheRegistration(t *testing.T) {
	var edgeTries atomic.Int32
	stub := newAPIStub(t, func(c apiCall) int {
		if strings.HasPrefix(c.path, edgeproto.APIEdgeServersPath) && edgeTries.Add(1) == 1 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	})
	r := newRecorder(stub.srv.URL)
	r.Register("e1", "http://10.0.0.5:8070")
	r.Update(updateOf("e1", []edgeproto.EdgeDrone{droneOf("a", `{"name":"scout"}`)}, nil, framesFrom(1, 1)))
	startRecorder(t, r)

	stub.waitFor(t, edgeproto.APIDetectionsPath, 1)
	want := []string{"PUT /v1/edge-servers/e1", "PUT /v1/edge-servers/e1", "PUT /v1/drones/a", "POST /v1/detections"}
	if got := stub.paths(); !slices.Equal(got, want) {
		t.Fatalf("requests %v want %v", got, want)
	}
}

func TestADroneRefusedForAnUnknownEdgeServerRegistersItAgain(t *testing.T) {
	var droneTries atomic.Int32
	stub := newAPIStub(t, func(c apiCall) int {
		if strings.HasPrefix(c.path, edgeproto.APIDronesPath) && droneTries.Add(1) == 1 {
			return http.StatusConflict
		}
		return http.StatusOK
	})
	r := newRecorder(stub.srv.URL)
	startRecorder(t, r)
	r.Register("e1", "http://10.0.0.5:8070")
	r.Update(updateOf("e1", []edgeproto.EdgeDrone{droneOf("a", `{"name":"scout"}`)}, nil, nil))

	stub.waitFor(t, edgeproto.APIDronesPath, 2)
	eventually(t, "the second registration", func() bool { return len(stub.calls(edgeproto.APIEdgeServersPath)) >= 2 })
	want := []string{"PUT /v1/edge-servers/e1", "PUT /v1/drones/a", "PUT /v1/edge-servers/e1", "PUT /v1/drones/a"}
	if got := stub.paths(); !slices.Equal(got, want) {
		t.Fatalf("requests %v want %v", got, want)
	}
}

func TestRunCellsOfAFailedPutAreSentAgain(t *testing.T) {
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	t.Cleanup(release)
	var first atomic.Bool
	stub := newAPIStub(t, func(c apiCall) int {
		if strings.HasPrefix(c.path, edgeproto.APIMappingRunsPath) && !first.Swap(true) {
			<-gate
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	})
	r := newRecorder(stub.srv.URL)
	startRecorder(t, r)

	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "mapping", 0.1, 1, 2), nil))
	stub.waitFor(t, edgeproto.APIMappingRunsPath, 1)
	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "mapping", 0.2, 3), nil))
	release()

	puts := stub.waitFor(t, edgeproto.APIMappingRunsPath, 2)
	if puts[0].method != http.MethodPut || puts[0].path != "/v1/mapping-runs/run-1/edge-servers/e1" || puts[0].auth != "Bearer "+testKey {
		t.Fatalf("first put %+v", puts[0])
	}
	got := bodyOf[edgeproto.EdgeRun](t, puts[1])
	if !slices.Equal(got.NewCells, []int{1, 2, 3}) || got.Coverage != 0.2 || got.ZoneID != zoneID || got.State != edgeproto.RunMapping {
		t.Fatalf("retry carried %+v", got)
	}

	// Acknowledged cells are not sent twice; an update that changes nothing sends nothing.
	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "mapping", 0.2), framesFrom(1, 1)))
	stub.waitFor(t, edgeproto.APIDetectionsPath, 1)
	if n := len(stub.calls(edgeproto.APIMappingRunsPath)); n != 2 {
		t.Fatalf("unchanged run sent again: %d puts", n)
	}
	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "mapping", 0.2, 4), nil))
	puts = stub.waitFor(t, edgeproto.APIMappingRunsPath, 3)
	if got := bodyOf[edgeproto.EdgeRun](t, puts[2]); !slices.Equal(got.NewCells, []int{4}) {
		t.Fatalf("third put carried %+v", got)
	}
	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "done", 0.2), framesFrom(2, 1)))
	puts = stub.waitFor(t, edgeproto.APIMappingRunsPath, 4)
	if got := bodyOf[edgeproto.EdgeRun](t, puts[3]); got.State != edgeproto.RunDone || got.NewCells == nil || len(got.NewCells) != 0 {
		t.Fatalf("state change put %s", puts[3].body)
	}
}

func TestADroppedConnectionIsRetried(t *testing.T) {
	var tries atomic.Int32
	stub := newAPIStub(t, func(apiCall) int {
		if tries.Add(1) == 1 {
			return 0
		}
		return http.StatusOK
	})
	r := newRecorder(stub.srv.URL)
	startRecorder(t, r)
	r.Update(updateOf("e1", nil, runOf("run-1", zoneID, "mapping", 0.1, 7), nil))

	puts := stub.waitFor(t, edgeproto.APIMappingRunsPath, 2)
	if got := bodyOf[edgeproto.EdgeRun](t, puts[1]); !slices.Equal(got.NewCells, []int{7}) {
		t.Fatalf("retry carried %+v", got)
	}
}

func TestARunTheAPIRefusesIsDroppedNotRetried(t *testing.T) {
	stub := newAPIStub(t, func(c apiCall) int {
		if strings.HasPrefix(c.path, edgeproto.APIMappingRunsPath) {
			return http.StatusBadRequest
		}
		return http.StatusOK
	})
	r := newRecorder(stub.srv.URL)
	startRecorder(t, r)

	r.Update(updateOf("e1", nil, runOf("run-x", "zone-1", "mapping", 0, 1), nil))
	stub.waitFor(t, edgeproto.APIMappingRunsPath, 1)
	r.Update(updateOf("e1", nil, runOf("run-x", "zone-1", "mapping", 0.1, 2), framesFrom(1, 1)))
	stub.waitFor(t, edgeproto.APIDetectionsPath, 1)
	r.Update(updateOf("e1", nil, runOf("run-x", "zone-1", "done", 0.3, 3), framesFrom(2, 1)))
	stub.waitFor(t, edgeproto.APIDetectionsPath, 2)

	if n := len(stub.calls(edgeproto.APIMappingRunsPath)); n != 1 {
		t.Fatalf("a refused run was sent %d times", n)
	}
}

func TestDetectionsGoInChunksWithTheEdgeServer(t *testing.T) {
	stub := newAPIStub(t, nil)
	r := newRecorder(stub.srv.URL)
	r.Update(updateOf("e1", nil, nil, framesFrom(0, 1200)))
	startRecorder(t, r)

	posts := stub.waitFor(t, edgeproto.APIDetectionsPath, 3)
	next := 0
	for i, size := range []int{500, 500, 200} {
		got := bodyOf[edgeproto.DetectionsIngest](t, posts[i])
		if got.EdgeServerID != "e1" || len(got.Frames) != size || posts[i].auth != "Bearer "+testKey {
			t.Fatalf("chunk %d: %s %d frames", i, got.EdgeServerID, len(got.Frames))
		}
		for _, f := range got.Frames {
			if want := fmt.Sprintf(`{"frameId":%d}`, next); string(f) != want {
				t.Fatalf("chunk %d: frame %s want %s", i, f, want)
			}
			next++
		}
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(stub.calls(edgeproto.APIDetectionsPath)); n != 3 {
		t.Fatalf("%d detection posts", n)
	}
}

func TestDetectionsBeyondTheBacklogDropTheOldest(t *testing.T) {
	stub := newAPIStub(t, nil)
	r := newRecorder(stub.srv.URL)
	r.Update(updateOf("e1", nil, nil, framesFrom(0, 1500)))
	r.Update(updateOf("e1", nil, nil, framesFrom(1500, 1000)))
	if got := r.dropped.Load(); got != 500 {
		t.Fatalf("dropped %d", got)
	}
	startRecorder(t, r)

	posts := stub.waitFor(t, edgeproto.APIDetectionsPath, 4)
	if first := bodyOf[edgeproto.DetectionsIngest](t, posts[0]).Frames[0]; string(first) != `{"frameId":500}` {
		t.Fatalf("oldest kept frame %s", first)
	}
	if last := bodyOf[edgeproto.DetectionsIngest](t, posts[3]).Frames; string(last[len(last)-1]) != `{"frameId":2499}` {
		t.Fatalf("newest frame %s", last[len(last)-1])
	}
}

func TestFramesQueuedDuringASendSurviveIt(t *testing.T) {
	var q frameQueue
	q.add(framesFrom(0, 700))
	chunk, end := q.head()
	if len(chunk) != frameChunk {
		t.Fatalf("chunk of %d", len(chunk))
	}
	q.add(framesFrom(700, 2000))
	q.release(end)
	if len(q.items) != frameBacklog || string(q.items[0]) != `{"frameId":700}` {
		t.Fatalf("%d frames left, first %s", len(q.items), q.items[0])
	}
}

func TestNoAPIURLRecordsNothing(t *testing.T) {
	stub := newAPIStub(t, nil)
	r := newRecorder("")
	r.Register("e1", stub.srv.URL)
	r.Update(updateOf("e1", []edgeproto.EdgeDrone{droneOf("a", `{"name":"scout"}`)}, runOf("run-1", zoneID, "mapping", 0.1, 1), framesFrom(0, 3)))

	done := make(chan struct{})
	go func() { r.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run waits although recording is off")
	}
	if n := len(stub.calls("")); n != 0 || len(r.edges) != 0 {
		t.Fatalf("%d requests, %d edge servers held", n, len(r.edges))
	}
}
