import type { CameraSpec, DronePose, DroneSummary } from '@ember/contracts';

export const DUMMY_CAMERA: CameraSpec = { widthPx: 480, heightPx: 360, hfovDeg: 84 };

/** The one dummy drone: hovering south of Front St, looking north at the Banyan tree. */
export const DUMMY_DRONE: Pick<DroneSummary, 'droneId' | 'name' | 'kind'> & { pose: DronePose } = {
    droneId: 'dummy-1',
    name: 'Front St (stationary)',
    kind: 'simulated',
    pose: { lat: 20.8694, lng: -156.6772, altM: 150, headingDeg: 0, pitchDeg: -50 },
};
