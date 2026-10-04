package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"ember/internal/edgeproto"
)

const (
	forwardQueue   = 256
	forwardTimeout = 5 * time.Second
	// An update carries detections no later one repeats, so a failed post is tried again briefly.
	forwardAttempts = 3
	forwardRetry    = 250 * time.Millisecond
	// helloEvery re-sends a connected drone's hello, so a restarted drone-info learns names again.
	helloEvery = 30 * time.Second
	// failureLogEvery keeps a drone-info outage to one log line per interval, not one per update.
	failureLogEvery = 30 * time.Second
)

// Forwarder turns connector updates into drone-info ingest batches and posts them, in arrival
// order, one at a time. drone-info counts every message as a sign of life, so a drone's telemetry
// goes only when it changed and its hello only while it is connected.
type Forwarder struct {
	url    string
	client *http.Client
	log    *slog.Logger
	queue  chan *edgeproto.EdgeUpdate

	dropped atomic.Int64
	// sent is what drone-info already has per drone; touched only by Run's goroutine.
	sent    map[droneKey]*forwarded
	failed  int
	lastLog time.Time
}

type droneKey struct{ edgeServerID, droneID string }

type forwarded struct {
	telemetry []byte
	helloAt   time.Time
}

// NewForwarder posts to droneInfoURL; empty disables forwarding.
func NewForwarder(droneInfoURL string, client *http.Client, log *slog.Logger) *Forwarder {
	f := &Forwarder{client: client, log: log, queue: make(chan *edgeproto.EdgeUpdate, forwardQueue), sent: map[droneKey]*forwarded{}}
	if droneInfoURL != "" {
		f.url = strings.TrimSuffix(droneInfoURL, "/") + edgeproto.DroneInfoIngestPath
	}
	return f
}

// enqueue never blocks the uplink that read the update: when drone-info falls behind, updates
// beyond the queue are dropped and counted.
func (f *Forwarder) enqueue(u *edgeproto.EdgeUpdate) {
	if f.url == "" {
		return
	}
	select {
	case f.queue <- u:
	default:
		f.dropped.Add(1)
	}
}

// Run posts queued updates until ctx ends.
func (f *Forwarder) Run(ctx context.Context) {
	if f.url == "" {
		f.log.Warn("EMBER_DRONE_INFO_URL empty: updates are not forwarded")
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case u := <-f.queue:
			batch, commit := f.batch(u, time.Now())
			if len(batch.Messages) == 0 {
				continue
			}
			if err := f.deliver(ctx, batch); err != nil {
				if ctx.Err() == nil {
					f.failed++
					f.report(err)
				}
				continue
			}
			commit()
		}
	}
}

// batch is what drone-info does not have yet from one update; commit records it as sent.
func (f *Forwarder) batch(u *edgeproto.EdgeUpdate, now time.Time) (edgeproto.DroneInfoIngest, func()) {
	out := edgeproto.DroneInfoIngest{Messages: []json.RawMessage{}}
	var marks []func()
	for _, d := range u.Drones {
		key := droneKey{u.EdgeServerID, d.DroneID}
		prev := f.sent[key]
		if prev == nil {
			prev = &forwarded{}
		}
		if d.Connected && present(d.Hello) && now.Sub(prev.helloAt) >= helloEvery {
			out.Messages = append(out.Messages, d.Hello)
			marks = append(marks, func() { f.mark(key).helloAt = now })
		}
		if present(d.Telemetry) && !bytes.Equal(d.Telemetry, prev.telemetry) {
			out.Messages = append(out.Messages, d.Telemetry)
			tel := d.Telemetry
			marks = append(marks, func() { f.mark(key).telemetry = tel })
		}
	}
	out.Messages = append(out.Messages, u.Detections...)
	return out, func() {
		for _, mark := range marks {
			mark()
		}
	}
}

// present is false for an absent field and for JSON null, which a RawMessage keeps as 4 bytes.
func present(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

func (f *Forwarder) mark(key droneKey) *forwarded {
	s := f.sent[key]
	if s == nil {
		s = &forwarded{}
		f.sent[key] = s
	}
	return s
}

func (f *Forwarder) deliver(ctx context.Context, batch edgeproto.DroneInfoIngest) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		err = f.post(ctx, body)
		if err == nil || attempt+1 == forwardAttempts {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(forwardRetry):
		}
	}
}

func (f *Forwarder) post(ctx context.Context, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, forwardTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("drone-info answered %d", resp.StatusCode)
	}
	var res edgeproto.DroneInfoIngestResult
	if json.Unmarshal(raw, &res) == nil && res.Rejected > 0 {
		f.log.Warn("drone-info rejected forwarded messages", "rejected", res.Rejected, "errors", res.Errors)
	}
	return nil
}

func (f *Forwarder) report(err error) {
	now := time.Now()
	if now.Sub(f.lastLog) < failureLogEvery {
		return
	}
	f.log.Warn("updates not forwarded to drone-info", "url", f.url, "err", err, "failed", f.failed, "dropped", f.dropped.Swap(0))
	f.lastLog, f.failed = now, 0
}
