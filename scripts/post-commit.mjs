// Nudges toward the work log when a feat/fix lands without one; never fails the commit.

import { execSync } from 'node:child_process';

const subject = execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim();
const files = execSync('git show --name-only --format= HEAD', { encoding: 'utf8' });

if (/^(feat|fix)/.test(subject) && !files.includes('docs/work/')) {
    console.log(
        'post-commit: feat/fix without a docs/work/ update. If this closes or advances a work item, log it.',
    );
}
