package edgeproto

import (
	"encoding/json"
	"testing"
)

func TestAPIRequestWireNames(t *testing.T) {
	edge := "e1"
	name := "scout"
	cases := []struct {
		got  any
		want string
	}{
		{PutEdgeServerRequest{URL: "http://h:1"}, `{"url":"http://h:1"}`},
		{PutDroneRequest{EdgeServerID: &edge}, `{"edgeServerId":"e1"}`},
		{PutDroneRequest{EdgeServerID: &edge, Name: &name}, `{"edgeServerId":"e1","name":"scout"}`},
		{PutDroneRequest{}, `{"edgeServerId":null}`},
		{
			DetectionsIngest{EdgeServerID: "e1", Frames: []json.RawMessage{json.RawMessage(`{"frameId":1}`)}},
			`{"edgeServerId":"e1","frames":[{"frameId":1}]}`,
		},
	}
	for _, c := range cases {
		b, err := json.Marshal(c.got)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != c.want {
			t.Fatalf("got %s want %s", b, c.want)
		}
	}
}
