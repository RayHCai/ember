package edgeproto

import (
	"encoding/json"
	"fmt"
)

// DroneLinkPath mirrors DRONE_LINK_PATH in @ember/contracts (droneLink.ts).
const DroneLinkPath = "/v1/drone"

// LatLng mirrors LatLng in @ember/contracts.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// CameraSpec mirrors CameraSpec in @ember/contracts.
type CameraSpec struct {
	WidthPx  int     `json:"widthPx"`
	HeightPx int     `json:"heightPx"`
	HfovDeg  float64 `json:"hfovDeg"`
}

// DroneHello is the drone's first message on every connect.
type DroneHello struct {
	Type        string     `json:"type"`
	DroneID     string     `json:"droneId"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	Camera      CameraSpec `json:"camera"`
	Sensors     []string   `json:"sensors"`
	MaxSpeedMps float64    `json:"maxSpeedMps"`
	EnduranceS  float64    `json:"enduranceS"`
}

// EdgeWelcome answers DroneHello.
type EdgeWelcome struct {
	Type         string `json:"type"`
	EdgeServerID string `json:"edgeServerId"`
	ServerTime   string `json:"serverTime"`
}

// AltitudeBand is the flight band above the ground.
type AltitudeBand struct {
	MinM float64 `json:"minM"`
	MaxM float64 `json:"maxM"`
}

// MappingMission mirrors MappingMission; see droneLink.ts for the mission frame and grid.
type MappingMission struct {
	RunID               string       `json:"runId"`
	ZoneID              string       `json:"zoneId"`
	EdgeServer          LatLng       `json:"edgeServer"`
	ConnectivityRadiusM float64      `json:"connectivityRadiusM"`
	Boundary            []LatLng     `json:"boundary"`
	CellSizeM           float64      `json:"cellSizeM"`
	Altitude            AltitudeBand `json:"altitude"`
	Swarm               []string     `json:"swarm,omitempty"`
}

// StartMapping sends a drone on a run.
type StartMapping struct {
	Type    string         `json:"type"`
	Mission MappingMission `json:"mission"`
}

// StopMapping ends a run; drones return to their takeoff point and land.
type StopMapping struct {
	Type  string `json:"type"`
	RunID string `json:"runId"`
}

// SwarmEnvelope is relayed by the connector to the other drones of the run with From set to the
// sender. The payload is opaque to the connector.
type SwarmEnvelope struct {
	Type    string          `json:"type"`
	RunID   string          `json:"runId"`
	From    string          `json:"from"`
	Payload json.RawMessage `json:"payload"`
}

// MissionStatus is a drone's progress report during a run.
type MissionStatus struct {
	Type       string  `json:"type"`
	DroneID    string  `json:"droneId"`
	RunID      string  `json:"runId"`
	Phase      string  `json:"phase"`
	Coverage   float64 `json:"coverage"`
	Detections int     `json:"detections"`
}

// Uplink message types; telemetry and detections are forwarded up without decoding.
const (
	TypeHello         = "hello"
	TypeTelemetry     = "telemetry"
	TypeDetections    = "detections"
	TypeMissionStatus = "mission_status"
	TypeSwarm         = "swarm"
	TypeWelcome       = "welcome"
	TypeStartMapping  = "start_mapping"
	TypeStopMapping   = "stop_mapping"
)

// LinkType reads the type of one edge link message.
func LinkType(raw []byte) (string, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return "", fmt.Errorf("edge link message: %w", err)
	}
	if head.Type == "" {
		return "", fmt.Errorf("edge link message: missing type")
	}
	return head.Type, nil
}

// DroneInfoIngestPath mirrors DRONE_INFO_INGEST_PATH: edge-manager posts DroneInfoIngest there.
const DroneInfoIngestPath = "/v1/ingest"

// DroneInfoIngest mirrors DroneInfoIngest: hello, telemetry and detections messages, unchanged.
type DroneInfoIngest struct {
	Messages []json.RawMessage `json:"messages"`
}

// DroneInfoIngestResult mirrors DroneInfoIngestResult.
type DroneInfoIngestResult struct {
	Accepted int      `json:"accepted"`
	Rejected int      `json:"rejected"`
	Errors   []string `json:"errors"`
}
