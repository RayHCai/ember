// Package edgeproto holds the wire shapes shared by edge-manager and edge-connector.
package edgeproto

// TaskKind mirrors EdgeTask.kind in @ember/contracts.
type TaskKind string

const (
	StartMapping TaskKind = "start_mapping"
	StopMapping  TaskKind = "stop_mapping"
)

// Task is sent API -> edge-manager -> each edge-connector.
type Task struct {
	ZoneID         string   `json:"zoneId"`
	Kind           TaskKind `json:"kind"`
	EdgeServerURLs []string `json:"edgeServerUrls"`
}
