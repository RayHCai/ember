package edgeproto

import (
	"encoding/json"
	"strings"
	"testing"
)

func startTask() EdgeTask {
	return EdgeTask{
		Kind: KindStartMapping, RunID: "r", ZoneID: "z", CellSizeM: 10,
		Altitude: &AltitudeBand{MinM: 60, MaxM: 120},
		EdgeServers: []EdgeServerSite{
			{EdgeServerID: "e1", URL: "http://10.0.0.5:8070", Location: &LatLng{Lat: 1, Lng: 2}, ConnectivityRadiusM: 500},
		},
	}
}

func TestEdgeTaskFromWire(t *testing.T) {
	in := `{"kind":"start_mapping","runId":"r","zoneId":"z","boundary":null,"cellSizeM":10,` +
		`"altitude":{"minM":60,"maxM":120},"edgeServers":[{"edgeServerId":"e1","url":"http://10.0.0.5:8070",` +
		`"location":{"lat":1,"lng":2},"connectivityRadiusM":500}]}`
	var task EdgeTask
	if err := json.Unmarshal([]byte(in), &task); err != nil {
		t.Fatal(err)
	}
	if err := task.Validate(); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(task.ConnectorTaskFor(task.EdgeServers[0]))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"kind":"start_mapping","mission":{"runId":"r","zoneId":"z","edgeServer":{"lat":1,"lng":2},` +
		`"connectivityRadiusM":500,"boundary":null,"cellSizeM":10,"altitude":{"minM":60,"maxM":120}}}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

func TestStopTaskNeedsOnlyLinks(t *testing.T) {
	in := `{"kind":"stop_mapping","runId":"r","zoneId":"z","edgeServers":[{"edgeServerId":"e1","url":"http://h:1"}]}`
	var task EdgeTask
	if err := json.Unmarshal([]byte(in), &task); err != nil {
		t.Fatal(err)
	}
	if err := task.Validate(); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(task.ConnectorTaskFor(task.EdgeServers[0]))
	if want := `{"kind":"stop_mapping","runId":"r"}`; string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

func TestEdgeTaskValidate(t *testing.T) {
	cases := map[string]func(*EdgeTask){
		"kind":     func(task *EdgeTask) { task.Kind = "fly" },
		"runId":    func(task *EdgeTask) { task.RunID = "" },
		"servers":  func(task *EdgeTask) { task.EdgeServers = nil },
		"url":      func(task *EdgeTask) { task.EdgeServers[0].URL = "ws://h" },
		"location": func(task *EdgeTask) { task.EdgeServers[0].Location = nil },
		"radius":   func(task *EdgeTask) { task.EdgeServers[0].ConnectivityRadiusM = 0 },
		"altitude": func(task *EdgeTask) { task.Altitude = &AltitudeBand{MinM: 100, MaxM: 50} },
		"grid":     func(task *EdgeTask) { task.CellSizeM = 0.1 },
		"boundary": func(task *EdgeTask) { task.Boundary = []LatLng{{}, {}} },
	}
	for name, breakIt := range cases {
		task := startTask()
		breakIt(&task)
		if err := task.Validate(); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if err := startTask().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestEdgeUpdateWireNames(t *testing.T) {
	u := EdgeUpdate{
		Type: TypeUpdate, EdgeServerID: "e1", Seq: 3, SentAt: "t",
		Drones:     []EdgeDrone{{DroneID: "d", Hello: json.RawMessage(`{"type":"hello"}`), Connected: true, LastSeen: "t"}},
		Detections: []json.RawMessage{json.RawMessage(`{"type":"detections","frameId":1}`)},
	}
	b, err := json.Marshal(u)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"update","edgeServerId":"e1","seq":3,"sentAt":"t","drones":[{"droneId":"d","hello":{"type":"hello"},` +
		`"connected":true,"lastSeen":"t","telemetry":null,"status":null}],"run":null,` +
		`"detections":[{"type":"detections","frameId":1}]}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

func TestRegisterValidate(t *testing.T) {
	if err := (EdgeRegister{EdgeServerID: "e", URL: "http://10.0.0.5:8070"}).Validate(); err != nil {
		t.Fatal(err)
	}
	err := (EdgeRegister{URL: "http://h"}).Validate()
	if err == nil || !strings.Contains(err.Error(), "edgeServerId") {
		t.Fatalf("got %v", err)
	}
}
