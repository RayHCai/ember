// Package manager is the edge plane's one link to the API: a live registry of edge connectors,
// task fan-out to them, and their updates forwarded to drone-info.
package manager

import (
	"slices"
	"strings"
	"sync"
	"time"

	"ember/internal/edgeproto"
)

// Registry is every connector that has registered since this process started, online while its
// uplink socket is open. Connectors register on every connect, so nothing here needs storing.
type Registry struct {
	mu    sync.Mutex
	edges map[string]*entry
}

type entry struct {
	status edgeproto.EdgeServerStatus
	// link identifies the socket that owns the entry, so an old socket closing late cannot mark a
	// newer one offline.
	link *uplinkSocket
}

type uplinkSocket struct {
	kick func()
}

func NewRegistry() *Registry {
	return &Registry{edges: map[string]*entry{}}
}

// online registers a connector on a new socket and drops the socket it had before.
func (r *Registry) online(reg edgeproto.EdgeRegister, link *uplinkSocket) {
	now := edgeproto.Stamp(time.Now())
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.edges[reg.EdgeServerID]
	if e == nil {
		e = &entry{}
		r.edges[reg.EdgeServerID] = e
	} else if e.link != nil {
		e.link.kick()
	}
	e.link = link
	e.status.EdgeServerID = reg.EdgeServerID
	e.status.URL = reg.URL
	e.status.Online = true
	e.status.ConnectedAt = now
	e.status.LastSeen = now
}

func (r *Registry) seen(id string, link *uplinkSocket, u *edgeproto.EdgeUpdate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.edges[id]
	if e == nil || e.link != link {
		return
	}
	e.status.LastSeen = edgeproto.Stamp(time.Now())
	e.status.Drones = len(u.Drones)
	e.status.ConnectedDrones = 0
	for _, d := range u.Drones {
		if d.Connected {
			e.status.ConnectedDrones++
		}
	}
	e.status.Run = nil
	if u.Run != nil {
		e.status.Run = &edgeproto.EdgeRunRef{RunID: u.Run.RunID, State: u.Run.State}
	}
}

func (r *Registry) offline(id string, link *uplinkSocket) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.edges[id]; e != nil && e.link == link {
		e.link = nil
		e.status.Online = false
		e.status.LastSeen = edgeproto.Stamp(time.Now())
	}
}

// List is every known connector, by id.
func (r *Registry) List() []edgeproto.EdgeServerStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]edgeproto.EdgeServerStatus, 0, len(r.edges))
	for _, e := range r.edges {
		s := e.status
		if s.Run != nil {
			run := *s.Run
			s.Run = &run
		}
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b edgeproto.EdgeServerStatus) int { return strings.Compare(a.EdgeServerID, b.EdgeServerID) })
	return out
}

// Online reports whether a connector's uplink is open.
func (r *Registry) Online(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.edges[id]
	return e != nil && e.status.Online
}
