import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, ensureRuntime, productionPaths } from '../plugins/amadeus/scripts/server-runtime.mjs';
import { waitForWorkUpdate } from '../plugins/amadeus/scripts/tool-dispatch.mjs';

async function runningGoal(t) {
  await ensureRuntime();
  const root = mkdtempSync(join(tmpdir(), 'amadeus-compact-wait-'));
  const database = join(root, 'coordinator.sqlite');
  const coordinator = new Coordinator(database);
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  const goalId = String(coordinator.createGoal({ objective: 'Improve the module', successCriteria: 'Tests pass',
    constraints: 'Stay in scope', idempotencyKey: 'compact-wait', reserveCredits: 1 }).goal.id);
  coordinator.resume();
  const job = coordinator.claim('worker', 600, goalId);
  const cursor = Number(coordinator.goalEvents(goalId).at(-1).sequence);
  const paths = { ...productionPaths, database, stateRoot: root, workerConfig: join(root, 'missing-worker-config.json') };
  const progress = (summary) => coordinator.recordAuditNote(String(job.id), 'worker_progress',
    JSON.stringify({ schemaVersion: 1, phase: 'command', status: 'completed', summary }));
  return { coordinator, goalId, job, cursor, paths, progress };
}

test('worker checkpoints come back as one compact delta, not the whole goal record', async (t) => {
  const { goalId, cursor, paths, progress } = await runningGoal(t);
  progress('The test suite completed (exit 0).');
  progress('A repository search found no matches.');
  const update = await waitForWorkUpdate(goalId, cursor, 1, paths);
  assert.equal(update.compact, true);
  assert.equal(update.changed, true);
  assert.equal(update.doNotFinalize, true);
  assert.equal(update.nextAction, 'wait_for_work_update');
  assert.deepEqual(update.progressEvents.map((event) => event.summary),
    ['The test suite completed (exit 0).', 'A repository search found no matches.']);
  assert.ok(update.progressCursor > cursor);
  assert.equal(update.economics, undefined, 'no full record');
  assert.ok(JSON.stringify(update).length < 2000, `compact update is small (${JSON.stringify(update).length} characters)`);
  const full = await waitForWorkUpdate(goalId, cursor, 1, paths, { full: true });
  assert.equal(full.compact, undefined);
  assert.ok(JSON.stringify(full).length > JSON.stringify(update).length);
});

test('a quiet wait while the worker runs is compact too, and keeps the cursor', async (t) => {
  const { goalId, cursor, paths } = await runningGoal(t);
  const update = await waitForWorkUpdate(goalId, cursor, 1, paths);
  assert.equal(update.compact, true);
  assert.equal(update.changed, false);
  assert.equal(update.progressCursor, cursor);
  assert.match(update.message, /No new work checkpoint/);
});

test('a stage change returns the full record at once', async (t) => {
  const { goalId, cursor, paths, job, coordinator } = await runningGoal(t);
  coordinator.recordAuditNote(String(job.id), 'route_selected', JSON.stringify({ schemaVersion: 1, provider: 'software', model: null }));
  const started = Date.now();
  const update = await waitForWorkUpdate(goalId, cursor, 30, paths);
  assert.ok(Date.now() - started < 5000, 'no batching delay for a stage change');
  assert.equal(update.compact, undefined);
  assert.equal(update.changed, true);
  assert.equal(update.progressEvents.at(-1).kind, 'route_selected');
});
