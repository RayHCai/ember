import { CallbackProperty, HeightReference } from 'cesium';
import { useEffect } from 'react';
import type { CivilianReport } from '../../sim/types';
import { prefersReducedMotion } from '../camera';
import { ALWAYS_ON_TOP, ICONS, toCartesian } from '../style';
import { useDataSource } from '../useDataSource';
import { frameMilliseconds } from '../frameClock';

/** Smoke and fire sightings texted in by civilians, waiting for an operator to verify. */
export function ReportsLayer({ reports }: { reports: CivilianReport[] }) {
    const ds = useDataSource('reports');

    useEffect(() => {
        if (!ds) return;
        ds.entities.removeAll();
        const reduced = prefersReducedMotion();
        for (const report of reports) {
            if (report.status === 'dismissed') continue;
            const fresh = report.status === 'new';
            ds.entities.add({
                id: `report:${report.id}`,
                position: toCartesian([report.lat, report.lon]),
                billboard: {
                    image: fresh ? ICONS.report : ICONS.reportVerified,
                    width: 28,
                    height: 28,
                    scale:
                        fresh && !reduced
                            ? new CallbackProperty(
                                  () => 1 + 0.08 * Math.sin(frameMilliseconds() / 260),
                                  false,
                              )
                            : 1,
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: ALWAYS_ON_TOP,
                },
            });
        }
    }, [ds, reports]);

    return null;
}
