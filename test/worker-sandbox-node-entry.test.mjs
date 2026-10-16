import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  WINDOWS_WORKER_NODE_OPTIONS, buildCodexInvocation, buildCodexSandboxCommand,
  codexModelWorkerEnvironmentOverrides, resolveCodexExecutable,
} from '../src/codex-adapter.ts';
import { buildEphemeralWorkerGuidance } from '../src/codex-worker-driver.ts';
import { materializeWorkspace } from '../src/worker-isolation.ts';
import { resolveWorkerWorkspaceRoot } from '../src/worker-workspace-root.ts';

test('Windows Codex model workers start Node without realpath() of denied workspace parents', () => {
  const env = codexModelWorkerEnvironmentOverrides('win32');
  assert.equal(env.NODE_OPTIONS, WINDOWS_WORKER_NODE_OPTIONS);
  assert.match(env.NODE_OPTIONS, /--preserve-symlinks-main/);
  assert.match(env.NODE_OPTIONS, /--preserve-symlinks(?:\s|$)/);
  assert.doesNotMatch(env.NODE_OPTIONS, /--require|--import/, 'host hooks outside the workspace stay excluded');
  assert.deepEqual(codexModelWorkerEnvironmentOverrides('linux'), {});
  const guidance = buildEphemeralWorkerGuidance('C:\\Projects\\.amadeus-worker-workspaces\\k\\job-a1', 'win32');
  assert.match(guidance, /EPERM \.\.\. lstat/);
  assert.match(guidance, /containment boundary, not a test failure/);
  assert.match(guidance, /do not clear NODE_OPTIONS/);
});

function liveSandboxUnavailable() {
  if (process.platform !== 'win32') return 'Windows MXC only';
  if (process.env.AMADEUS_WORKER === '1') return 'already inside a worker sandbox';
  const executable = resolveCodexExecutable();
  return existsSync(executable) ? null : 'local Codex sandbox executable not installed';
}

test('live MXC worker sandbox runs `node <workspace script>` without widening sibling reads', { skip: liveSandboxUnavailable() ?? false }, (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'amadeus-node-entry-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projects = join(base, 'projects');
  const project = join(projects, 'app');
  const files = {
    'scripts/entry.mjs': [
      "import { readFileSync } from 'node:fs';",
      "import { message } from './lib.mjs';",
      'const probe = (path) => { try { readFileSync(path); return "readable"; } catch (error) { return error.code; } };',
      'console.log(JSON.stringify({ message, sibling: probe(process.argv[2]), neighbour: probe(process.argv[3]) }));',
    ].join('\n'),
    'scripts/lib.mjs': "export const message = 'entry-ok';\n",
  };
  mkdirSync(join(project, 'scripts'), { recursive: true });
  const manifestFiles = Object.entries(files).map(([path, text]) => {
    writeFileSync(join(project, path), text);
    const bytes = Buffer.from(text);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() };
  });
  const state = join(base, 'state');
  mkdirSync(join(state, 'evidence'), { recursive: true });
  const manifest = join(state, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: project, baseRevision: 'fixture' }, files: manifestFiles }));
  const workspaceRoot = resolveWorkerWorkspaceRoot(project, state);
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot, workspaceId: 'job-a1' });
  // Another job's workspace for the same project and another project's file
  // must stay unreadable: the fix must not grant reads on the shared parents.
  const sibling = join(workspaceRoot, 'job-b1', 'secret.txt');
  mkdirSync(dirname(sibling), { recursive: true });
  writeFileSync(sibling, 'sibling');
  const neighbour = join(projects, 'other', 'secret.txt');
  mkdirSync(dirname(neighbour), { recursive: true });
  writeFileSync(neighbour, 'neighbour');

  const executable = resolveCodexExecutable();
  const config = {
    executable, codeModeHostExecutable: join(dirname(executable), 'codex-code-mode-host.exe'),
    windowsSandbox: 'mxc', permissionProfile: 'amadeus_task_worker', reasoningEffort: 'low',
    developmentMode: true, commandNetworkEnabled: false, deniedSourceRoot: project,
    assignedProjectRoot: project, readableProjectRoots: [project], deniedParentPaths: [projects],
    protectedPaths: [join(project, '.git')], writableWorkspacePaths: [],
    isolationReceipt: join(state, 'evidence', 'receipt.json'),
  };
  const permissions = buildCodexInvocation(config, workspace, 'No model call').find((arg) => arg.startsWith('permissions.'));
  const run = (nodeOptions) => {
    const home = mkdtempSync(join(state, 'home-'));
    const args = buildCodexSandboxCommand(config, workspace, permissions, process.execPath, ['scripts/entry.mjs', sibling, neighbour]);
    return spawnSync(executable, args, { cwd: workspace, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, CODEX_HOME: home, NODE_OPTIONS: nodeOptions } });
  };

  const before = run('');
  if (/sandbox.*(?:unavailable|not supported)|requires the elevated/i.test(before.stderr)) return t.skip('MXC sandbox unavailable on this host');
  assert.notEqual(before.status, 0, 'default Node entry resolution must still hit the denied parent');
  assert.match(before.stderr, /EPERM: operation not permitted, lstat '[^']*\.amadeus-worker-workspaces/);

  const after = run(codexModelWorkerEnvironmentOverrides('win32').NODE_OPTIONS);
  assert.equal(after.status, 0, after.stderr);
  const report = JSON.parse(after.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.message, 'entry-ok');
  assert.notEqual(report.sibling, 'readable', 'sibling worker workspaces stay denied');
  assert.notEqual(report.neighbour, 'readable', 'other projects under the denied parent stay denied');
  assert.equal(readFileSync(sibling, 'utf8'), 'sibling');
});
