import { Cartesian3, Color } from "cesium";
import { projector } from "../geo/grid";
import type { LatLon } from "../types/events";

// Design tokens as Cesium colors. Warn and heat mean danger only.
export const C = {
  void: Color.fromCssColorString("#03070A"),
  signal: Color.fromCssColorString("#3FE0FF"),
  text: Color.fromCssColorString("#E3F6FB"),
  muted: Color.fromCssColorString("#6E8D96"),
  warn: Color.fromCssColorString("#FFB020"),
  heat: Color.fromCssColorString("#FF3B2F"),
} as const;

export const LABEL_FONT = '600 12px "Chakra Petch", system-ui, sans-serif';
export const MONO_FONT = '500 11px "IBM Plex Mono", ui-monospace, monospace';

/** Keeps icons and labels visible above terrain and 3D tiles. */
export const ALWAYS_ON_TOP = Number.POSITIVE_INFINITY;

export function toCartesian([lat, lon]: LatLon, height = 0): Cartesian3 {
  return Cartesian3.fromDegrees(lon, lat, height);
}

/** A circle on the ground as a closed ring of positions. */
export function circleRing(center: LatLon, radiusM: number, segments = 72): Cartesian3[] {
  const project = projector(center);
  const [, unitY] = project([center[0] + 1, center[1]]);
  const [unitX] = project([center[0], center[1] + 1]);
  const ring: Cartesian3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const lat = center[0] + (Math.sin(a) * radiusM) / unitY;
    const lon = center[1] + (Math.cos(a) * radiusM) / unitX;
    ring.push(Cartesian3.fromDegrees(lon, lat));
  }
  return ring;
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Edge server (drone dock): a hexagon pad with a centre mark.
export const EDGE_ICON = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" fill="#03070A" fill-opacity="0.85" stroke="#3FE0FF" stroke-width="2"/>
    <circle cx="14" cy="14" r="3.5" fill="#3FE0FF"/>
  </svg>`,
);

export const EDGE_ICON_PENDING = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" fill="#03070A" fill-opacity="0.85" stroke="#3FE0FF" stroke-width="2" stroke-dasharray="3 2"/>
    <circle cx="14" cy="14" r="3" fill="none" stroke="#3FE0FF" stroke-width="1.5"/>
  </svg>`,
);

// Shelter: a roofline over a door, in text color with signal edge.
export const SHELTER_ICON = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path d="M3 11 L12 4 L21 11 V20 H3 Z" fill="#03070A" fill-opacity="0.85" stroke="#E3F6FB" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="9.5" y="13" width="5" height="7" fill="#3FE0FF"/>
  </svg>`,
);

// Drone: a white arrowhead with rotor dots, tinted by state. Points north at 0.
export const DRONE_ICON = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <circle cx="5" cy="7" r="2.2" fill="#FFFFFF"/><circle cx="19" cy="7" r="2.2" fill="#FFFFFF"/>
    <circle cx="5" cy="18" r="2.2" fill="#FFFFFF"/><circle cx="19" cy="18" r="2.2" fill="#FFFFFF"/>
    <path d="M12 2 L17 17 L12 14 L7 17 Z" fill="#FFFFFF" stroke="#03070A" stroke-width="1"/>
  </svg>`,
);
