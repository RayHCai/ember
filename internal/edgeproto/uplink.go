package edgeproto

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"
)

// Uplink message types: connector -> manager on UplinkPath, and the manager's answer.
const (
	TypeRegister   = "register"
	TypeRegistered = "registered"
	TypeUpdate     = "update"
)

// EdgeRegister mirrors EdgeRegister: the connector's first frame on every (re)connect.
type EdgeRegister struct {
	Type         string `json:"type"`
	EdgeServerID string `json:"edgeServerId"`
	URL          string `json:"url"`
}

// Validate checks a registration as the manager receives it.
func (r EdgeRegister) Validate() error {
	if r.EdgeServerID == "" {
		return errMissing("register", "edgeServerId")
	}
	return checkHTTPURL(r.URL)
}

// EdgeRegistered mirrors EdgeRegistered.
type EdgeRegistered struct {
	Type       string `json:"type"`
	ServerTime string `json:"serverTime"`
}

// EdgeDrone mirrors EdgeDrone. Hello, Telemetry and Status are the drone's own messages, kept
// verbatim.
type EdgeDrone struct {
	DroneID   string          `json:"droneId"`
	Hello     json.RawMessage `json:"hello"`
	Connected bool            `json:"connected"`
	LastSeen  string          `json:"lastSeen"`
	Telemetry json.RawMessage `json:"telemetry"`
	Status    json.RawMessage `json:"status"`
}

// Run states mirror EdgeRunState.
const (
	RunMapping  = "mapping"
	RunStopping = "stopping"
	RunDone     = "done"
)

// EdgeRun mirrors EdgeRun.
type EdgeRun struct {
	RunID               string   `json:"runId"`
	ZoneID              string   `json:"zoneId"`
	State               string   `json:"state"`
	StartedAt           string   `json:"startedAt"`
	Swarm               []string `json:"swarm"`
	EdgeServer          LatLng   `json:"edgeServer"`
	ConnectivityRadiusM float64  `json:"connectivityRadiusM"`
	CellSizeM           float64  `json:"cellSizeM"`
	Coverage            float64  `json:"coverage"`
	NewCells            []int    `json:"newCells"`
}

// EdgeUpdate mirrors EdgeUpdate; detections are the drones' messages, kept verbatim.
type EdgeUpdate struct {
	Type         string            `json:"type"`
	EdgeServerID string            `json:"edgeServerId"`
	Seq          int64             `json:"seq"`
	SentAt       string            `json:"sentAt"`
	Drones       []EdgeDrone       `json:"drones"`
	Run          *EdgeRun          `json:"run"`
	Detections   []json.RawMessage `json:"detections"`
}

// EdgeRunRef is the run as the registry lists it.
type EdgeRunRef struct {
	RunID string `json:"runId"`
	State string `json:"state"`
}

// EdgeServerStatus mirrors EdgeServerStatus.
type EdgeServerStatus struct {
	EdgeServerID    string      `json:"edgeServerId"`
	URL             string      `json:"url"`
	Online          bool        `json:"online"`
	ConnectedAt     string      `json:"connectedAt"`
	LastSeen        string      `json:"lastSeen"`
	Drones          int         `json:"drones"`
	ConnectedDrones int         `json:"connectedDrones"`
	Run             *EdgeRunRef `json:"run"`
}

// Stamp formats a time as the edge wire does: UTC, milliseconds, Z.
func Stamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// SetKey adds the shared edge key to an outgoing request; an empty key adds nothing.
func SetKey(h http.Header, key string) {
	if key != "" {
		h.Set("Authorization", "Bearer "+key)
	}
}

// HasKey reports whether a request carries the shared edge key; an empty key accepts anything.
func HasKey(r *http.Request, key string) bool {
	if key == "" {
		return true
	}
	got := r.Header.Get("Authorization")
	return subtle.ConstantTimeCompare([]byte(got), []byte("Bearer "+key)) == 1
}
