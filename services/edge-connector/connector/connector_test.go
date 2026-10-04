package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"ember/internal/edgeproto"
)

const testKey = "k"

type harness struct {
	t     *testing.T
	c     *Connector
	store *Store
	srv   *httptest.Server
	up    *fakeUplink
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	store, err := OpenStore(ctx, filepath.Join(t.TempDir(), "edge.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	c, err := New(ctx, "edge-1", "http://edge-1:8070", store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(c.Handler(testKey))
	t.Cleanup(func() { srv.Close(); c.Wait() })
	return &harness{t: t, c: c, store: store, srv: srv, up: &fakeUplink{}}
}

type fakeUplink struct {
	fail bool
	got  []edgeproto.EdgeUpdate
}

func (f *fakeUplink) Send(_ context.Context, u edgeproto.EdgeUpdate) error {
	if f.fail {
		return errors.New("down")
	}
	f.got = append(f.got, u)
	return nil
}

func (h *harness) tick() edgeproto.EdgeUpdate {
	h.t.Helper()
	h.c.Tick(context.Background(), h.up)
	if len(h.up.got) == 0 {
		h.t.Fatal("no update sent")
	}
	return h.up.got[len(h.up.got)-1]
}

type fakeDrone struct {
	t    *testing.T
	id   string
	conn *websocket.Conn
}

func (h *harness) drone(id string) *fakeDrone {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(h.srv.URL, "http") + edgeproto.DroneLinkPath
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { conn.CloseNow() })
	d := &fakeDrone{t: h.t, id: id, conn: conn}
	d.send(edgeproto.DroneHello{
		Type: edgeproto.TypeHello, DroneID: id, Name: "Drone " + id, Kind: "simulated",
		Camera: edgeproto.CameraSpec{WidthPx: 640, HeightPx: 480, HfovDeg: 90}, Sensors: []string{"rgb"},
		MaxSpeedMps: 12, EnduranceS: 1200,
	})
	if w := d.next(); w["type"] != "welcome" || w["edgeServerId"] != "edge-1" {
		h.t.Fatalf("%s: want welcome, got %v", id, w)
	}
	return d
}

func (d *fakeDrone) send(v any) {
	d.t.Helper()
	b, _ := json.Marshal(v)
	if err := d.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		d.t.Fatal(err)
	}
}

func (d *fakeDrone) next() map[string]any {
	d.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, raw, err := d.conn.Read(ctx)
	if err != nil {
		d.t.Fatalf("%s: %v", d.id, err)
	}
	var m map[string]any
	json.Unmarshal(raw, &m)
	return m
}

func (d *fakeDrone) telemetry(sentAt string, battery float64) {
	d.send(map[string]any{
		"type": "telemetry", "droneId": d.id, "sentAt": sentAt, "scenarioTime": nil, "scenarioSpeed": 1,
		"pose":     map[string]any{"lat": 20.9, "lng": -156.6, "altM": 70, "headingDeg": 0, "pitchDeg": -60},
		"camera":   map[string]any{"widthPx": 640, "heightPx": 480, "hfovDeg": 90},
		"velocity": map[string]any{"eastMps": 0, "northMps": 0, "upMps": 0}, "batteryPct": battery, "mode": "patrol",
	})
}

func (d *fakeDrone) status(runID, phase string, coverage float64) {
	d.send(edgeproto.MissionStatus{Type: edgeproto.TypeMissionStatus, DroneID: d.id, RunID: runID, Phase: phase, Coverage: coverage})
}

func (d *fakeDrone) swarm(runID string, payload string) {
	d.send(edgeproto.SwarmEnvelope{Type: edgeproto.TypeSwarm, RunID: runID, From: "spoofed", Payload: json.RawMessage(payload)})
}

func mission(runID string) edgeproto.MappingMission {
	return edgeproto.MappingMission{
		RunID: runID, ZoneID: "zone-1", EdgeServer: edgeproto.LatLng{Lat: 20.9, Lng: -156.6},
		ConnectivityRadiusM: 100, CellSizeM: 10, Altitude: edgeproto.AltitudeBand{MinM: 60, MaxM: 120},
	}
}

func (h *harness) task(key string, task edgeproto.ConnectorTask) (int, []byte) {
	h.t.Helper()
	b, _ := json.Marshal(task)
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+edgeproto.TaskPath, bytes.NewReader(b))
	edgeproto.SetKey(req.Header, key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

func (h *harness) start(runID string) (int, []byte) {
	m := mission(runID)
	return h.task(testKey, edgeproto.ConnectorTask{Kind: edgeproto.KindStartMapping, Mission: &m})
}

// waitFor polls until the connector has taken in what a drone sent; drone messages are async.
func (h *harness) waitFor(what string, cond func(*Connector) bool) {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.c.mu.Lock()
		ok := cond(h.c)
		h.c.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s", what)
}

func TestRunFansOutAndRelaysSwarm(t *testing.T) {
	h := newHarness(t)
	a, b := h.drone("a"), h.drone("b")

	status, body := h.start("run-1")
	if status != http.StatusOK {
		t.Fatalf("start: %d %s", status, body)
	}
	var res edgeproto.ConnectorTaskResult
	json.Unmarshal(body, &res)
	if !slices.Equal(res.Drones, []string{"a", "b"}) {
		t.Fatalf("swarm %v", res.Drones)
	}
	for _, d := range []*fakeDrone{a, b} {
		m := d.next()
		mission := m["mission"].(map[string]any)
		if m["type"] != "start_mapping" || mission["runId"] != "run-1" || len(mission["swarm"].([]any)) != 2 {
			t.Fatalf("%s got %v", d.id, m)
		}
	}

	if b, _ := json.Marshal(h.tick()); !strings.Contains(string(b), `"newCells":[]`) {
		t.Fatalf("an empty newCells must be [] on the wire: %s", b)
	}

	a.swarm("run-1", `{"kind":"coverage","cells":[1,2,2,-4,999999],"topM":[null,null,null,null,null]}`)
	got := b.next()
	if got["type"] != "swarm" || got["from"] != "a" {
		t.Fatalf("b got %v", got)
	}
	b.swarm("run-1", `{"kind":"coverage","cells":[2,3],"topM":[null,null]}`)
	if got := a.next(); got["from"] != "b" {
		t.Fatalf("a got %v (its own message echoed?)", got)
	}
	a.swarm("other-run", `{"kind":"coverage","cells":[7],"topM":[null]}`)
	h.waitFor("b's coverage", func(c *Connector) bool { return len(c.run.newCells) == 3 })

	u := h.tick()
	if u.Run == nil || u.Run.State != edgeproto.RunMapping || !slices.Equal(u.Run.NewCells, []int{1, 2, 3}) {
		t.Fatalf("run %+v", u.Run)
	}
	if u = h.tick(); len(u.Run.NewCells) != 0 {
		t.Fatalf("cells sent twice: %v", u.Run.NewCells)
	}

	status, _ = h.task(testKey, edgeproto.ConnectorTask{Kind: edgeproto.KindStopMapping, RunID: "run-1"})
	if status != http.StatusOK {
		t.Fatalf("stop: %d", status)
	}
	for _, d := range []*fakeDrone{a, b} {
		if m := d.next(); m["type"] != "stop_mapping" || m["runId"] != "run-1" {
			t.Fatalf("%s got %v", d.id, m)
		}
	}
}

func TestUpdateDedupesAndKeepsDetectionsUntilTaken(t *testing.T) {
	h := newHarness(t)
	a := h.drone("a")
	a.telemetry("2026-10-03T10:00:01.000Z", 90)
	a.telemetry("2026-10-03T10:00:01.000Z", 50)
	a.telemetry("2026-10-03T10:00:00.000Z", 40)
	frame := map[string]any{"type": "detections", "droneId": "a", "frameId": 7, "capturedAt": "2026-10-03T10:00:00.500Z", "detections": []any{}}
	a.send(frame)
	a.send(frame)
	a.send(map[string]any{"type": "telemetry", "droneId": "b", "sentAt": "2026-10-03T10:00:09.000Z"})
	a.telemetry("2026-10-03T10:00:02.000Z", 80)
	h.waitFor("latest telemetry", func(c *Connector) bool {
		return c.drones["a"].telemetryAt.Equal(time.Date(2026, 10, 3, 10, 0, 2, 0, time.UTC))
	})

	h.up.fail = true
	h.c.Tick(context.Background(), h.up)
	h.up.fail = false
	u := h.tick()
	if u.Seq != 1 {
		t.Fatalf("seq %d after one taken update", u.Seq)
	}
	if len(u.Detections) != 1 {
		t.Fatalf("want the frame once, kept across the failed send; got %d", len(u.Detections))
	}
	var tel struct {
		BatteryPct float64 `json:"batteryPct"`
	}
	json.Unmarshal(u.Drones[0].Telemetry, &tel)
	var hello edgeproto.DroneHello
	json.Unmarshal(u.Drones[0].Hello, &hello)
	if len(u.Drones) != 1 || !u.Drones[0].Connected || tel.BatteryPct != 80 || hello.Name != "Drone a" {
		t.Fatalf("drones %+v battery %v", u.Drones, tel.BatteryPct)
	}
	if u = h.tick(); len(u.Detections) != 0 || u.Seq != 2 {
		t.Fatalf("seq %d, detections %d after ack", u.Seq, len(u.Detections))
	}

	var battery float64
	h.store.db.QueryRow(`SELECT battery_pct FROM drones WHERE drone_id = 'a'`).Scan(&battery)
	if battery != 80 {
		t.Fatalf("stored battery %v", battery)
	}
}

func TestHealthIsStoredAtMostOnceASecond(t *testing.T) {
	h := newHarness(t)
	a := h.drone("a")
	stored := func() float64 {
		var battery float64
		h.store.db.QueryRow(`SELECT battery_pct FROM drones WHERE drone_id = 'a'`).Scan(&battery)
		return battery
	}
	report := func(sentAt string, battery float64) {
		a.telemetry(sentAt, battery)
		at, _ := time.Parse(time.RFC3339, sentAt)
		h.waitFor("telemetry "+sentAt, func(c *Connector) bool { return c.drones["a"].telemetryAt.Equal(at) })
	}

	report("2026-10-03T10:00:01Z", 90)
	h.tick()
	report("2026-10-03T10:00:02Z", 70)
	var tel struct {
		BatteryPct float64 `json:"batteryPct"`
	}
	json.Unmarshal(h.tick().Drones[0].Telemetry, &tel)
	if tel.BatteryPct != 70 || stored() != 90 {
		t.Fatalf("within the second: sent %v, stored %v; want 70 sent, 90 stored", tel.BatteryPct, stored())
	}

	h.c.mu.Lock()
	h.c.agg.healthAt = h.c.agg.healthAt.Add(-healthEvery)
	h.c.mu.Unlock()
	h.tick()
	if stored() != 70 {
		t.Fatalf("after a second: stored %v, want 70", stored())
	}
}

func TestTaskRefusals(t *testing.T) {
	h := newHarness(t)
	if status, body := h.start("run-1"); status != http.StatusConflict || !strings.Contains(string(body), "no drones") {
		t.Fatalf("start without drones: %d %s", status, body)
	}
	h.drone("a")
	m := mission("run-1")
	if status, _ := h.task("wrong", edgeproto.ConnectorTask{Kind: edgeproto.KindStartMapping, Mission: &m}); status != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", status)
	}
	m.CellSizeM = 0
	if status, _ := h.task(testKey, edgeproto.ConnectorTask{Kind: edgeproto.KindStartMapping, Mission: &m}); status != http.StatusBadRequest {
		t.Fatalf("bad mission: %d", status)
	}
	if status, _ := h.start("run-1"); status != http.StatusOK {
		t.Fatalf("start: %d", status)
	}
	if status, _ := h.start("run-1"); status != http.StatusOK {
		t.Fatalf("repeat start of the same run: %d", status)
	}
	if status, _ := h.start("run-2"); status != http.StatusConflict {
		t.Fatalf("second run while one is active: %d", status)
	}
	if status, _ := h.task(testKey, edgeproto.ConnectorTask{Kind: edgeproto.KindStopMapping, RunID: "nope"}); status != http.StatusNotFound {
		t.Fatalf("stop of an unknown run: %d", status)
	}
}

func TestRunEndsWhenEveryDroneLandedOrWentSilent(t *testing.T) {
	h := newHarness(t)
	a, b := h.drone("a"), h.drone("b")
	h.start("run-1")
	a.next()
	b.next()
	a.status("run-1", "landed", 0.97)
	b.status("run-1", "mapping", 0.5)
	h.waitFor("statuses", func(c *Connector) bool { return c.drones["b"].phase == "mapping" && c.drones["a"].phase == "landed" })
	if u := h.tick(); u.Run.State != edgeproto.RunMapping || u.Run.Coverage != 0.97 {
		t.Fatalf("run %+v", u.Run)
	}

	h.c.mu.Lock()
	h.c.run.since = h.c.run.since.Add(-lostAfter - time.Second)
	h.c.drones["b"].statusAt = h.c.drones["b"].statusAt.Add(-lostAfter - time.Second)
	h.c.mu.Unlock()
	if u := h.tick(); u.Run.State != edgeproto.RunDone {
		t.Fatalf("b silent past lostAfter, run %s", u.Run.State)
	}
	if active, err := h.store.ActiveRun(context.Background()); err != nil || active != nil {
		t.Fatalf("stored active run %+v, %v", active, err)
	}
	if status, _ := h.start("run-2"); status != http.StatusOK {
		t.Fatalf("start after done: %d", status)
	}
}

func TestDroneRejoiningMidRunGetsItsRunBack(t *testing.T) {
	h := newHarness(t)
	a := h.drone("a")
	h.start("run-1")
	a.next()
	a.status("run-1", "mapping", 0.1)
	h.waitFor("status", func(c *Connector) bool { return c.drones["a"].phase == "mapping" })
	a.conn.Close(websocket.StatusNormalClosure, "")
	h.waitFor("disconnect", func(c *Connector) bool { return c.sessions["a"] == nil })

	again := h.drone("a")
	if m := again.next(); m["type"] != "start_mapping" {
		t.Fatalf("got %v", m)
	}
}

func TestRestartResumesRunWithoutRestartingDrones(t *testing.T) {
	h := newHarness(t)
	a := h.drone("a")
	h.start("run-1")
	a.next()

	c, err := New(context.Background(), "edge-1", "http://edge-1:8070", h.store, h.c.log)
	if err != nil {
		t.Fatal(err)
	}
	if c.run == nil || c.run.mission.RunID != "run-1" || !slices.Equal(c.run.mission.Swarm, []string{"a"}) {
		t.Fatalf("resumed run %+v", c.run)
	}
	if d, ok := c.drones["a"]; !ok || !strings.Contains(string(d.hello), `"name":"Drone a"`) {
		t.Fatal("paired drone and its hello not loaded")
	}
}

func TestIdentity(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "edge.db")
	s, err := OpenStore(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.Identity(ctx, "")
	if err != nil || !strings.HasPrefix(first, "edge-") {
		t.Fatalf("%q %v", first, err)
	}
	s.Close()
	s, _ = OpenStore(ctx, path)
	defer s.Close()
	if again, _ := s.Identity(ctx, ""); again != first {
		t.Fatalf("token changed across boots: %q then %q", first, again)
	}
	if given, _ := s.Identity(ctx, "issued-token"); given != "issued-token" {
		t.Fatalf("configured token ignored: %q", given)
	}
	if kept, _ := s.Identity(ctx, ""); kept != "issued-token" {
		t.Fatalf("configured token not kept: %q", kept)
	}
}

func TestPublicURL(t *testing.T) {
	cases := []struct{ configured, listen, manager, want string }{
		{"http://edge.local:9000/", ":8070", "http://m:8060", "http://edge.local:9000"},
		{"", "192.168.1.20:8070", "http://m:8060", "http://192.168.1.20:8070"},
		{"", ":8070", "http://127.0.0.1:8060", "http://127.0.0.1:8070"},
	}
	for _, c := range cases {
		got, err := PublicURL(c.configured, c.listen, c.manager)
		if err != nil || got != c.want {
			t.Errorf("PublicURL(%q, %q, %q) = %q, %v; want %q", c.configured, c.listen, c.manager, got, err, c.want)
		}
	}
	if _, err := PublicURL("ftp://x", ":8070", "http://m"); err == nil {
		t.Error("want error for a non-http public url")
	}
}

func TestAdvertisedRecords(t *testing.T) {
	want := []string{"id=edge-1", "path=" + edgeproto.DroneLinkPath}
	if got := AdvertisedTXT("edge-1"); !slices.Equal(got, want) {
		t.Errorf("AdvertisedTXT = %q; want %q", got, want)
	}
	for addr, want := range map[string]int{":8070": 8070, "192.168.1.20:9000": 9000} {
		if got, err := listenPort(addr); err != nil || got != want {
			t.Errorf("listenPort(%q) = %d, %v; want %d", addr, got, err, want)
		}
	}
	for _, addr := range []string{":0", "8070", ":http"} {
		if _, err := listenPort(addr); err == nil {
			t.Errorf("listenPort(%q): want error", addr)
		}
	}
}
