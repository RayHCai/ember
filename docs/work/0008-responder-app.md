# 0008: Responder app

**Status:** in-progress
**Touches:** apps/responder, packages/contracts, services/api, apps/dashboard

## Goal

A responder scans a QR code on the dashboard, gets the watch zone's map, fire detections and attack
plan on their phone, keeps working with no signal, and receives operator messages as pushes.

## Plan

- [x] Contract: `packages/contracts/src/responder.ts` (pairing code, session, zone bundle, messages)
- [x] App: Expo SDK 57 scaffold, welcome, QR scan + pairing, offline bundle storage, sync loop
- [x] App: vector zone map (fuel, roads, risk zones, detections, isochrones, track, attack circles),
      pan/pinch/tap, layer chips, attack plan and message sheet, in-app banner, push handling
- [x] App: built-in demo zone so it runs with no backend
- [ ] api: `POST /v1/responders/pair` (issue session from a dashboard-minted token) and
      `GET /v1/responders/zones/:zoneId/bundle` with ETag / 304
- [x] dashboard: "Connect responder" shows the `ResponderPairingCode` QR for a watch zone
      (token is dummy until the api pairing route exists)
- [ ] EAS project id in `apps/responder/app.json` so remote push works in dev builds

## Decisions

- Map is SVG drawn from the bundle, not a tile map (MapLibre/react-native-maps): works offline with
  no tile download, runs in Expo Go, and the bundle already carries terrain and roads. Rejected
  MapLibre offline packs for now: needs a dev build and a tile server. Revisit for satellite imagery.
- The QR code carries only the api URL and a short-lived token; the drone-info URL comes
  from the session so a photographed code expires and cannot be used to locate other services.
- One bundle endpoint instead of several: one round trip on a weak connection, one ETag to compare.
- The feed is polled while the app is open as well as pushed: push is not guaranteed (Expo Go,
  denied permission), and the poll costs one small request per 30 s.

## Log

- 2026-10-03: Contract and app built; typecheck, lint, tests and an Android Metro export pass.
  Next: the api routes, then the dashboard QR.
