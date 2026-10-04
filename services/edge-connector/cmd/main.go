// Command edge-connector runs the local network drones join, relaying tasks down and telemetry up.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"ember/internal/edgehttp"
	"ember/internal/edgeproto"
	"ember/services/edge-connector/connector"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("edge-connector stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := edgehttp.Env("EMBER_EDGE_ADDR", ":8070")
	managerURL := edgehttp.Env("EMBER_EDGE_MANAGER_URL", "http://localhost:8060")
	key := os.Getenv("EMBER_EDGE_KEY")
	every, err := strconv.Atoi(edgehttp.Env("EMBER_EDGE_UPDATE_MS", "500"))
	if err != nil || every <= 0 {
		return fmt.Errorf("EMBER_EDGE_UPDATE_MS %q: want a positive integer", os.Getenv("EMBER_EDGE_UPDATE_MS"))
	}
	if key == "" {
		log.Warn("EMBER_EDGE_KEY unset: tasks are accepted from anyone who can reach this connector")
	}

	store, err := connector.OpenStore(ctx, edgehttp.Env("EMBER_EDGE_DB", "edge-connector.db"))
	if err != nil {
		return err
	}
	defer store.Close()
	id, err := store.Identity(ctx, os.Getenv("EMBER_EDGE_TOKEN"))
	if err != nil {
		return err
	}
	publicURL, err := connector.PublicURL(os.Getenv("EMBER_EDGE_PUBLIC_URL"), addr, managerURL)
	if err != nil {
		return err
	}
	c, err := connector.New(ctx, id, publicURL, store, log)
	if err != nil {
		return err
	}
	link, err := connector.NewManagerLink(managerURL, key, edgeproto.EdgeRegister{EdgeServerID: id, URL: publicURL}, log)
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	srv := edgehttp.NewServer(ctx, c.Handler(key))
	log.Info("edge-connector up", "edgeServerId", id, "publicUrl", publicURL, "listen", addr, "manager", managerURL)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); link.Run(ctx) }()
	go func() { defer wg.Done(); c.Run(ctx, link, time.Duration(every)*time.Millisecond) }()

	err = edgehttp.Serve(ctx, srv, ln)
	stop()
	wg.Wait()
	c.Wait()
	return err
}
