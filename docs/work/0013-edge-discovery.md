# 0013: Edge discovery

**Status:** in-progress
**Touches:** services/edge-connector, services/drone-runtime, internal/edgeproto, packages/contracts

## Goal

A drone (e.g. a Raspberry Pi running `drone-runtime run`) started with no edge URL finds the
edge-connector on its local network (e.g. a Mac mini) and pairs with it, so every drone can be set
up identically.

## Plan

- [x] `EDGE_SERVICE_TYPE` (`_ember-edge._tcp`) and TXT keys `id`, `path` in `droneLink.ts`,
      `internal/edgeproto/drone.go`, `link/messages.py`
- [x] edge-connector announces over mDNS while it runs (`connector/advertise.go`, `libp2p/zeroconf/v2`)
- [x] drone-runtime `--edge auto` (default) and `--edge-id` browse with `zeroconf` before every
      connect (`link/discovery.py`, `EdgeLink` takes a resolver)
- [x] Verified locally: Go connector on Windows, `drone-runtime run` with no `--edge` found and paired
- [ ] Verify on the real Pi + Mac mini over Wi-Fi (macOS firewall must allow the connector binary)

## Decisions

- mDNS/DNS-SD over a custom UDP broadcast: macOS and Raspberry Pi OS already speak it, tools like
  `dns-sd -B _ember-edge._tcp` and `avahi-browse` can debug it, and it carries id and path in TXT.
- `libp2p/zeroconf/v2` over `grandcat/zeroconf`: same API, maintained fork, pure Go (no cgo).
- Failure to announce is a warning, not fatal: drones given a URL still work.
- With several edge servers on one network the drone takes the first to answer unless `--edge-id`
  names one. Rejected: picking by signal strength or load, which needs data the drone does not have.
- No pairing approval was added: the drone link stays open on the edge network, as before.

## Log

- 2026-10-03: implemented both sides and the docs; local end-to-end check passed. Next: hardware test.
