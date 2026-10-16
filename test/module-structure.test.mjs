import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(repoRoot, 'plugins', 'amadeus', 'scripts');

test('server.mjs keeps its public exports after the split', async () => {
  const server = await import(pathToFileURL(join(scripts, 'server.mjs')).href);
  for (const name of ['callTool', 'validateRoutePin', 'cursorRoutePreflightProblem', 'writableWorkspacePaths', 'retrySqliteBusy',
    'resolveUnrecordedResultArtifact', 'verifyReceiptWorkspace', 'selectReceiptWorkspace', 'externallyVerifiedReceiptDisposition',
    'providerExecutionFailed', 'gitMilestoneCheckStatus', 'formatMilestoneGitOwnerSummary', 'recordedHostVerificationCommands',
    'comparableCacheShare', 'ownerFacingCompletionReport', 'isMeaningfulProgressEvent', 'progressCheckpoint', 'liveProgressSummary',
    'withBackgroundHostState']) {
    assert.equal(typeof server[name], 'function', name);
  }
});

test('the plugin scripts import each other without cycles', () => {
  const graph = new Map();
  for (const file of readdirSync(scripts).filter((name) => name.endsWith('.mjs'))) {
    const text = readFileSync(join(scripts, file), 'utf8');
    graph.set(file, [...text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"\.\/([\w-]+\.mjs)";/gm)].map((match) => match[1]));
  }
  const state = new Map();
  const visit = (file, trail) => {
    if (state.get(file) === 'done') return;
    assert.notEqual(state.get(file), 'visiting', `import cycle: ${[...trail, file].join(' -> ')}`);
    state.set(file, 'visiting');
    for (const next of graph.get(file) ?? []) visit(next, [...trail, file]);
    state.set(file, 'done');
  };
  for (const file of graph.keys()) visit(file, []);
});

test('coordinator.ts still runs as a command-line tool and re-exports its helpers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-module-structure-'));
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, 'src', 'coordinator.ts'), 'status', '--db', join(dir, 'c.sqlite')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).paused, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const coordinator = await import(pathToFileURL(join(repoRoot, 'src', 'coordinator.ts')).href);
  assert.equal(typeof coordinator.Coordinator, 'function');
  assert.equal(coordinator.projectRootsOverlap('C:\\a', 'C:\\a\\b'), true);
});
