// Command edge-manager takes one connection from the API and fans tasks out to N edge connectors.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"ember/internal/edgehttp"
	"ember/services/edge-manager/manager"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("edge-manager stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := edgehttp.Env("EMBER_EDGE_MANAGER_ADDR", ":8060")
	droneInfoURL := droneInfoEnv()
	key := os.Getenv("EMBER_EDGE_KEY")
	if key == "" {
		log.Warn("EMBER_EDGE_KEY unset: tasks and registrations are accepted from anyone who can reach this manager")
	}
	m := manager.New(key, droneInfoURL, log)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	srv := edgehttp.NewServer(ctx, m.Handler())
	log.Info("edge-manager up", "listen", addr, "droneInfo", droneInfoURL)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); m.Forwarder.Run(ctx) }()

	err = edgehttp.Serve(ctx, srv, ln)
	stop()
	wg.Wait()
	m.Wait()
	return err
}

// droneInfoEnv keeps an explicitly empty URL empty, which turns forwarding off.
func droneInfoEnv() string {
	if v, ok := os.LookupEnv("EMBER_DRONE_INFO_URL"); ok {
		return v
	}
	return "http://localhost:4002"
}
