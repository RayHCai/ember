package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"time"

	"ember/internal/edgeproto"
)

// outcome is how far one request got; only a failure of the api leaves work to try again.
type outcome int

const (
	// delivered covers a request the api accepted and one it refused for good, which is dropped.
	delivered outcome = iota
	// later is an answer from the api that it failed (5xx); the work stays pending.
	later
	// conflicted is a 409: the api does not know the edge server yet.
	conflicted
	// down is no answer at all.
	down
)

// job is one request and how to settle the state it was built from.
type job struct {
	kind    string
	subject string
	method  string
	path    string
	body    any
	// settle runs under Recorder.mu; accepted is false when the api refused the job for good.
	settle func(accepted bool)
	// conflict, when set, runs under Recorder.mu on a 409.
	conflict func()
}

// Run sends what is pending to the api until ctx ends: each time an update or registration signals,
// then again with backoff for as long as the api fails.
func (r *Recorder) Run(ctx context.Context) {
	if r.url == "" {
		r.log.Warn("EMBER_API_URL empty: nothing is recorded at the api")
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.wake:
		}
		wait := r.retryMin
		for r.flush(ctx) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = min(2*wait, r.retryMax)
		}
	}
}

// flush makes one pass over every edge server and reports whether the api failed on any of it.
func (r *Recorder) flush(ctx context.Context) bool {
	r.reportDrops()
	again := false
	for _, id := range r.edgeIDs() {
		for _, step := range []func(context.Context, string) outcome{r.sendRegistration, r.sendDrones, r.sendRuns, r.sendFrames} {
			switch step(ctx, id) {
			case later, conflicted:
				again = true
			case down:
				return true
			}
		}
	}
	return again
}

func (r *Recorder) edgeIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Sorted(maps.Keys(r.edges))
}

func (r *Recorder) sendRegistration(ctx context.Context, id string) outcome {
	r.mu.Lock()
	e := r.edges[id]
	registering, link := e.registering, e.url
	r.mu.Unlock()
	if !registering {
		return delivered
	}
	return r.deliver(ctx, job{
		kind: "edge server", subject: id,
		method: http.MethodPut, path: edgeproto.APIEdgeServersPath + "/" + escape(id),
		body: edgeproto.PutEdgeServerRequest{URL: link},
		// Registering again meanwhile sets the same url or a newer one that must still be sent.
		settle: func(bool) {
			if e.url == link {
				e.registering = false
			}
		},
	})
}

func (r *Recorder) sendDrones(ctx context.Context, id string) outcome {
	r.mu.Lock()
	e := r.edges[id]
	var jobs []job
	for _, droneID := range slices.Sorted(maps.Keys(e.drones)) {
		rec := e.drones[droneID]
		if e.registering || !rec.pending() {
			continue
		}
		want := rec.want
		jobs = append(jobs, job{
			kind: "drone", subject: droneID,
			method: http.MethodPut, path: edgeproto.APIDronesPath + "/" + escape(droneID),
			body:     edgeproto.PutDroneRequest{EdgeServerID: &id, Name: optional(want.name), Kind: optional(want.kind)},
			settle:   func(bool) { rec.sent, rec.sentOnce = want, true },
			conflict: func() { e.registering = e.url != "" },
		})
	}
	r.mu.Unlock()
	return r.deliverAll(ctx, jobs)
}

func (r *Recorder) sendRuns(ctx context.Context, id string) outcome {
	r.mu.Lock()
	e := r.edges[id]
	var jobs []job
	for _, runID := range slices.Sorted(maps.Keys(e.runs)) {
		rec := e.runs[runID]
		if !rec.pending() {
			continue
		}
		run := rec.latest
		run.NewCells = slices.Sorted(maps.Keys(rec.cells))
		if run.NewCells == nil {
			run.NewCells = []int{}
		}
		jobs = append(jobs, job{
			kind: "run", subject: runID,
			method: http.MethodPut, path: edgeproto.APIMappingRunsPath + "/" + escape(runID) + "/edge-servers/" + escape(id),
			body: run,
			settle: func(accepted bool) {
				if !accepted {
					rec.dead = true
					clear(rec.cells)
					return
				}
				for _, c := range run.NewCells {
					delete(rec.cells, c)
				}
				rec.sent, rec.sentState, rec.sentCoverage = true, run.State, run.Coverage
			},
		})
	}
	r.mu.Unlock()
	return r.deliverAll(ctx, jobs)
}

func (r *Recorder) sendFrames(ctx context.Context, id string) outcome {
	for {
		r.mu.Lock()
		e := r.edges[id]
		if e.registering || len(e.frames.items) == 0 {
			r.mu.Unlock()
			return delivered
		}
		chunk, end := e.frames.head()
		r.mu.Unlock()
		o := r.deliver(ctx, job{
			kind: "detections", subject: id,
			method: http.MethodPost, path: edgeproto.APIDetectionsPath,
			body:   edgeproto.DetectionsIngest{EdgeServerID: id, Frames: chunk},
			settle: func(bool) { e.frames.release(end) },
		})
		if o != delivered {
			return o
		}
	}
}

// deliverAll stops at the first sign the api cannot take the rest either; a 5xx on one job does not.
func (r *Recorder) deliverAll(ctx context.Context, jobs []job) outcome {
	worst := delivered
	for _, j := range jobs {
		switch o := r.deliver(ctx, j); o {
		case later:
			worst = later
		case conflicted, down:
			return o
		}
	}
	return worst
}

func (r *Recorder) deliver(ctx context.Context, j job) outcome {
	body, err := json.Marshal(j.body)
	if err != nil {
		r.refused(j, err)
		return delivered
	}
	status, reply, err := r.do(ctx, j, body)
	switch {
	case ctx.Err() != nil:
		return down
	case err != nil:
		r.report(j.kind+" retry", "api unreachable: will retry", err, "kind", j.kind, "subject", j.subject)
		return down
	case status/100 == 2:
		r.settle(j, true)
		return delivered
	case status >= 500:
		r.report(j.kind+" retry", "api failed: will retry", fmt.Errorf("answered %d: %s", status, reply), "kind", j.kind, "subject", j.subject)
		return later
	case status == http.StatusConflict && j.conflict != nil:
		r.mu.Lock()
		j.conflict()
		r.mu.Unlock()
		r.report(j.kind+" conflict", "api does not know the edge server yet: registering again", fmt.Errorf("answered %d: %s", status, reply), "kind", j.kind, "subject", j.subject)
		return conflicted
	default:
		r.refused(j, fmt.Errorf("answered %d: %s", status, reply))
		return delivered
	}
}

// refused drops a job the api will never accept, so it is not retried forever.
func (r *Recorder) refused(j job, err error) {
	r.settle(j, false)
	r.report(j.kind+" dropped", "api refused: dropped", err, "kind", j.kind, "subject", j.subject)
}

func (r *Recorder) settle(j job, accepted bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j.settle(accepted)
}

func (r *Recorder) do(ctx context.Context, j job, body []byte) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, recordTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, j.method, r.url+j.path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	edgeproto.SetKey(req.Header, r.key)
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	reply, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<12))
	return resp.StatusCode, bytes.TrimSpace(reply), nil
}

// report logs at most one failure per key every failureLogEvery, counting the ones it held back.
func (r *Recorder) report(key, msg string, err error, attrs ...any) {
	q := r.quiet[key]
	if q == nil {
		q = &quietLog{}
		r.quiet[key] = q
	}
	now := time.Now()
	if now.Sub(q.last) < failureLogEvery {
		q.skipped++
		return
	}
	r.log.Warn(msg, append(attrs, "err", err, "skipped", q.skipped)...)
	q.last, q.skipped = now, 0
}

func (r *Recorder) reportDrops() {
	if r.dropped.Load() == 0 || time.Since(r.lastDropLog) < failureLogEvery {
		return
	}
	r.log.Warn("detections dropped: the api is too far behind", "dropped", r.dropped.Swap(0), "backlog", frameBacklog)
	r.lastDropLog = time.Now()
}

func escape(segment string) string { return url.PathEscape(segment) }

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
