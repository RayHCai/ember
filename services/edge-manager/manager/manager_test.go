package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"ember/internal/edgehttp"
	"ember/internal/edgeproto"
)

const testKey = "k"

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newManager(t *testing.T, droneInfoURL string) (*Manager, *httptest.Server) {
	t.Helper()
	m := New(testKey, droneInfoURL, quiet())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Forwarder.Run(ctx); close(done) }()
	srv := httptest.NewServer(m.Handler())
	t.Cleanup(func() { srv.Close(); cancel(); <-done; m.Wait() })
	return m, srv
}

// fakeConnector answers tasks the way edge-connector does and records what it was sent.
type fakeConnector struct {
	mu    sync.Mutex
	tasks []edgeproto.ConnectorTask
	auth  []string
	srv   *httptest.Server
}

func newFakeConnector(t *testing.T, drones []string) *fakeConnector {
	f := &fakeConnector{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var task edgeproto.ConnectorTask
		json.NewDecoder(r.Body).Decode(&task)
		f.mu.Lock()
		f.tasks = append(f.tasks, task)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		if r.URL.Path != edgeproto.TaskPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if len(drones) == 0 {
			edgehttp.WriteJSON(w, http.StatusConflict, edgeproto.ErrorBody{Error: "no drones connected"})
			return
		}
		runID := task.RunID
		if task.Mission != nil {
			runID = task.Mission.RunID
		}
		edgehttp.WriteJSON(w, http.StatusOK, edgeproto.ConnectorTaskResult{RunID: runID, Drones: drones})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeConnector) sent(i int) (edgeproto.ConnectorTask, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tasks[i], f.auth[i]
}

func post(t *testing.T, url, key string, body any) (int, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	edgeproto.SetKey(req.Header, key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func TestStartFansOutWithEachSitesGeometry(t *testing.T) {
	_, srv := newManager(t, "")
	one, two := newFakeConnector(t, []string{"a", "b"}), newFakeConnector(t, nil)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()

	task := map[string]any{
		"kind": "start_mapping", "runId": "run-1", "zoneId": "zone-1", "boundary": nil, "cellSizeM": 10,
		"altitude": map[string]any{"minM": 60, "maxM": 120},
		"edgeServers": []any{
			map[string]any{"edgeServerId": "e1", "url": one.srv.URL, "location": map[string]any{"lat": 1, "lng": 2}, "connectivityRadiusM": 400},
			map[string]any{"edgeServerId": "e2", "url": two.srv.URL + "/", "location": map[string]any{"lat": 3, "lng": 4}, "connectivityRadiusM": 300},
			map[string]any{"edgeServerId": "e3", "url": gone.URL, "location": map[string]any{"lat": 5, "lng": 6}, "connectivityRadiusM": 300},
		},
	}
	status, body := post(t, srv.URL+edgeproto.TaskPath, testKey, task)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, body)
	}
	var res edgeproto.EdgeTaskResult
	json.Unmarshal(body, &res)
	if res.RunID != "run-1" || len(res.Results) != 3 {
		t.Fatalf("%s", body)
	}
	if r := res.Results[0]; !r.OK || r.EdgeServerID != "e1" || strings.Join(r.Drones, ",") != "a,b" {
		t.Fatalf("e1: %+v", r)
	}
	if r := res.Results[1]; r.OK || !strings.Contains(r.Error, "409: no drones connected") {
		t.Fatalf("e2: %+v", r)
	}
	if r := res.Results[2]; r.OK || r.Error == "" {
		t.Fatalf("e3: %+v", r)
	}

	got, auth := one.sent(0)
	if got.Kind != edgeproto.KindStartMapping || got.Mission.EdgeServer.Lat != 1 || got.Mission.ConnectivityRadiusM != 400 ||
		got.Mission.RunID != "run-1" || got.Mission.Altitude.MaxM != 120 || auth != "Bearer "+testKey {
		t.Fatalf("e1 sent %+v (auth %q)", got.Mission, auth)
	}
	if got, _ := two.sent(0); got.Mission.EdgeServer.Lat != 3 {
		t.Fatalf("e2 sent %+v", got.Mission)
	}
}

func TestStopNeedsOnlyLinks(t *testing.T) {
	_, srv := newManager(t, "")
	one := newFakeConnector(t, []string{"a"})
	task := map[string]any{"kind": "stop_mapping", "runId": "run-1", "zoneId": "zone-1",
		"edgeServers": []any{map[string]any{"edgeServerId": "e1", "url": one.srv.URL}}}
	if status, body := post(t, srv.URL+edgeproto.TaskPath, testKey, task); status != http.StatusOK {
		t.Fatalf("%d %s", status, body)
	}
	if got, _ := one.sent(0); got.Kind != edgeproto.KindStopMapping || got.RunID != "run-1" || got.Mission != nil {
		t.Fatalf("sent %+v", got)
	}
}

func TestTaskRefusals(t *testing.T) {
	_, srv := newManager(t, "")
	stop := map[string]any{"kind": "stop_mapping", "runId": "r", "zoneId": "z",
		"edgeServers": []any{map[string]any{"edgeServerId": "e1", "url": "http://h:1"}}}
	if status, _ := post(t, srv.URL+edgeproto.TaskPath, "wrong", stop); status != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", status)
	}
	start := map[string]any{"kind": "start_mapping", "runId": "r", "zoneId": "z",
		"edgeServers": []any{map[string]any{"edgeServerId": "e1", "url": "http://h:1"}}}
	if status, body := post(t, srv.URL+edgeproto.TaskPath, testKey, start); status != http.StatusBadRequest {
		t.Fatalf("start without geometry: %d %s", status, body)
	}
}

type connectorSocket struct {
	t    *testing.T
	conn *websocket.Conn
}

func dialUplink(t *testing.T, srv *httptest.Server, key string) (*websocket.Conn, error) {
	t.Helper()
	h := http.Header{}
	edgeproto.SetKey(h, key)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+edgeproto.UplinkPath, &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		t.Cleanup(func() { conn.CloseNow() })
	}
	return conn, err
}

func register(t *testing.T, srv *httptest.Server, id string) *connectorSocket {
	t.Helper()
	conn, err := dialUplink(t, srv, testKey)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wsjson.Write(ctx, conn, edgeproto.EdgeRegister{Type: edgeproto.TypeRegister, EdgeServerID: id, URL: "http://10.0.0.5:8070"})
	var ack edgeproto.EdgeRegistered
	if err := wsjson.Read(ctx, conn, &ack); err != nil || ack.Type != edgeproto.TypeRegistered {
		t.Fatalf("register: %+v %v", ack, err)
	}
	return &connectorSocket{t: t, conn: conn}
}

func (c *connectorSocket) send(raw string) {
	c.t.Helper()
	if err := c.conn.Write(context.Background(), websocket.MessageText, []byte(raw)); err != nil {
		c.t.Fatal(err)
	}
}

func listEdges(t *testing.T, srv *httptest.Server) []edgeproto.EdgeServerStatus {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+edgeproto.EdgeServersPath, nil)
	edgeproto.SetKey(req.Header, testKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []edgeproto.EdgeServerStatus
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestUplinkRegistersAndForwardsWhatIsNew(t *testing.T) {
	forwarded := make(chan edgeproto.DroneInfoIngest, 8)
	droneInfo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != edgeproto.DroneInfoIngestPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var batch edgeproto.DroneInfoIngest
		json.NewDecoder(r.Body).Decode(&batch)
		forwarded <- batch
		edgehttp.WriteJSON(w, http.StatusOK, edgeproto.DroneInfoIngestResult{Accepted: len(batch.Messages), Errors: []string{}})
	}))
	defer droneInfo.Close()
	_, srv := newManager(t, droneInfo.URL)

	if _, err := dialUplink(t, srv, "wrong"); err == nil {
		t.Fatal("uplink accepted without the edge key")
	}

	c := register(t, srv, "e1")
	edges := listEdges(t, srv)
	if len(edges) != 1 || !edges[0].Online || edges[0].URL != "http://10.0.0.5:8070" {
		t.Fatalf("registry %+v", edges)
	}

	update := func(seq int, telemetry string) string {
		return `{"type":"update","edgeServerId":"e1","seq":` + string(rune('0'+seq)) + `,"sentAt":"t","drones":[` +
			`{"droneId":"a","hello":{"type":"hello","droneId":"a"},"connected":true,"lastSeen":"t","telemetry":` + telemetry + `,"status":null},` +
			`{"droneId":"b","hello":{"type":"hello","droneId":"b"},"connected":false,"lastSeen":"t","telemetry":null,"status":null}],` +
			`"run":{"runId":"run-1","zoneId":"z","state":"mapping","startedAt":"t","swarm":["a"],"edgeServer":{"lat":1,"lng":2},` +
			`"connectivityRadiusM":300,"cellSizeM":10,"coverage":0.2,"newCells":[4]},"detections":[{"type":"detections","frameId":` + string(rune('0'+seq)) + `}]}`
	}
	next := func() []string {
		t.Helper()
		select {
		case b := <-forwarded:
			out := make([]string, len(b.Messages))
			for i, m := range b.Messages {
				out[i] = string(m)
			}
			return out
		case <-time.After(3 * time.Second):
			t.Fatal("nothing forwarded")
			return nil
		}
	}

	c.send(`{"type":"update","edgeServerId":"someone-else","seq":1,"sentAt":"t","drones":[],"run":null,"detections":[{"x":1}]}`)
	c.send(update(1, `{"type":"telemetry","droneId":"a","sentAt":"1"}`))
	want := []string{`{"type":"hello","droneId":"a"}`, `{"type":"telemetry","droneId":"a","sentAt":"1"}`, `{"type":"detections","frameId":1}`}
	if got := next(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("first batch %v", got)
	}
	c.send(update(2, `{"type":"telemetry","droneId":"a","sentAt":"1"}`))
	if got := next(); strings.Join(got, " ") != `{"type":"detections","frameId":2}` {
		t.Fatalf("unchanged telemetry or a fresh hello forwarded again: %v", got)
	}
	c.send(update(3, `{"type":"telemetry","droneId":"a","sentAt":"2"}`))
	if got := next(); len(got) != 2 || got[0] != `{"type":"telemetry","droneId":"a","sentAt":"2"}` {
		t.Fatalf("third batch %v", got)
	}

	edges = listEdges(t, srv)
	if e := edges[0]; e.Drones != 2 || e.ConnectedDrones != 1 || e.Run == nil || e.Run.RunID != "run-1" {
		t.Fatalf("registry %+v", e)
	}

	newer := register(t, srv, "e1")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := c.conn.Read(ctx); err == nil {
		t.Fatal("old socket still open after the connector registered again")
	}
	if e := listEdges(t, srv)[0]; !e.Online {
		t.Fatal("old socket closing marked the newer one offline")
	}

	newer.conn.Close(websocket.StatusNormalClosure, "")
	eventually(t, "offline", func() bool { return !listEdges(t, srv)[0].Online })
}

func TestForwarderRetriesAFailedPost(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	got := make(chan []byte, 1)
	droneInfo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		b, _ := io.ReadAll(r.Body)
		got <- b
	}))
	defer droneInfo.Close()
	f := NewForwarder(droneInfo.URL, http.DefaultClient, quiet())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go f.Run(ctx)
	f.enqueue(&edgeproto.EdgeUpdate{EdgeServerID: "e1", Detections: []json.RawMessage{json.RawMessage(`{"frameId":1}`)}})
	select {
	case b := <-got:
		if string(b) != `{"messages":[{"frameId":1}]}` {
			t.Fatalf("got %s", b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("update lost after one failed post")
	}
}
