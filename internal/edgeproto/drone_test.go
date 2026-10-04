package edgeproto

import (
	"encoding/json"
	"testing"
)

func TestStartMappingWireNames(t *testing.T) {
	msg := StartMapping{Type: TypeStartMapping, Mission: MappingMission{
		RunID: "r", ZoneID: "z", EdgeServer: LatLng{Lat: 1, Lng: 2}, ConnectivityRadiusM: 500,
		CellSizeM: 10, Altitude: AltitudeBand{MinM: 60, MaxM: 120}, Swarm: []string{"a"},
	}}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"start_mapping","mission":{"runId":"r","zoneId":"z","edgeServer":{"lat":1,"lng":2},` +
		`"connectivityRadiusM":500,"boundary":null,"cellSizeM":10,"altitude":{"minM":60,"maxM":120},"swarm":["a"]}}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

func TestSwarmEnvelopeKeepsPayload(t *testing.T) {
	in := `{"type":"swarm","runId":"r","from":"x","payload":{"kind":"coverage","cells":[1,2],"topM":[null,3]}}`
	var env SwarmEnvelope
	if err := json.Unmarshal([]byte(in), &env); err != nil {
		t.Fatal(err)
	}
	env.From = "drone-2"
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"swarm","runId":"r","from":"drone-2","payload":{"kind":"coverage","cells":[1,2],"topM":[null,3]}}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}

func TestLinkType(t *testing.T) {
	if got, err := LinkType([]byte(`{"type":"telemetry","droneId":"d"}`)); err != nil || got != TypeTelemetry {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := LinkType([]byte(`{"droneId":"d"}`)); err == nil {
		t.Fatal("want error for missing type")
	}
}

func TestDroneInfoIngestWireNames(t *testing.T) {
	b, err := json.Marshal(DroneInfoIngest{Messages: []json.RawMessage{json.RawMessage(`{"type":"hello"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"messages":[{"type":"hello"}]}`; string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}
