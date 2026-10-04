package edgehttp

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestServeStopsWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(ctx, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, srv, ln) }()

	resp, err := http.Get("http://" + ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after the context ended")
	}
}

func TestReadJSONRefusesAnOversizedBody(t *testing.T) {
	big := `{"x":"` + strings.Repeat("a", maxBody) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(big))
	var v map[string]string
	if err := ReadJSON(httptest.NewRecorder(), r, &v); err == nil {
		t.Fatal("want an error for a body over the limit")
	}
}

func TestEnvFallsBackWhenEmpty(t *testing.T) {
	t.Setenv("EDGEHTTP_TEST", "")
	if got := Env("EDGEHTTP_TEST", "fallback"); got != "fallback" {
		t.Fatalf("got %q", got)
	}
	t.Setenv("EDGEHTTP_TEST", "set")
	if got := Env("EDGEHTTP_TEST", "fallback"); got != "set" {
		t.Fatalf("got %q", got)
	}
}
