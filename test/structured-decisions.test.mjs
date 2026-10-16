import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { formatGoalIterationObjective, parseGoalDecision } from '../src/goal-protocol.ts';

function setup(t, key) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-structured-decisions-'));
  let tick = Date.UTC(2026, 9, 16, 0, 0, 0);
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'), { now: () => new Date(tick += 1000) });
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({
    objective: 'Improve the module', successCriteria: 'Tests pass', constraints: 'Stay in scope',
    idempotencyKey: key, reserveCredits: 1, continuous: true,
  }).goal.id);
  coordinator.resume();
  return { coordinator, goalId };
}

function blocked(extra = {}) {
  return { status: 'blocked', summary: 'stopped here', evidence: ['HANDOFF.md'], nextObjective: null,
    nextStreamObjective: null, question: null, ...extra };
}

function claim(coordinator, goalId) {
  const job = coordinator.claim('test-worker', 600, goalId);
  assert.ok(job, 'expected a claimable job');
  return String(job.id);
}

function jobCount(coordinator, goalId) {
  return coordinator.status().jobs.filter((job) => job.goal_id === goalId).length;
}

test('the decision parser accepts hostHandoff only on a blocked decision without recovery', () => {
  const base = { summary: 's', evidence: ['e'], nextStreamObjective: null, remainingCriterion: null, question: null,
    caseId: null, stageRole: null, nextRoute: null };
  const parsed = parseGoalDecision(JSON.stringify({ ...base, status: 'blocked', nextObjective: null, recovery: null,
    hostHandoff: { action: 'Run the signed-in readback' } }));
  assert.deepEqual(parsed.hostHandoff, { action: 'Run the signed-in readback' });
  assert.equal(parseGoalDecision(JSON.stringify({ ...base, status: 'blocked', nextObjective: null, recovery: null, hostHandoff: null })).hostHandoff, undefined);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, status: 'continue', nextObjective: 'x', recovery: null,
    hostHandoff: { action: 'Run it' } })), /hostHandoff is allowed only for a blocked result/);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, status: 'blocked', nextObjective: null,
    recovery: { diagnosis: 'd', nextObjective: 'n', scope: 'same-approved-scope' }, hostHandoff: { action: 'Run it' } })), /cannot both be set/);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, status: 'blocked', nextObjective: null, recovery: null,
    hostHandoff: { action: 'Run it', scope: 'wider' } })), /unsupported fields/);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, status: 'blocked', nextObjective: null, recovery: null,
    hostHandoff: { action: '  ' } })), /hostHandoff.action must be non-empty text/);
});

test('the worker output schema lists hostHandoff as a required, nullable field', () => {
  const schema = JSON.parse(readFileSync(new URL('../src/goal-decision.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('hostHandoff'));
  assert.deepEqual(schema.properties.hostHandoff.anyOf[1].required, ['action']);
});

test('worker instructions route sandbox-blocked host steps to blocked hostHandoff', () => {
  const prompt = formatGoalIterationObjective({ goalObjective: 'Verify changes', successCriteria: 'Checks pass',
    constraints: 'Stay in scope', iteration: 1, iterationObjective: 'Run checks' });
  assert.match(prompt, /running tests or commands outside the sandbox or doing anything the sandbox blocks/);
  assert.match(prompt, /return status=blocked with hostHandoff\.action/);
  assert.match(prompt, /do not return status=continue with a nextObjective asking another worker/);
  const schema = JSON.parse(readFileSync(new URL('../src/goal-decision.schema.json', import.meta.url), 'utf8'));
  assert.match(schema.properties.hostHandoff.description, /running tests or commands outside the sandbox/);
  assert.match(schema.properties.hostHandoff.description, /status=blocked with hostHandoff\.action/);
});

test('a structured hostHandoff returns the handoff from resume without queuing a worker', (t) => {
  const { coordinator, goalId } = setup(t, 'handoff');
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'host step remains', undefined,
    blocked({ summary: 'Worker finished its part', hostHandoff: { action: 'Run the signed-in readback' } }));
  const before = jobCount(coordinator, goalId);
  const resumed = coordinator.resumeGoal(goalId);
  assert.equal(resumed.nextAction, 'execute_origin_host_handoff_and_continue');
  assert.equal(resumed.originHostHandoff.action, 'Run the signed-in readback');
  assert.deepEqual(resumed.originHostHandoff.evidence, ['HANDOFF.md']);
  assert.equal(coordinator.getGoal(goalId).status, 'blocked');
  assert.equal(jobCount(coordinator, goalId), before);
  assert.equal(coordinator.latestGoalDecision(goalId).hostHandoff.action, 'Run the signed-in readback');
});

test('handoff wording in the summary alone no longer changes what resume does', (t) => {
  const { coordinator, goalId } = setup(t, 'wording');
  coordinator.finishGoalIteration(claim(coordinator, goalId), 'blocked', undefined,
    blocked({ summary: 'Origin-host handoff: perform the readback', evidence: ['origin host handoff required'] }));
  const resumed = coordinator.resumeGoal(goalId);
  assert.equal(resumed.nextAction, undefined);
  assert.equal(resumed.status, 'active');
  assert.ok(coordinator.goalEvents(goalId).some((event) => event.kind === 'blocked_goal_resumed'));
});

test('a host completion that contradicts a blocked receipt can be reopened, using the recorded status', (t) => {
  const { coordinator, goalId } = setup(t, 'false-completion');
  const jobId = claim(coordinator, goalId);
  coordinator.finishGoalIteration(jobId, 'blocked', undefined, blocked());
  coordinator.completeExternallyVerifiedGoalIteration(jobId, 'Host marked it done', 'blocked');
  assert.equal(coordinator.getGoal(goalId).status, 'completed');
  const resumed = coordinator.resumeGoal(goalId);
  assert.equal(resumed.status, 'active');
  assert.ok(coordinator.goalEvents(goalId).some((event) => event.kind === 'false_completion_corrected_and_resumed'));
});

test('summary wording cannot reopen a completed goal without a blocked receipt status', (t) => {
  const { coordinator, goalId } = setup(t, 'phrase-only');
  const jobId = claim(coordinator, goalId);
  coordinator.finishGoalIteration(jobId, 'blocked', undefined, blocked());
  coordinator.completeExternallyVerifiedGoalIteration(jobId,
    'trustworthy strict goal decision with status=blocked; not product or milestone completion');
  assert.equal(coordinator.getGoal(goalId).status, 'completed');
  assert.throws(() => coordinator.resumeGoal(goalId), /can be resumed/);
});
