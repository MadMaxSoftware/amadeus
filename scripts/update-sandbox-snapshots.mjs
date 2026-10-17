/**
 * Re-record the worker sandbox snapshots (test/fixtures/sandbox-policy-snapshots.json).
 * Run only after an intended change to a worker's sandbox rules, and review the
 * diff: every changed line is a change to what a worker may read or write.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxPolicySnapshots } from '../test/helpers/sandbox-policy-fixtures.mjs';

const target = join(import.meta.dirname, '..', 'test', 'fixtures', 'sandbox-policy-snapshots.json');
writeFileSync(target, `${JSON.stringify(sandboxPolicySnapshots(), null, 2)}\n`);
console.log(`Recorded ${target}`);
