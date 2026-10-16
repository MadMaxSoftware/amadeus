import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { detectUsageLimit } from '../src/provider-limits.ts';
import { codexJsonErrors } from '../src/codex-worker-driver.ts';

test('Codex usage-limit wording and codes are recognised; ordinary failures are not', () => {
  const now = new Date('2026-10-16T10:00:00Z');
  for (const text of [
    'Codex rejected the job with exit 1: | You’ve hit your usage limit. Try again at 2026-10-16T15:00:00Z.',
    "Codex rejected the job with exit 1: | You've hit your usage limit.",
    'error code usage_limit_reached',
    'workspace_member_usage_limit_reached',
    'Your workspace is out of credits. Add credits to continue.',
  ]) assert.ok(detectUsageLimit(text, now), text);
  assert.equal(detectUsageLimit('Codex rejected the job with exit 1: npm test failed with 3 errors', now), null);
  assert.equal(detectUsageLimit('rate limits are documented in README', now), null);
  assert.equal(detectUsageLimit('You’ve hit your usage limit. Try again at 2026-10-16T15:00:00Z.', now).resetsAt, '2026-10-16T15:00:00.000Z');
  assert.equal(detectUsageLimit('usage_limit_reached resets_at: 1792148400', now).resetsAt, new Date(1792148400 * 1000).toISOString());
});

test('Codex JSON error events are surfaced for failure classification', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'error', message: 'You’ve hit your usage limit.' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit.' } }),
    'not json',
  ].join('\n');
  assert.deepEqual(codexJsonErrors(jsonl), ['You’ve hit your usage limit.']);
});

test('a usage-limited attempt pauses the goal, keeps the step, and resumes after the reset', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-usage-limit-'));
  let now = Date.UTC(2026, 9, 16, 10, 0, 0);
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'), { now: () => new Date(now += 1000) });
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({ objective: 'Overnight work', successCriteria: 'Done', constraints: 'Scope',
    idempotencyKey: 'usage', reserveCredits: 1 }).goal.id);
  coordinator.resume();
  const job = coordinator.claim('worker', 600, goalId);
  coordinator.finish(String(job.id), 'failed', 'Codex rejected the job with exit 1: | You’ve hit your usage limit. Try again at 2026-10-16T12:00:00Z.');

  const goal = coordinator.getGoal(goalId);
  assert.equal(goal.status, 'paused', 'not blocked');
  const replacement = coordinator.getJob(String(goal.current_job_id));
  assert.equal(replacement.status, 'queued');
  assert.equal(replacement.package_stage_iteration, job.package_stage_iteration);
  assert.equal(coordinator.usageLimitResumeAt(goalId), '2026-10-16T12:00:00.000Z');
  assert.equal(coordinator.progressGuard(goalId).consecutiveFailures, 0, 'a usage limit is not a work failure');

  assert.equal(coordinator.resumeAfterUsageLimit(goalId), false, 'too early');
  now = Date.UTC(2026, 9, 16, 12, 0, 1);
  assert.equal(coordinator.resumeAfterUsageLimit(goalId), true);
  assert.equal(coordinator.getGoal(goalId).status, 'active');
  assert.equal(coordinator.usageLimitResumeAt(goalId), null);
  assert.ok(coordinator.claim('worker', 600, goalId), 'the saved step can run again');
});

test('without a stated reset time the goal waits briefly instead of retrying at once', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-usage-limit-default-'));
  const start = Date.UTC(2026, 9, 16, 10, 0, 0);
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'), { now: () => new Date(start) });
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({ objective: 'Work', successCriteria: 'Done', constraints: 'Scope',
    idempotencyKey: 'usage-default', reserveCredits: 1 }).goal.id);
  coordinator.resume();
  coordinator.finish(String(coordinator.claim('worker', 600, goalId).id), 'failed', 'Your workspace is out of credits.');
  assert.equal(coordinator.usageLimitResumeAt(goalId), new Date(start + 30 * 60 * 1000).toISOString());
});
