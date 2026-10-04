import { PhotonTransport } from './photon.js';

// Checks the Photon setup with one fixed text to a number the developer names. It reads no
// civilians, so it sends nothing an operator would have to approve.
const to = process.argv[2];
if (!to || !/^\+[1-9][0-9]{7,14}$/.test(to)) {
    process.stderr.write('usage: pnpm --filter @ember/operator-agent send:test +15551234567\n');
    process.exit(2);
}
const { PHOTON_PROJECT_ID: id, PHOTON_PROJECT_SECRET: secret } = process.env;
if (!id || !secret) {
    process.stderr.write('PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET must be set (root .env)\n');
    process.exit(2);
}

const transport = await PhotonTransport.connect(id, secret);
try {
    await transport.send(
        to,
        'Ember test message: Photon delivery is working. This is not a wildfire alert.',
    );
    process.stdout.write(`sent to ${to} via ${transport.name}\n`);
} finally {
    await transport.close();
}
process.exit(0);
