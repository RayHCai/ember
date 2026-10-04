# @ember/responder

Responder mobile app: Expo SDK 57, React Native, TypeScript, Expo Router. See
[docs/architecture.md](../../docs/architecture.md) for how it talks to the api and
drone-info; wire shapes are in `packages/contracts/src/responder.ts`.

## What it does

- **Connect**: unpaired, the app opens straight to the camera. Scanning the dashboard QR code
  (`ResponderPairingCode` as JSON) pairs with the api, downloads the zone bundle, saves it to disk
  and opens the map. No other steps.
- **Map**: the zone's fuel, roads and boundary as a vector map; fire and at-risk areas, the
  planner's predicted spread (isochrones and track), and recommended attack sites as circles.
  Tap a site, or pick it from the Sites sheet, to focus it. Leave the site from the top-right menu.
- **Offline first**: the saved bundle is the map. Online, it re-syncs every 30 s while open.
- **Messages**: operator messages arrive with the zone bundle, in the sheet's feed,
  and as an in-app banner while open. A message with a location focuses the map on it.
- **Drones**: live fleet positions from drone-info when the session names a drone-info URL.

In development builds, "Demo" under the scanner loads a built-in zone (`src/demo/bundle.ts`) with
no backend.

## Layout

```
src/app/     routes: index (scanner, pairing, download), zone (map + sheet)
src/map/     geometry (bundle -> projected shapes, once) and ZoneMap (SVG + gestures)
src/state/   store (session, bundle, feed, sync loop), storage (disk), notifications, fleet
src/lib/     pure logic: projection, pairing parse, fuel runs, feed merge, api client
src/ui/      theme (light only, fire red), controls, sheet, lists, banner, icons
```

The map draws with `react-native-svg` from the bundle alone, so it needs no tile server and works
offline. Gestures move a native transform; when one ends the new view is committed to the SVG
`viewBox`, so linework is redrawn sharp at the new zoom.

## Run

```
pnpm --filter @ember/responder dev        # Expo dev server; open in a dev build or Expo Go
pnpm --filter @ember/responder test
```

Push needs a development build with an EAS `projectId` in `app.json` (`extra.eas.projectId`);
without it the app skips registration and relies on the feed poll.
