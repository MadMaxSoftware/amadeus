import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerRuntimeLayout } from '../src/worker-runtime-layout.ts';

test('runtime layout grants parent traversal and one direct child write', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-runtime-layout-'));
  try {
    const child = join(root, 'job');
    const sibling = join(root, 'sibling');
    const policy = workerRuntimeLayout(root, child);
    assert.equal(policy, `,${JSON.stringify(root)}="read",${JSON.stringify(child)}="write"`);
    assert.equal(policy.includes(`${JSON.stringify(sibling)}="write"`), false);
    assert.throws(() => workerRuntimeLayout(root, root), /direct child/);
    assert.throws(() => workerRuntimeLayout(root, join(root, '..', 'escape')), /direct child/);
    assert.throws(() => workerRuntimeLayout(root, join(root, 'nested', 'job')), /direct child/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
