import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkspace, verifyWorkspace } from '../src/worker-isolation.ts';
import { captureWorkerPatch, seedWorkspaceWithPatch } from '../src/worker-patch.ts';
import { failureOutputTail } from '../src/deterministic-verifier.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { NEEDS_WORKER_WORKSPACE } from './helpers/scratch.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-recovery-seed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'project');
  mkdirSync(source);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  const bytes = readFileSync(join(source, 'a.txt'));
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: source, baseRevision: 'test' },
    files: [{ path: 'a.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const fresh = (id) => materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, 'ws'), workspaceId: id }).workspace;
  return { root, fresh, artifacts: join(root, 'artifacts') };
}

/** A first attempt that edits a file and adds one, captured the way workers' patches are. */
function rejectedAttempt(t) {
  const fixture = project(t);
  const first = fixture.fresh('w1');
  writeFileSync(join(first, 'a.txt'), 'two\n');
  writeFileSync(join(first, 'new.txt'), 'added\n');
  const patch = captureWorkerPatch(first, ['.'], fixture.artifacts, 'w1');
  return { ...fixture, patch };
}

test('a recovery workspace starts with the rejected change and still passes the clean-workspace check', { skip: NEEDS_WORKER_WORKSPACE }, (t) => {
  const { fresh, artifacts, patch } = rejectedAttempt(t);
  const workspace = fresh('w2');
  const seed = seedWorkspaceWithPatch(workspace, { path: patch.path, sha256: patch.sha256 });
  assert.equal(seed.seeded, true);
  assert.match(seed.guidance, /already contains the previous attempt's change/);
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(workspace, 'new.txt'), 'utf8'), 'added\n');
  assert.doesNotThrow(() => verifyWorkspace(workspace), 'exactly the recorded seed is allowed');
  // A capture with no further work reproduces the same patch, so nothing is lost or doubled.
  assert.equal(captureWorkerPatch(workspace, ['.'], artifacts, 'w2-same').sha256, patch.sha256);
  writeFileSync(join(workspace, 'a.txt'), 'three\n');
  assert.throws(() => verifyWorkspace(workspace), /not clean/, 'any change beyond the seed is not');
  const next = captureWorkerPatch(workspace, ['.'], artifacts, 'w2');
  assert.deepEqual(next.changedPaths, ['a.txt', 'new.txt'], 'the recovery patch carries the original change too');
});

test('an unusable seed leaves a clean fresh copy and tells the worker so', { skip: NEEDS_WORKER_WORKSPACE }, (t) => {
  const { fresh, patch } = rejectedAttempt(t);
  const wrongHash = fresh('w2');
  assert.equal(seedWorkspaceWithPatch(wrongHash, { path: patch.path, sha256: 'F'.repeat(64) }).seeded, false);
  const missing = fresh('w3');
  const result = seedWorkspaceWithPatch(missing, { path: `${patch.path}.gone`, sha256: patch.sha256 });
  assert.equal(result.seeded, false);
  assert.match(result.guidance, /fresh copy/);
  // The project moved on since the rejected attempt: the patch no longer applies.
  const drifted = readFileSync(patch.path, 'utf8').replace('-one', '-zero');
  const driftedPath = `${patch.path}.drifted`;
  writeFileSync(driftedPath, drifted);
  const workspace = fresh('w5');
  const sha = createHash('sha256').update(drifted).digest('hex').toUpperCase();
  assert.equal(seedWorkspaceWithPatch(workspace, { path: driftedPath, sha256: sha }).seeded, false);
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(workspace, 'new.txt')), false);
  assert.doesNotThrow(() => verifyWorkspace(workspace));
});

test('a failed check keeps its last output lines, without colour codes', () => {
  const stdout = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
  const tail = failureOutputTail({ stdout, stderr: '\x1b[31mAssertionError: expected 1\x1b[0m\n' });
  assert.equal(tail.split('\n').length, 40);
  assert.match(tail, /^line 21\n/);
  assert.match(tail, /AssertionError: expected 1$/);
  assert.match(failureOutputTail({ stdout: '', stderr: '', timedOut: true, timeoutKind: 'idle' }), /idle limit/);
  assert.ok(failureOutputTail({ stdout: 'x'.repeat(5000) }).length <= 3001);
});

const providerUsage = { provider: 'fake', model: null, sessionId: 'session', requestId: null, durationMs: null, durationApiMs: null,
  tokenUsageAvailable: false, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
  actualProviderCredits: null };
const decision = { status: 'continue', summary: 'progress', evidence: ['checked'], nextObjective: 'Keep going',
  nextStreamObjective: null, remainingCriterion: 'Tests pass', question: null };

test('a verification failure hands its patch and failing output to the recovery iteration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-recovery-orchestrator-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({ objective: 'Improve the module', successCriteria: 'Tests pass',
    constraints: 'Stay in scope', idempotencyKey: 'recovery-seed', reserveCredits: 1 }).goal.id);
  coordinator.resume();
  const patchPath = join(root, 'p.patch');
  writeFileSync(patchPath, 'patch');
  const patch = { path: patchPath, sha256: 'c'.repeat(64), bytes: 5, changedFiles: 1, changedLines: 2, changedPaths: ['a.txt'] };
  const contexts = [];
  const worker = { async run(context) { contexts.push(context); return { outcome: 'changed', providerUsage, patch, goalDecision: decision }; } };
  const verifier = { async verify() { return { passed: false, projectTestsRan: true, summary: 'npm run test:x failed; the patch was not applied.',
    evidence: [], checks: [{ tool: 'npm', kind: 'project-tests', command: 'npm run test:x', exitCode: 1, passed: false,
      outputTail: 'not ok 3 - packaged copy is stale' }] }; } };
  const applicator = { async apply() { throw new Error('must not apply'); } };
  const checkpoint = { async createVerifiedCheckpoint() { return 'checkpoint'; } };
  const orchestrator = new Orchestrator(coordinator, worker, checkpoint, applicator, { verifier });
  await orchestrator.runOnce(goalId);
  assert.equal(contexts[0].seedPatch, undefined, 'the first iteration starts fresh');
  const recovery = coordinator.latestGoalDecision(goalId).recovery;
  assert.match(recovery.diagnosis, /Last output of the failed check:\nnot ok 3 - packaged copy is stale/);
  assert.match(recovery.nextObjective, /already applied: do not redo it/);
  assert.deepEqual(coordinator.recoverySeedPatch(goalId, 2), { path: patchPath, sha256: 'C'.repeat(64) });
  assert.equal(coordinator.queueTechnicalRecovery(goalId, 'd'.repeat(64)), true);
  await orchestrator.runOnce(goalId);
  assert.deepEqual(contexts[1].seedPatch, { path: patchPath, sha256: 'C'.repeat(64) });
  assert.match(contexts[1].objective, /packaged copy is stale/);
});
