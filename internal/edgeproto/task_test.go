package edgeproto

import (
	"encoding/json"
	"testing"
)

func TestTaskWireNames(t *testing.T) {
	b, err := json.Marshal(Task{ZoneID: "z", Kind: StartMapping})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"zoneId":"z","kind":"start_mapping","edgeServerUrls":null}`
	if string(b) != want {
		t.Fatalf("got %s want %s", b, want)
	}
}
