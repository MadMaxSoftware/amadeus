import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { Orchestrator, STOP_POLL_FAILURE_LIMIT } from '../src/orchestrator.ts';

const providerUsage = { provider: 'fake', model: null, sessionId: 'session', requestId: null, durationMs: null, durationApiMs: null,
  tokenUsageAvailable: false, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
  actualProviderCredits: null };
const patch = { path: 'C:\\artifacts\\p.patch', sha256: 'a'.repeat(64), bytes: 10, changedFiles: 1, changedLines: 2, changedPaths: ['notes.txt'] };
const continueDecision = { status: 'continue', summary: 'progress', evidence: ['checked'], nextObjective: 'Keep going',
  nextStreamObjective: null, remainingCriterion: 'Tests pass', question: null };

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-orchestrator-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({ objective: 'Improve the module', successCriteria: 'Tests pass',
    constraints: 'Stay in scope', idempotencyKey: 'orchestrator', reserveCredits: 1 }).goal.id);
  coordinator.resume();
  const calls = { checkpoint: 0, apply: 0 };
  const checkpoint = { async createVerifiedCheckpoint() { calls.checkpoint += 1; return 'checkpoint'; } };
  const applicator = { async apply() { calls.apply += 1; } };
  return { coordinator, goalId, calls, checkpoint, applicator };
}

test('a goal iteration without a decision is refused before its patch reaches the project', async (t) => {
  const { coordinator, goalId, calls, checkpoint, applicator } = setup(t);
  const worker = { async run() { return { outcome: 'changed files', providerUsage, patch }; } };
  const job = await new Orchestrator(coordinator, worker, checkpoint, applicator).runOnce(goalId);
  assert.equal(job.status, 'uncertain');
  assert.match(String(job.outcome), /no trustworthy structured decision/);
  assert.deepEqual(calls, { checkpoint: 0, apply: 0 });
  assert.equal(coordinator.patchReceipts(String(job.id)).records.length, 0);
});

test('a goal iteration with a decision is checkpointed and applied once', async (t) => {
  const { coordinator, goalId, calls, checkpoint, applicator } = setup(t);
  const worker = { async run() { return { outcome: 'changed files', providerUsage, patch, goalDecision: continueDecision }; } };
  const job = await new Orchestrator(coordinator, worker, checkpoint, applicator).runOnce(goalId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(calls, { checkpoint: 1, apply: 1 });
});

test('line ending churn rejection preserves the worker result artifact', async (t) => {
  const { coordinator, goalId, calls, checkpoint, applicator } = setup(t);
  const resultArtifactPath = 'result-artifact.json';
  const worker = { async run() { return { outcome: 'changed files', providerUsage, resultArtifactPath,
    patch: { ...patch, changedLines: 202, semanticChangedLines: 2, lineEndingOnlyLines: 200 },
    goalDecision: continueDecision }; } };
  const job = await new Orchestrator(coordinator, worker, checkpoint, applicator).runOnce(goalId);
  assert.equal(job.status, 'failed');
  assert.equal(job.result_artifact_path, resultArtifactPath);
  assert.deepEqual(calls, { checkpoint: 0, apply: 0 });
});

function waitForAbortOrTimeout(signal, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
}

test('brief failures while polling for a stop request do not abort a healthy worker', async (t) => {
  const { coordinator, goalId, checkpoint, applicator } = setup(t);
  const original = coordinator.stopRequested.bind(coordinator);
  let failuresLeft = STOP_POLL_FAILURE_LIMIT - 1;
  coordinator.stopRequested = (...args) => { if (failuresLeft-- > 0) throw new Error('database is locked'); return original(...args); };
  let aborted = null;
  const worker = { async run(context) {
    aborted = await waitForAbortOrTimeout(context.signal, 20 * (STOP_POLL_FAILURE_LIMIT + 6));
    return { outcome: 'done', providerUsage, goalDecision: continueDecision };
  } };
  const job = await new Orchestrator(coordinator, worker, checkpoint, applicator, { stopPollIntervalMs: 20 }).runOnce(goalId);
  assert.equal(aborted, false);
  assert.equal(job.status, 'completed');
});

test('a run of failed stop polls still aborts the worker', async (t) => {
  const { coordinator, goalId, checkpoint, applicator } = setup(t);
  const original = coordinator.stopRequested.bind(coordinator);
  let failing = true;
  coordinator.stopRequested = (...args) => { if (failing) throw new Error('database unavailable'); return original(...args); };
  let aborted = null;
  const worker = { async run(context) {
    aborted = await waitForAbortOrTimeout(context.signal, 5000);
    failing = false;
    return { outcome: 'done', providerUsage, goalDecision: continueDecision };
  } };
  await new Orchestrator(coordinator, worker, checkpoint, applicator, { stopPollIntervalMs: 20 }).runOnce(goalId);
  assert.equal(aborted, true);
});

test('a patch re-captured after the declared build step is the one applied and recorded', async (t) => {
  const { coordinator, goalId, checkpoint } = setup(t);
  const applied = [];
  const applicator = { async apply(value) { applied.push(value.sha256); } };
  const rebuilt = { ...patch, sha256: 'b'.repeat(64), changedFiles: 3, changedPaths: ['generated.txt', 'notes.txt'] };
  const verifier = { async verify() { return { passed: true, projectTestsRan: true, summary: 'ok', evidence: [], patch: rebuilt,
    checks: [{ tool: 'npm', kind: 'build', command: 'npm run build', exitCode: 0, passed: true }] }; } };
  const worker = { async run() { return { outcome: 'changed files', providerUsage, patch, goalDecision: continueDecision }; } };
  const job = await new Orchestrator(coordinator, worker, checkpoint, applicator, { verifier }).runOnce(goalId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(applied, ['b'.repeat(64)]);
  assert.equal(String(coordinator.patchReceipts(String(job.id)).records[0].patch_sha256).toLowerCase(), 'b'.repeat(64));
});
