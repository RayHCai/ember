import { Cartesian2, HeightReference, LabelStyle, VerticalOrigin } from "cesium";
import { useEffect } from "react";
import { useAppStore } from "../../state/store";
import { ALWAYS_ON_TOP, C, LABEL_FONT, toCartesian } from "../style";
import { useDataSource } from "../useDataSource";

function marker(rank: number, score: number, selected: boolean): string {
  const color = score >= 80 ? "#FF3B2F" : "#FFB020";
  const ring = selected ? `<circle cx="20" cy="20" r="18" fill="none" stroke="#3FE0FF" stroke-width="2.5"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">${ring}
    <circle cx="20" cy="20" r="12" fill="#03070A" fill-opacity="0.9" stroke="${color}" stroke-width="2.5"/>
    <text x="20" y="25" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="13" font-weight="600" fill="${color}">${rank}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Numbered markers for the report's ranked vulnerable sites. */
export function SitesLayer() {
  const viewer = useAppStore((s) => s.viewer);
  const zoneId = useAppStore((s) => s.activeZoneId);
  const report = useAppStore((s) => (zoneId ? s.reports[zoneId] : undefined));
  const selected = useAppStore((s) => s.selectedSiteId);
  const show = useAppStore((s) => s.layers.vulnerableSites);
  const ds = useDataSource(viewer, "sites");

  useEffect(() => {
    if (ds) ds.show = show;
  }, [ds, show]);

  useEffect(() => {
    if (!ds) return;
    ds.entities.removeAll();
    for (const site of report?.sites ?? []) {
      const isSelected = site.id === selected;
      ds.entities.add({
        id: `site:${site.id}`,
        position: toCartesian([site.lat, site.lon]),
        billboard: {
          image: marker(site.rank, site.peak_score, isSelected),
          width: 40,
          height: 40,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
        },
        label: {
          text: `${site.peak_score}`,
          font: LABEL_FONT,
          fillColor: C.text,
          outlineColor: C.void,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 18),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: ALWAYS_ON_TOP,
          show: isSelected,
        },
      });
    }
  }, [ds, report, selected]);

  return null;
}
