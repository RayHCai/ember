package edgeproto

import "encoding/json"

// Paths mirror API_EDGE_SERVERS_PATH, DRONES_PATH, MAPPING_RUNS_PATH and DETECTIONS_PATH in
// api.ts of @ember/contracts: edge-manager records what connectors report at the api.
const (
	APIEdgeServersPath = "/v1/edge-servers"
	APIDronesPath      = "/v1/drones"
	APIMappingRunsPath = "/v1/mapping-runs"
	APIDetectionsPath  = "/v1/detections"
)

// PutEdgeServerRequest mirrors PutEdgeServerRequest, which edge-manager sends as a registration:
// the URL alone, so what an operator set on the edge server stays.
type PutEdgeServerRequest struct {
	URL string `json:"url"`
}

// PutDroneRequest mirrors PutDroneRequest; an omitted Name or Kind keeps the api's value.
type PutDroneRequest struct {
	EdgeServerID *string `json:"edgeServerId"`
	Name         *string `json:"name,omitempty"`
	Kind         *string `json:"kind,omitempty"`
}

// DetectionsIngest mirrors DetectionsIngest: detections frames from the drones, unchanged.
type DetectionsIngest struct {
	EdgeServerID string            `json:"edgeServerId"`
	Frames       []json.RawMessage `json:"frames"`
}

// DetectionsIngestResult mirrors DetectionsIngestResult.
type DetectionsIngestResult struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
}
