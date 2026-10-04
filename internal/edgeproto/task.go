// Package edgeproto holds the wire shapes shared by edge-manager and edge-connector.
package edgeproto

import (
	"errors"
	"fmt"
	"net/url"
)

// Paths mirror edge.ts in @ember/contracts.
const (
	TaskPath        = "/v1/tasks"
	EdgeServersPath = "/v1/edge-servers"
	UplinkPath      = "/v1/edge"
)

// maxRadiusInCells matches the finest grid drone-runtime accepts.
const maxRadiusInCells = 2000

// TaskKind mirrors EdgeTask.kind in @ember/contracts.
type TaskKind string

const (
	KindStartMapping TaskKind = "start_mapping"
	KindStopMapping  TaskKind = "stop_mapping"
)

// EdgeServerSite mirrors EdgeServerSite; Location and ConnectivityRadiusM are unset in a stop task.
type EdgeServerSite struct {
	EdgeServerID        string  `json:"edgeServerId"`
	URL                 string  `json:"url"`
	Location            *LatLng `json:"location,omitempty"`
	ConnectivityRadiusM float64 `json:"connectivityRadiusM,omitempty"`
}

// EdgeTask mirrors the EdgeTask union: API -> edge-manager.
type EdgeTask struct {
	Kind        TaskKind         `json:"kind"`
	RunID       string           `json:"runId"`
	ZoneID      string           `json:"zoneId"`
	Boundary    []LatLng         `json:"boundary,omitempty"`
	CellSizeM   float64          `json:"cellSizeM,omitempty"`
	Altitude    *AltitudeBand    `json:"altitude,omitempty"`
	EdgeServers []EdgeServerSite `json:"edgeServers"`
}

// Validate checks the task before any connector is called.
func (t EdgeTask) Validate() error {
	if t.RunID == "" || t.ZoneID == "" {
		return errors.New("task: runId and zoneId are required")
	}
	if len(t.EdgeServers) == 0 {
		return errors.New("task: no edgeServers")
	}
	for _, s := range t.EdgeServers {
		if s.EdgeServerID == "" {
			return errors.New("task: edge server without edgeServerId")
		}
		if err := checkHTTPURL(s.URL); err != nil {
			return fmt.Errorf("task: edge server %s: %w", s.EdgeServerID, err)
		}
	}
	switch t.Kind {
	case KindStopMapping:
		return nil
	case KindStartMapping:
		if t.Altitude == nil {
			return errors.New("task: start_mapping needs altitude")
		}
		for _, s := range t.EdgeServers {
			if s.Location == nil {
				return fmt.Errorf("task: edge server %s: start_mapping needs location", s.EdgeServerID)
			}
			if err := t.MissionFor(s).Validate(); err != nil {
				return fmt.Errorf("task: edge server %s: %w", s.EdgeServerID, err)
			}
		}
		return nil
	default:
		return fmt.Errorf("task: unknown kind %q", t.Kind)
	}
}

// ConnectorTaskFor is what one connector of the task receives.
func (t EdgeTask) ConnectorTaskFor(s EdgeServerSite) ConnectorTask {
	if t.Kind == KindStopMapping {
		return ConnectorTask{Kind: KindStopMapping, RunID: t.RunID}
	}
	m := t.MissionFor(s)
	return ConnectorTask{Kind: KindStartMapping, Mission: &m}
}

// MissionFor is the run as one edge server's drones fly it, before the connector adds the swarm.
func (t EdgeTask) MissionFor(s EdgeServerSite) MappingMission {
	m := MappingMission{
		RunID:               t.RunID,
		ZoneID:              t.ZoneID,
		ConnectivityRadiusM: s.ConnectivityRadiusM,
		Boundary:            t.Boundary,
		CellSizeM:           t.CellSizeM,
	}
	if s.Location != nil {
		m.EdgeServer = *s.Location
	}
	if t.Altitude != nil {
		m.Altitude = *t.Altitude
	}
	return m
}

// EdgeServerTaskResult mirrors EdgeServerTaskResult.
type EdgeServerTaskResult struct {
	EdgeServerID string   `json:"edgeServerId"`
	OK           bool     `json:"ok"`
	Drones       []string `json:"drones,omitempty"`
	Error        string   `json:"error,omitempty"`
}

// EdgeTaskResult mirrors EdgeTaskResult.
type EdgeTaskResult struct {
	RunID   string                 `json:"runId"`
	Results []EdgeServerTaskResult `json:"results"`
}

// ConnectorTask mirrors the ConnectorTask union: edge-manager -> one connector. Mission.Swarm is
// ignored on the way in; the connector fills it.
type ConnectorTask struct {
	Kind    TaskKind        `json:"kind"`
	Mission *MappingMission `json:"mission,omitempty"`
	RunID   string          `json:"runId,omitempty"`
}

// Validate checks a task as the connector receives it.
func (t ConnectorTask) Validate() error {
	switch t.Kind {
	case KindStartMapping:
		if t.Mission == nil {
			return errors.New("task: start_mapping needs mission")
		}
		return t.Mission.Validate()
	case KindStopMapping:
		if t.RunID == "" {
			return errors.New("task: stop_mapping needs runId")
		}
		return nil
	default:
		return fmt.Errorf("task: unknown kind %q", t.Kind)
	}
}

// ConnectorTaskResult mirrors ConnectorTaskResult.
type ConnectorTaskResult struct {
	RunID  string   `json:"runId"`
	Drones []string `json:"drones"`
}

// ErrorBody is every edge service's JSON error answer.
type ErrorBody struct {
	Error string `json:"error"`
}

// Validate applies the bounds drone-runtime enforces, so a bad mission fails at the manager rather
// than on every drone.
func (m MappingMission) Validate() error {
	if m.RunID == "" || m.ZoneID == "" {
		return errors.New("mission: runId and zoneId are required")
	}
	if m.ConnectivityRadiusM <= 0 || m.CellSizeM <= 0 || m.Altitude.MinM <= 0 || m.Altitude.MinM > m.Altitude.MaxM {
		return fmt.Errorf("mission: bad geometry (radius %g, cell %g, altitude %g..%g)",
			m.ConnectivityRadiusM, m.CellSizeM, m.Altitude.MinM, m.Altitude.MaxM)
	}
	if m.ConnectivityRadiusM/m.CellSizeM > maxRadiusInCells {
		return fmt.Errorf("mission: %g m radius at %g m cells is too fine a grid", m.ConnectivityRadiusM, m.CellSizeM)
	}
	if m.Boundary != nil && len(m.Boundary) < 3 {
		return errors.New("mission: boundary must be null or at least 3 points")
	}
	return nil
}

func errMissing(msg, field string) error {
	return fmt.Errorf("%s: missing %s", msg, field)
}

func checkHTTPURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("url %q is not an http(s) URL", raw)
	}
	return nil
}
