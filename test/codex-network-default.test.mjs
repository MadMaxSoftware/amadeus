import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkspace } from '../src/worker-isolation.ts';
import { buildCodexInvocation } from '../src/codex-adapter.ts';
import { NEEDS_WORKER_WORKSPACE } from './helpers/scratch.mjs';

function isolatedWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-codex-network-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'project');
  mkdirSync(source);
  writeFileSync(join(source, 'a.txt'), 'hello\n');
  const bytes = readFileSync(join(source, 'a.txt'));
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: source, baseRevision: 'test' },
    files: [{ path: 'a.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, 'ws'), workspaceId: 'w1' });
  return { source, workspace };
}

function permission(config, workspace) {
  return buildCodexInvocation(config, workspace, 'objective').find((arg) => arg.startsWith('permissions.'));
}

test('development Codex workers get command network access only when the owner opts in', { skip: NEEDS_WORKER_WORKSPACE }, (t) => {
  const { source, workspace } = isolatedWorkspace(t);
  const base = { executable: 'codex', model: null, reasoningEffort: 'low', windowsSandbox: 'mxc',
    permissionProfile: 'amadeus_task_worker', approvalPolicy: 'never', deniedSourceRoot: source,
    developmentMode: true, writableWorkspacePaths: ['.'] };
  assert.match(permission(base, workspace), /network=\{enabled=false\}/);
  assert.match(permission({ ...base, commandNetworkEnabled: false }, workspace), /network=\{enabled=false\}/);
  assert.match(permission({ ...base, commandNetworkEnabled: true }, workspace), /network=\{enabled=true\}/);
});
