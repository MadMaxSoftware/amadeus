import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';

function setup(t, key, continuous = false) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-progress-guard-'));
  let tick = Date.UTC(2026, 9, 16, 0, 0, 0);
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'), { now: () => new Date(tick += 1000) });
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({
    objective: 'Improve the module', successCriteria: 'Tests pass', constraints: 'Stay in scope',
    idempotencyKey: key, reserveCredits: 1, continuous,
  }).goal.id);
  coordinator.resume();
  return { coordinator, goalId };
}

function decision(status, extra = {}) {
  return { status, summary: `${status} iteration`, evidence: ['evidence'], nextObjective: status === 'continue' ? 'Keep going' : null,
    nextStreamObjective: null, remainingCriterion: status === 'continue' ? 'Tests pass' : null, question: null, ...extra };
}

function claim(coordinator, goalId) {
  const job = coordinator.claim('test-worker', 600, goalId);
  assert.ok(job, 'expected a claimable job');
  return String(job.id);
}

test('three failures in a row stop automatic retries and ask the owner', (t) => {
  const { coordinator, goalId } = setup(t, 'failures');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    coordinator.finish(claim(coordinator, goalId), 'failed', `attempt ${attempt} failed`);
    assert.equal(coordinator.getGoal(goalId).status, 'blocked');
    const retried = coordinator.retryFailedGoal(goalId, 'host retry');
    if (attempt < 3) {
      assert.equal(retried.status, 'paused');
      coordinator.resumeGoal(goalId);
    } else {
      assert.equal(retried.status, 'waiting_approval');
      assert.match(String(retried.question), /3 attempts in a row failed/);
    }
  }
  assert.equal(coordinator.progressGuard(goalId).consecutiveFailures, 3);
  assert.ok(coordinator.goalEvents(goalId).some((event) => event.kind === 'progress_limit_reached'));

  const answered = coordinator.answerGoal(goalId, 'Continue with a different approach.');
  assert.equal(answered.status, 'active');
  assert.equal(coordinator.progressGuard(goalId).consecutiveFailures, 0);
});

test('a blocked decision that completes the failure streak converts to an owner question', (t) => {
  const { coordinator, goalId } = setup(t, 'blocked', true);
  coordinator.configureProgressLimits({ consecutiveFailures: 2 });
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'blocked once', undefined, decision('blocked'));
  assert.equal(coordinator.getGoal(goalId).status, 'blocked');
  coordinator.resumeGoal(goalId);
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'blocked twice', undefined, decision('blocked'));
  const goal = coordinator.getGoal(goalId);
  assert.equal(goal.status, 'waiting_approval');
  assert.match(String(goal.question), /2 attempts in a row failed or ended blocked/);
});

test('iterations without an applied change stop at the idle limit; an applied change resets it', (t) => {
  const { coordinator, goalId } = setup(t, 'idle');
  coordinator.configureProgressLimits({ consecutiveWithoutChange: 3 });
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'looked around', undefined, decision('continue'));
  const changed = claim(coordinator, goalId);
  coordinator.recordPatchReceipt({ jobId: changed, attempt: 1, patchPath: 'C:\\artifacts\\p.patch', patchSha256: 'a'.repeat(64),
    patchBytes: 10, changedFiles: 1, changedLines: 2, checkpointReceipt: 'checkpoint', applied: true });
  coordinator.finishGoalIteration(changed, 'applied a change', undefined, decision('continue'));
  assert.equal(coordinator.progressGuard(goalId).consecutiveWithoutChange, 0);
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'idle 1', undefined, decision('continue'));
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'idle 2', undefined, decision('continue'));
  assert.equal(coordinator.getGoal(goalId).status, 'active');
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'idle 3', undefined, decision('continue'));
  const goal = coordinator.getGoal(goalId);
  assert.equal(goal.status, 'waiting_approval');
  assert.equal(goal.current_job_id, null);
  assert.match(String(goal.question), /3 iterations in a row produced no applied change/);
});

test('the daily ceiling counts AI-worker routes but not ordinary software', (t) => {
  const { coordinator, goalId } = setup(t, 'daily');
  coordinator.configureProgressLimits({ aiCallsPer24h: 2, consecutiveWithoutChange: 99 });
  const route = (jobId, provider) => coordinator.recordAuditNote(jobId, 'route_selected', JSON.stringify({ provider }));
  let job = claim(coordinator, goalId);
  route(job, 'software');
  route(job, 'codex-chatgpt-signin');
  coordinator.finishGoalIteration(job, 'step', undefined, decision('continue'));
  assert.equal(coordinator.progressGuard(goalId).aiCallsLast24h, 1);
  assert.equal(coordinator.getGoal(goalId).status, 'active');
  job = claim(coordinator, goalId);
  route(job, 'claude-subscription-signin');
  coordinator.finishGoalIteration(job, 'step', undefined, decision('continue'));
  const goal = coordinator.getGoal(goalId);
  assert.equal(goal.status, 'waiting_approval');
  assert.match(String(goal.question), /2 AI-worker calls were made in the last 24 hours/);
});

test('progress limits are reported and validated', (t) => {
  const { coordinator } = setup(t, 'limits');
  assert.deepEqual(coordinator.status().progressLimits, { consecutiveFailures: 3, consecutiveWithoutChange: 6, aiCallsPer24h: 60 });
  assert.throws(() => coordinator.configureProgressLimits({ consecutiveFailures: 0 }), /positive integer/);
});
