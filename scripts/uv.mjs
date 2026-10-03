// `uv <task>` in the calling package, or a clear skip when there is no uv here.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'uv',
    probe: ['--version'],
    install: 'Install uv (https://docs.astral.sh/uv)',
});
