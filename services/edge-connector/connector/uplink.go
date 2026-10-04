package connector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"ember/internal/edgeproto"
)

var errNoManager = errors.New("not connected to edge-manager")

// Uplink takes one update to edge-manager; an error means it was not taken.
type Uplink interface {
	Send(ctx context.Context, u edgeproto.EdgeUpdate) error
}

// ManagerLink is the connector's one socket to edge-manager, reconnected forever. Each connect
// registers the connector again, so the manager's registry needs no storage of its own.
type ManagerLink struct {
	url      string
	key      string
	register edgeproto.EdgeRegister
	log      *slog.Logger

	mu   sync.Mutex
	conn *websocket.Conn
}

// NewManagerLink dials managerURL (http or ws, with or without the uplink path).
func NewManagerLink(managerURL, key string, register edgeproto.EdgeRegister, log *slog.Logger) (*ManagerLink, error) {
	u, err := url.Parse(managerURL)
	if err != nil {
		return nil, fmt.Errorf("edge-manager url %q: %w", managerURL, err)
	}
	switch u.Scheme {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return nil, fmt.Errorf("edge-manager url %q: want http(s) or ws(s)", managerURL)
	}
	u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), edgeproto.UplinkPath) + edgeproto.UplinkPath
	register.Type = edgeproto.TypeRegister
	return &ManagerLink{url: u.String(), key: key, register: register, log: log}, nil
}

func (m *ManagerLink) Connected() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conn != nil
}

// Run keeps the link up until ctx ends.
func (m *ManagerLink) Run(ctx context.Context) {
	backoff := time.Second
	for {
		registered, err := m.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if registered {
			backoff = time.Second
		}
		m.log.Warn("edge-manager link down", "url", m.url, "err", err, "retry", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (m *ManagerLink) session(ctx context.Context) (registered bool, err error) {
	h := http.Header{}
	edgeproto.SetKey(h, m.key)
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	conn, _, err := websocket.Dial(dctx, m.url, &websocket.DialOptions{HTTPHeader: h})
	cancel()
	if err != nil {
		return false, err
	}
	defer conn.CloseNow()

	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := wsjson.Write(rctx, conn, m.register); err != nil {
		return false, fmt.Errorf("register: %w", err)
	}
	var ack edgeproto.EdgeRegistered
	if err := wsjson.Read(rctx, conn, &ack); err != nil {
		return false, fmt.Errorf("register: %w", err)
	}
	if ack.Type != edgeproto.TypeRegistered {
		return false, fmt.Errorf("register: answered %q", ack.Type)
	}
	m.log.Info("registered with edge-manager", "url", m.url, "edgeServerId", m.register.EdgeServerID, "publicUrl", m.register.URL)

	m.mu.Lock()
	m.conn = conn
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.conn = nil
		m.mu.Unlock()
	}()
	// The manager sends nothing after registered; reading only notices the close.
	<-conn.CloseRead(ctx).Done()
	return true, errors.New("closed")
}

func (m *ManagerLink) Send(ctx context.Context, u edgeproto.EdgeUpdate) error {
	m.mu.Lock()
	conn := m.conn
	m.mu.Unlock()
	if conn == nil {
		return errNoManager
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := wsjson.Write(wctx, conn, u); err != nil {
		conn.Close(websocket.StatusGoingAway, "write failed")
		return err
	}
	return nil
}

// Run sends an update every interval until ctx ends, saving drone health alongside.
func (c *Connector) Run(ctx context.Context, up Uplink, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.Tick(ctx, up)
		}
	}
}

// Tick sends one update and records what it changed.
func (c *Connector) Tick(ctx context.Context, up Uplink) {
	t := c.snapshot()
	if err := c.store.SaveHealth(ctx, t.health); err != nil {
		c.log.Error("drone health not saved", "err", err)
	}
	if t.ended != nil {
		if err := c.store.SaveRun(ctx, *t.ended); err != nil {
			c.log.Error("run end not saved", "run", t.ended.mission.RunID, "err", err)
		}
		c.log.Info("run done", "run", t.ended.mission.RunID)
	}
	if t.dropped > 0 {
		c.log.Warn("detections dropped while edge-manager was unreachable", "count", t.dropped)
	}
	if err := up.Send(ctx, t.update); err != nil {
		return
	}
	runID := ""
	if t.update.Run != nil {
		runID = t.update.Run.RunID
	}
	c.ack(t.update.Seq, t.upToN, runID, t.cells)
}
