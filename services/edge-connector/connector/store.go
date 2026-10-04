package connector

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"ember/internal/edgeproto"

	_ "modernc.org/sqlite"
)

// Store is the connector's own SQLite file: its identity, the drones paired with it and their last
// health, and its runs. Nothing outside this edge server reads it.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drones (
	drone_id    TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	kind        TEXT NOT NULL,
	hello       TEXT NOT NULL,
	paired_at   TEXT NOT NULL,
	last_seen   TEXT NOT NULL,
	connected   INTEGER NOT NULL DEFAULT 0,
	battery_pct REAL,
	mode        TEXT,
	phase       TEXT,
	lat         REAL,
	lng         REAL,
	alt_m       REAL
);
CREATE TABLE IF NOT EXISTS runs (
	run_id     TEXT PRIMARY KEY,
	mission    TEXT NOT NULL,
	state      TEXT NOT NULL,
	started_at TEXT NOT NULL,
	ended_at   TEXT
);`

// OpenStore opens or creates the file. Every drone starts disconnected: a drone is connected only
// while its socket to this process is open.
func OpenStore(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("store %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("store %s: schema: %w", path, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE drones SET connected = 0`); err != nil {
		db.Close()
		return nil, fmt.Errorf("store %s: %w", path, err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Identity is the connector's token. A configured token wins and is kept; otherwise the token from
// an earlier boot, or a new random one on the first.
func (s *Store) Identity(ctx context.Context, configured string) (string, error) {
	if configured != "" {
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO meta (key, value) VALUES ('edge_server_id', ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`, configured)
		if err != nil {
			return "", fmt.Errorf("store identity: %w", err)
		}
		return configured, nil
	}
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'edge_server_id'`).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("store identity: %w", err)
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("store identity: %w", err)
	}
	id = "edge-" + hex.EncodeToString(b)
	if _, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES ('edge_server_id', ?)`, id); err != nil {
		return "", fmt.Errorf("store identity: %w", err)
	}
	return id, nil
}

// PairDrone records a drone's hello and marks it connected.
func (s *Store) PairDrone(ctx context.Context, h edgeproto.DroneHello, raw []byte, now time.Time) error {
	ts := edgeproto.Stamp(now)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO drones (drone_id, name, kind, hello, paired_at, last_seen, connected)
		 VALUES (?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT (drone_id) DO UPDATE SET
		   name = excluded.name, kind = excluded.kind, hello = excluded.hello,
		   last_seen = excluded.last_seen, connected = 1`,
		h.DroneID, h.Name, h.Kind, string(raw), ts, ts)
	if err != nil {
		return fmt.Errorf("store drone %s: %w", h.DroneID, err)
	}
	return nil
}

// Disconnected marks a drone's socket closed.
func (s *Store) Disconnected(ctx context.Context, droneID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE drones SET connected = 0, last_seen = ? WHERE drone_id = ?`, edgeproto.Stamp(now), droneID)
	if err != nil {
		return fmt.Errorf("store drone %s: %w", droneID, err)
	}
	return nil
}

// health is one drone's latest state as its telemetry and mission status report it.
type health struct {
	droneID    string
	lastSeen   time.Time
	batteryPct float64
	mode       string
	phase      string
	lat, lng   float64
	altM       float64
}

// SaveHealth writes the drones that reported since the last save, in one transaction.
func (s *Store) SaveHealth(ctx context.Context, rows []health) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store health: %w", err)
	}
	defer tx.Rollback()
	for _, h := range rows {
		_, err := tx.ExecContext(ctx,
			`UPDATE drones SET last_seen = ?, battery_pct = ?, mode = ?, phase = NULLIF(?, ''),
			   lat = ?, lng = ?, alt_m = ?
			 WHERE drone_id = ?`,
			edgeproto.Stamp(h.lastSeen), h.batteryPct, h.mode, h.phase, h.lat, h.lng, h.altM, h.droneID)
		if err != nil {
			return fmt.Errorf("store health %s: %w", h.droneID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store health: %w", err)
	}
	return nil
}

// pairedDrone is a drone known from an earlier boot.
type pairedDrone struct {
	id       string
	hello    json.RawMessage
	lastSeen time.Time
}

func (s *Store) Drones(ctx context.Context) ([]pairedDrone, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT drone_id, hello, last_seen FROM drones ORDER BY drone_id`)
	if err != nil {
		return nil, fmt.Errorf("store drones: %w", err)
	}
	defer rows.Close()
	var out []pairedDrone
	for rows.Next() {
		var d pairedDrone
		var hello, seen string
		if err := rows.Scan(&d.id, &hello, &seen); err != nil {
			return nil, fmt.Errorf("store drones: %w", err)
		}
		d.hello = json.RawMessage(hello)
		d.lastSeen, _ = time.Parse(time.RFC3339Nano, seen)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store drones: %w", err)
	}
	return out, nil
}

// storedRun is a run as the store keeps it; the mission includes the swarm it was sent with.
type storedRun struct {
	mission   edgeproto.MappingMission
	state     string
	startedAt time.Time
	endedAt   time.Time
}

func (s *Store) SaveRun(ctx context.Context, r storedRun) error {
	mission, err := json.Marshal(r.mission)
	if err != nil {
		return fmt.Errorf("store run %s: %w", r.mission.RunID, err)
	}
	var ended any
	if !r.endedAt.IsZero() {
		ended = edgeproto.Stamp(r.endedAt)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO runs (run_id, mission, state, started_at, ended_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, ended_at = excluded.ended_at`,
		r.mission.RunID, string(mission), r.state, edgeproto.Stamp(r.startedAt), ended)
	if err != nil {
		return fmt.Errorf("store run %s: %w", r.mission.RunID, err)
	}
	return nil
}

// ActiveRun is the run a restart interrupted, if any.
func (s *Store) ActiveRun(ctx context.Context) (*storedRun, error) {
	var mission, state, started string
	err := s.db.QueryRowContext(ctx,
		`SELECT mission, state, started_at FROM runs WHERE state != ? ORDER BY started_at DESC LIMIT 1`,
		edgeproto.RunDone).Scan(&mission, &state, &started)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store active run: %w", err)
	}
	r := &storedRun{state: state}
	if err := json.Unmarshal([]byte(mission), &r.mission); err != nil {
		return nil, fmt.Errorf("store active run: %w", err)
	}
	if r.startedAt, err = time.Parse(time.RFC3339Nano, started); err != nil {
		return nil, fmt.Errorf("store active run: started_at: %w", err)
	}
	return r, nil
}
