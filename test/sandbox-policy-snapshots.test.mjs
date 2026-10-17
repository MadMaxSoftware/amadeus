import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxPolicySnapshots } from './helpers/sandbox-policy-fixtures.mjs';
import { NEEDS_WORKER_WORKSPACE } from './helpers/scratch.mjs';

// Every worker adapter's sandbox rules for fixed setups. A failure means a
// worker's read/write permissions changed: if that was intended, review the
// difference and re-record with `node scripts/update-sandbox-snapshots.mjs`.
test('worker sandbox rules match the recorded snapshots for Codex, Claude-style and Cursor workers',
  { skip: (process.platform !== 'win32' && 'snapshots are recorded with Windows paths') || NEEDS_WORKER_WORKSPACE }, () => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sandbox-policy-snapshots.json'), 'utf8'));
  const current = sandboxPolicySnapshots();
  for (const name of Object.keys(recorded)) assert.deepEqual(current[name], recorded[name], name);
  assert.deepEqual(Object.keys(current).sort(), Object.keys(recorded).sort());
});
