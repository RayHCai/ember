// Package edgehttp is the HTTP plumbing edge-manager and edge-connector share: JSON answers, a
// server with timeouts, and its shutdown.
package edgehttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"
)

const (
	maxBody       = 1 << 20
	shutdownGrace = 5 * time.Second
)

// Env is the variable's value, or fallback when it is unset or empty.
func Env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// WriteJSON answers with v as JSON.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("answer not written", "err", err)
	}
}

// ReadJSON decodes a request body of at most 1 MiB into v.
func ReadJSON(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(v)
}

// NewServer is an http.Server whose connections inherit ctx, so handlers (and the WebSocket
// loops they run) end with it. Deadlines do not reach a hijacked WebSocket.
func NewServer(ctx context.Context, h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
}

// Serve answers on ln until ctx ends or the listener fails, then drains requests for a few
// seconds. It returns the serve failure, if any.
func Serve(ctx context.Context, srv *http.Server, ln net.Listener) error {
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	var err error
	select {
	case <-ctx.Done():
	case err = <-serveErr:
	}
	drain, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownGrace)
	defer cancel()
	if shutErr := srv.Shutdown(drain); shutErr != nil {
		_ = srv.Close()
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			err = fmt.Errorf("shutdown: %w", shutErr)
		}
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}
