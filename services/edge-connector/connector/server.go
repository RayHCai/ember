package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"ember/internal/edgehttp"
	"ember/internal/edgeproto"
)

const (
	helloTimeout = 10 * time.Second
	writeTimeout = 5 * time.Second
	// sendBuffer is about 10 s of downlink per drone; a drone that falls further behind is dropped
	// and resumes its run when it reconnects.
	sendBuffer = 64
)

// session is one drone's open socket. Everything sent down goes through its queue.
type session struct {
	droneID string
	send    chan []byte
	kicked  chan struct{}
	once    sync.Once
}

func newSession(droneID string) *session {
	return &session{droneID: droneID, send: make(chan []byte, sendBuffer), kicked: make(chan struct{})}
}

// queue never blocks: a drone that cannot keep up loses its session rather than stalling the rest.
func (s *session) queue(msg []byte) {
	select {
	case s.send <- msg:
	default:
		s.kick()
	}
}

func (s *session) kick() { s.once.Do(func() { close(s.kicked) }) }

func (s *session) writeLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.kicked:
			return errors.New("replaced or too slow")
		case msg := <-s.send:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}

// Handler serves the drone link, tasks from edge-manager and health. key is the shared edge key.
func (c *Connector) Handler(key string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", c.serveHealth)
	mux.HandleFunc("GET "+edgeproto.DroneLinkPath, c.serveDrone)
	mux.HandleFunc("POST "+edgeproto.TaskPath, func(w http.ResponseWriter, r *http.Request) {
		if !edgeproto.HasKey(r, key) {
			edgehttp.WriteJSON(w, http.StatusUnauthorized, edgeproto.ErrorBody{Error: "missing or wrong edge key"})
			return
		}
		c.serveTask(w, r)
	})
	return mux
}

func (c *Connector) serveHealth(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	connected := len(c.sessions)
	c.mu.Unlock()
	edgehttp.WriteJSON(w, http.StatusOK, map[string]any{
		"service": "edge-connector", "ok": true, "edgeServerId": c.ID, "url": c.URL, "connectedDrones": connected,
	})
}

func (c *Connector) serveTask(w http.ResponseWriter, r *http.Request) {
	var task edgeproto.ConnectorTask
	if err := edgehttp.ReadJSON(w, r, &task); err != nil {
		edgehttp.WriteJSON(w, http.StatusBadRequest, edgeproto.ErrorBody{Error: fmt.Sprintf("task: %v", err)})
		return
	}
	if err := task.Validate(); err != nil {
		edgehttp.WriteJSON(w, http.StatusBadRequest, edgeproto.ErrorBody{Error: err.Error()})
		return
	}
	var (
		res edgeproto.ConnectorTaskResult
		err error
	)
	if task.Kind == edgeproto.KindStartMapping {
		res, err = c.Start(r.Context(), *task.Mission)
	} else {
		res, err = c.Stop(r.Context(), task.RunID)
	}
	var refused *taskError
	switch {
	case errors.As(err, &refused):
		edgehttp.WriteJSON(w, refused.status, edgeproto.ErrorBody{Error: refused.msg})
	case err != nil:
		c.log.Error("task failed", "kind", task.Kind, "err", err)
		edgehttp.WriteJSON(w, http.StatusInternalServerError, edgeproto.ErrorBody{Error: err.Error()})
	default:
		edgehttp.WriteJSON(w, http.StatusOK, res)
	}
}

// serveDrone runs one drone's link: hello, then its uplink until either side closes.
func (c *Connector) serveDrone(w http.ResponseWriter, r *http.Request) {
	c.links.Add(1)
	defer c.links.Done()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	hello, raw, err := readHello(r.Context(), conn)
	if err != nil {
		c.log.Warn("drone refused", "remote", r.RemoteAddr, "err", err)
		conn.Close(websocket.StatusPolicyViolation, truncate(err.Error()))
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s := newSession(hello.DroneID)
	if err := c.attach(ctx, s, hello, raw); err != nil {
		c.log.Error("drone not paired", "drone", hello.DroneID, "err", err)
		conn.Close(websocket.StatusInternalError, "pairing failed")
		return
	}
	c.log.Info("drone connected", "drone", hello.DroneID, "name", hello.Name, "remote", r.RemoteAddr)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		if err := s.writeLoop(ctx, conn); err != nil {
			c.log.Warn("drone link dropped", "drone", hello.DroneID, "err", err)
		}
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if err := c.uplink(hello.DroneID, data); err != nil {
			c.log.Warn("drone message dropped", "drone", hello.DroneID, "err", err)
		}
	}
	cancel()
	wg.Wait()
	c.detach(context.WithoutCancel(r.Context()), s)
	c.log.Info("drone disconnected", "drone", hello.DroneID)
}

func readHello(ctx context.Context, conn *websocket.Conn) (edgeproto.DroneHello, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()
	var h edgeproto.DroneHello
	_, raw, err := conn.Read(ctx)
	if err != nil {
		return h, nil, fmt.Errorf("no hello: %w", err)
	}
	if err := json.Unmarshal(raw, &h); err != nil {
		return h, nil, fmt.Errorf("hello: %w", err)
	}
	if h.Type != edgeproto.TypeHello {
		return h, nil, fmt.Errorf("first message is %q, want hello", h.Type)
	}
	if h.DroneID == "" || h.Name == "" || (h.Kind != "simulated" && h.Kind != "physical") {
		return h, nil, errors.New("hello: droneId, name and kind (simulated|physical) are required")
	}
	return h, raw, nil
}

// truncate keeps a close reason inside the 123 bytes a close frame allows.
func truncate(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}
