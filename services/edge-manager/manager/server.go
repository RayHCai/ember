package manager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"ember/internal/edgehttp"
	"ember/internal/edgeproto"
)

const (
	registerTimeout = 10 * time.Second
	// clientTimeout backstops the per-request timeouts of the task and ingest calls.
	clientTimeout = 15 * time.Second
	// uplinkReadLimit fits a connector update carrying its maximum of detections frames.
	uplinkReadLimit = 8 << 20
)

// Manager serves the API (tasks, registry) and the connectors' uplinks.
type Manager struct {
	Registry  *Registry
	Forwarder *Forwarder
	key       string
	client    *http.Client
	log       *slog.Logger
	links     sync.WaitGroup
}

// New builds a manager; key is the shared edge key, droneInfoURL where updates go ("" for nowhere).
func New(key, droneInfoURL string, log *slog.Logger) *Manager {
	client := &http.Client{Timeout: clientTimeout}
	return &Manager{
		Registry:  NewRegistry(),
		Forwarder: NewForwarder(droneInfoURL, client, log),
		key:       key,
		client:    client,
		log:       log,
	}
}

// Wait returns once every connector uplink has closed.
func (m *Manager) Wait() { m.links.Wait() }

func (m *Manager) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		edgehttp.WriteJSON(w, http.StatusOK, map[string]any{"service": "edge-manager", "ok": true})
	})
	mux.HandleFunc("POST "+edgeproto.TaskPath, m.keyed(m.serveTask))
	mux.HandleFunc("GET "+edgeproto.EdgeServersPath, m.keyed(func(w http.ResponseWriter, _ *http.Request) {
		edgehttp.WriteJSON(w, http.StatusOK, m.Registry.List())
	}))
	mux.HandleFunc("GET "+edgeproto.UplinkPath, m.keyed(m.serveUplink))
	return mux
}

func (m *Manager) keyed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !edgeproto.HasKey(r, m.key) {
			edgehttp.WriteJSON(w, http.StatusUnauthorized, edgeproto.ErrorBody{Error: "missing or wrong edge key"})
			return
		}
		h(w, r)
	}
}

func (m *Manager) serveTask(w http.ResponseWriter, r *http.Request) {
	var task edgeproto.EdgeTask
	if err := edgehttp.ReadJSON(w, r, &task); err != nil {
		edgehttp.WriteJSON(w, http.StatusBadRequest, edgeproto.ErrorBody{Error: fmt.Sprintf("task: %v", err)})
		return
	}
	if err := task.Validate(); err != nil {
		edgehttp.WriteJSON(w, http.StatusBadRequest, edgeproto.ErrorBody{Error: err.Error()})
		return
	}
	for _, s := range task.EdgeServers {
		if !m.Registry.Online(s.EdgeServerID) {
			m.log.Warn("task for an edge server that is not registered", "edgeServer", s.EdgeServerID, "url", s.URL)
		}
	}
	res := m.fanOut(r.Context(), task)
	m.log.Info("task fanned out", "kind", task.Kind, "run", task.RunID, "zone", task.ZoneID, "edgeServers", len(task.EdgeServers))
	edgehttp.WriteJSON(w, http.StatusOK, res)
}

// serveUplink runs one connector's socket: register, then updates until it closes or the same
// connector registers on a newer socket.
func (m *Manager) serveUplink(w http.ResponseWriter, r *http.Request) {
	m.links.Add(1)
	defer m.links.Done()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(uplinkReadLimit)

	reg, err := readRegister(r.Context(), conn)
	if err != nil {
		m.log.Warn("connector refused", "remote", r.RemoteAddr, "err", err)
		conn.Close(websocket.StatusPolicyViolation, "bad register")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	link := &uplinkSocket{kick: cancel}
	m.Registry.online(reg, link)
	defer m.Registry.offline(reg.EdgeServerID, link)

	wctx, wcancel := context.WithTimeout(ctx, registerTimeout)
	err = wsjson.Write(wctx, conn, edgeproto.EdgeRegistered{Type: edgeproto.TypeRegistered, ServerTime: edgeproto.Stamp(time.Now())})
	wcancel()
	if err != nil {
		return
	}
	m.log.Info("edge server registered", "edgeServer", reg.EdgeServerID, "url", reg.URL, "remote", r.RemoteAddr)

	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			m.log.Info("edge server offline", "edgeServer", reg.EdgeServerID, "err", err)
			return
		}
		var u edgeproto.EdgeUpdate
		if err := json.Unmarshal(raw, &u); err != nil || u.Type != edgeproto.TypeUpdate || u.EdgeServerID != reg.EdgeServerID {
			m.log.Warn("update dropped", "edgeServer", reg.EdgeServerID, "err", errors.Join(err, errors.New("want an update for this edge server")))
			continue
		}
		m.Registry.seen(reg.EdgeServerID, link, &u)
		m.Forwarder.enqueue(&u)
	}
}

func readRegister(ctx context.Context, conn *websocket.Conn) (edgeproto.EdgeRegister, error) {
	ctx, cancel := context.WithTimeout(ctx, registerTimeout)
	defer cancel()
	var reg edgeproto.EdgeRegister
	if err := wsjson.Read(ctx, conn, &reg); err != nil {
		return reg, fmt.Errorf("no register: %w", err)
	}
	if reg.Type != edgeproto.TypeRegister {
		return reg, fmt.Errorf("first message is %q, want register", reg.Type)
	}
	return reg, reg.Validate()
}
