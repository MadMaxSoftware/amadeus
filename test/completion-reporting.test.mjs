import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Coordinator } from '../src/coordinator.ts';
import { buildEphemeralWorkerGuidance, classifyCodexCommand, isSearchCommand, parseCodexProgressLine } from '../src/codex-worker-driver.ts';
import { parseCursorProgressLine } from '../src/cursor-worker-driver.ts';
import { isolatedWorkerEnvironment } from '../src/codex-adapter.ts';
import { runWorkerCommand } from '../src/codex-adapter.ts';
import { resolveMaximumIdleSeconds } from '../src/worker-timeouts.ts';

function pluginServerHref() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const publicPlugin = join(dir, 'plugins', 'amadeus', 'scripts', 'server.mjs');
    if (existsSync(publicPlugin)) return pathToFileURL(publicPlugin).href;
    const amadeus = join(dir, 'plugin-source', 'amadeus', 'scripts', 'server.mjs');
    if (existsSync(amadeus)) return pathToFileURL(amadeus).href;
    const legacy = join(dir, 'plugin-source', 'legacy-coordinator', 'scripts', 'server.mjs');
    const backup = join(dir, 'backup', 'backup-config.json');
    const hostCoordinator = join(dir, 'coordinator', 'package.json');
    if (existsSync(legacy) && existsSync(backup) && existsSync(hostCoordinator)) {
      return pathToFileURL(legacy).href;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Amadeus plugin server not found');
}

const {
  recordedHostVerificationCommands,
  comparableCacheShare,
  ownerFacingCompletionReport,
  gitMilestoneCheckStatus,
  formatMilestoneGitOwnerSummary,
  liveProgressSummary,
  progressCheckpoint,
  isMeaningfulProgressEvent,
  externallyVerifiedReceiptDisposition,
  selectReceiptWorkspace,
  verifyReceiptWorkspace,
  cursorRoutePreflightProblem,
} = await import(pluginServerHref());

test('an unusable optional Cursor accelerator does not block the Codex baseline', () => {
  const unavailableAcceptance = {
    containmentWindowsSandbox: 'mxc',
    containmentProfile: 'cursor_contained',
    automaticStartup: false,
    authentication: 'browser-login',
    apiKeyAuthenticationAllowed: false,
    isolationAcceptanceHarness: null,
    isolationSecurityStateProbe: null,
  };
  assert.equal(cursorRoutePreflightProblem({
    development: true,
    provider: 'codex-chatgpt-signin',
    cursorAcceleratorPresent: true,
    cursorWorker: unavailableAcceptance,
  }), null);
  assert.match(cursorRoutePreflightProblem({
    development: true,
    provider: 'cursor-browser-login',
    cursorAcceleratorPresent: true,
    cursorWorker: unavailableAcceptance,
  }), /acceptance preflight/i);
});

test('legacy idle timeout remains enforced while maximumIdleSeconds is canonical', () => {
  assert.equal(resolveMaximumIdleSeconds({ maximumIdleSeconds: 600 }), 600);
  assert.equal(resolveMaximumIdleSeconds({ idleProgressTimeoutSeconds: 420 }), 420);
  assert.equal(resolveMaximumIdleSeconds({ maximumIdleSeconds: 300, idleProgressTimeoutSeconds: 900 }), 300);
  assert.throws(() => resolveMaximumIdleSeconds({ maximumIdleSeconds: -1 }), /non-negative integer/);
});

test('sanitizes provider events into concrete owner progress without exposing commands', () => {
  const workspace = join(tmpdir(), 'amadeus-progress-workspace');
  const command = parseCodexProgressLine(JSON.stringify({
    type: 'item.started', item: { type: 'command_execution', status: 'in_progress', command: 'secret-command --token hidden' },
  }), workspace);
  assert.equal(command.summary, 'Running a repository command.');
  assert.doesNotMatch(JSON.stringify(command), /secret-command|token hidden/);
  assert.equal(classifyCodexCommand('npm run test:packaged'), 'the test suite');
  assert.equal(classifyCodexCommand('git status --short'), 'a Git check');
  assert.equal(classifyCodexCommand('rg -n heartbeat src'), 'a repository inspection');

  const edit = parseCodexProgressLine(JSON.stringify({
    type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [{ path: join(workspace, 'src', 'worker.ts'), kind: 'update' }] },
  }), workspace);
  assert.deepEqual(edit.paths, ['src/worker.ts']);
  assert.match(edit.summary, /src\/worker\.ts/);
});

test('a search that finds nothing is reported as no matches, not as a failure', () => {
  const workspace = join(tmpdir(), 'amadeus-progress-workspace');
  const finished = (command, exitCode) => parseCodexProgressLine(JSON.stringify({
    type: 'item.completed', item: { type: 'command_execution', status: 'failed', command, exit_code: exitCode },
  }), workspace);
  for (const command of ['rg -n missingSymbol src', '"C:\pwsh.exe" -Command "rg -n x src"', 'grep -rn x src', 'git grep -n x',
    'Select-String -Path src/*.ts -Pattern x', 'findstr /s x *.ts']) {
    assert.ok(isSearchCommand(command), command);
    const progress = finished(command, 1);
    assert.equal(progress.status, 'completed', command);
    assert.equal(progress.summary, 'A repository search found no matches.');
    assert.equal(progress.important, undefined);
  }
  assert.equal(finished('rg -n x src', 2).status, 'failed', 'exit 2 is a real search error');
  for (const command of ['npm test && rg x', 'git status && git grep x', 'Get-Content missing.txt']) {
    assert.equal(isSearchCommand(command), false, command);
  }
  assert.equal(finished('npm test && rg x', 1).summary, 'The test suite failed (exit 1); the worker is adapting.');
});

test('Cursor stream activity becomes concrete owner progress instead of generic heartbeats', () => {
  const workspace = join(tmpdir(), 'amadeus-cursor-progress-workspace');
  const command = parseCursorProgressLine(JSON.stringify({
    type: 'tool_call', subtype: 'started', tool_call: {
      shellToolCall: { args: { command: 'secret-command --token hidden' } },
    },
  }), workspace);
  assert.equal(command.summary, 'Cursor is running a repository command.');
  assert.doesNotMatch(JSON.stringify(command), /secret-command|token hidden/);
  const backgroundFailure = parseCursorProgressLine(JSON.stringify({
    type: 'system', subtype: 'task_notification', status: 'error', detail: 'private failure detail',
  }), workspace);
  assert.equal(backgroundFailure.status, 'failed');
  assert.doesNotMatch(JSON.stringify(backgroundFailure), /private failure detail/);
});

test('Windows worker guidance recovers from the unreadable-parent shell cwd', () => {
  const workspace = 'C:\\Users\\Person\\Projects\\.amadeus-worker-workspaces\\scope\\job-a1';
  const guidance = buildEphemeralWorkerGuidance(workspace, 'win32');
  assert.match(guidance, /cmd \/d \/s \/c/);
  assert.match(guidance, /explicit cd \/d/);
  assert.match(guidance, /Do not inspect C:/);
  assert.match(guidance, /job-a1/);
});

test('worker subprocesses cannot inherit coordinator state or credentials', () => {
  const prior = {
    home: process.env.AMADEUS_HOME,
    config: process.env.AMADEUS_CONFIG,
    api: process.env.OPENAI_API_KEY,
  };
  process.env.AMADEUS_HOME = 'C:\\private-state';
  process.env.AMADEUS_CONFIG = 'C:\\private-config.json';
  process.env.OPENAI_API_KEY = 'secret';
  try {
    const environment = isolatedWorkerEnvironment({ AMADEUS_HOME: 'C:\\override-attempt', NODE_OPTIONS: '' });
    assert.equal(environment.AMADEUS_HOME, undefined);
    assert.equal(environment.AMADEUS_CONFIG, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, '');
    assert.equal(environment.AMADEUS_WORKER, '1');
  } finally {
    for (const [key, value] of Object.entries({ AMADEUS_HOME: prior.home, AMADEUS_CONFIG: prior.config, OPENAI_API_KEY: prior.api })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('terminal Codex protocol receipt closes a provider that keeps waiting on stdin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-protocol-complete-'));
  try {
    const started = Date.now();
    const result = await runWorkerCommand(process.execPath, ['-e', "console.log(JSON.stringify({type:'turn.completed'})); setInterval(()=>{}, 1000)"], root, 30,
      undefined, {}, 0, (line) => JSON.parse(line).type === 'turn.completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lease heartbeats are liveness, not progress, and stale work is flagged', () => {
  assert.equal(isMeaningfulProgressEvent('heartbeat'), false);
  assert.equal(isMeaningfulProgressEvent('worker_progress'), true);
  const checkpoint = progressCheckpoint([
    { kind: 'route_step_started', created_at: '2026-10-14T04:00:00.000Z', detail: JSON.stringify({ jobId: 'job-1', detail: JSON.stringify({ step: 'execute', summary: 'Implementing progress reporting.' }) }) },
    { kind: 'heartbeat', created_at: '2026-10-14T04:20:00.000Z', detail: JSON.stringify({ jobId: 'job-1' }) },
  ], { id: 'job-1', status: 'running', heartbeat_at: '2026-10-14T04:20:00.000Z' }, 600, Date.parse('2026-10-14T04:20:00.000Z'));
  assert.equal(checkpoint.currentAction, 'Implementing progress reporting.');
  assert.equal(checkpoint.lastProgressAt, '2026-10-14T04:00:00.000Z');
  assert.equal(checkpoint.livenessAt, '2026-10-14T04:20:00.000Z');
  assert.equal(checkpoint.possiblyStalled, true);
});

test('new job does not display an earlier job checkpoint as current work', () => {
  const checkpoint = progressCheckpoint([
    { kind: 'route_step_completed', created_at: '2026-10-14T04:00:00.000Z', detail: JSON.stringify({ jobId: 'old-job', detail: JSON.stringify({ step: 'verify', summary: 'Previous verification passed.' }) }) },
    { kind: 'heartbeat', created_at: '2026-10-14T04:21:00.000Z', detail: JSON.stringify({ jobId: 'new-job' }) },
  ], { id: 'new-job', status: 'running', created_at: '2026-10-14T04:20:00.000Z', heartbeat_at: '2026-10-14T04:21:00.000Z' }, 600, Date.parse('2026-10-14T04:21:00.000Z'));
  assert.equal(checkpoint.currentAction, 'Preparing the first durable work checkpoint.');
  assert.equal(checkpoint.lastProgressAt, '2026-10-14T04:20:00.000Z');
  assert.equal(checkpoint.livenessAt, '2026-10-14T04:21:00.000Z');
});

test('stalled iteration recovery interrupts only the worker and preserves the goal', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-stall-recovery-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = coordinator.createGoal({
    objective: 'Finish a bounded milestone', successCriteria: 'Verified output exists', constraints: 'Preserve the goal',
    idempotencyKey: 'stall-recovery', reserveCredits: 1,
  });
  const goalId = String(created.goal.id);
  coordinator.resume();
  const job = coordinator.claim('test-worker', 600, goalId);
  coordinator.requestStalledIterationRecovery(goalId, 'No provider output inside the configured idle window.');
  assert.equal(coordinator.getGoal(goalId).status, 'active');
  assert.equal(coordinator.getJob(String(job.id)).stop_requested, 1);
  assert.equal(coordinator.goalEvents(goalId).at(-1).kind, 'stalled_recovery_requested');
});

test('late heartbeat cannot revive an expired lease before stale reconciliation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-late-heartbeat-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = coordinator.createGoal({
    objective: 'Finish a bounded milestone', successCriteria: 'Verified output exists', constraints: 'Preserve the goal',
    idempotencyKey: 'late-heartbeat', reserveCredits: 1,
  });
  const goalId = String(created.goal.id);
  coordinator.resume();
  const job = coordinator.claim('test-worker', 1, goalId);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  assert.throws(() => coordinator.heartbeat(String(job.id), 'test-worker', 600), /heartbeat rejected/);
  assert.equal(coordinator.getJob(String(job.id)).status, 'uncertain');
  assert.equal(coordinator.getGoal(goalId).status, 'uncertain');
  assert.equal(coordinator.expireStale().length, 0);
  assert.equal(coordinator.events(String(job.id)).filter(event => event.kind === 'lease_expired').length, 1);
});

test('claim scans a busy queue and preserves project conflict boundaries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-claim-load-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const makeGoal = (key, projectRoot) => coordinator.createGoal({
    objective: 'Process queued work', successCriteria: 'A job is claimed',
    constraints: 'Keep project isolation', idempotencyKey: key,
    reserveCredits: 1, projectRoot,
  }).goal;
  const blocked = makeGoal('claim-load-running', join(root, 'busy'));
  coordinator.resume();
  const running = coordinator.claim('first-worker', 600, String(blocked.id));
  for (let index = 0; index < 360; index++) {
    makeGoal(`claim-load-${index}`, join(root, 'busy', `child-${index}`));
  }
  const free = makeGoal('claim-load-free', join(root, 'free'));
  const started = performance.now();
  const claimed = coordinator.claim('second-worker', 600);
  const elapsedMs = performance.now() - started;
  assert.equal(claimed.goal_id, free.id);
  assert.equal(coordinator.getJob(String(running.id)).status, 'running');
  assert.ok(elapsedMs < 5000, `representative queue claim took ${elapsedMs.toFixed(1)} ms`);
});

test('mixed queue and recovery load preserves every lease and conflict after interruption', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-mixed-load-'));
  const database = join(root, 'coordinator.sqlite');
  let coordinator = new Coordinator(database);
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (key, projectRoot) => coordinator.createGoal({
    objective: 'Process mixed queue', successCriteria: 'Preserve state across restart',
    constraints: 'Keep project conflicts', idempotencyKey: key,
    reserveCredits: 1, projectRoot,
  }).goal;
  coordinator.resume();
  const running = [];
  const blocked = [];
  for (let index = 0; index < 48; index++) {
    const project = join(root, `project-${index}`);
    const goal = create(`mixed-running-${index}`, project);
    running.push({ goal, job: coordinator.claim(`worker-${index}`, 600, String(goal.id)) });
    for (let child = 0; child < 15; child++) {
      blocked.push(create(`mixed-blocked-${index}-${child}`, join(project, `child-${child}`)));
    }
  }
  const free = create('mixed-free', join(root, 'free'));
  const claimStart = performance.now();
  assert.equal(coordinator.claim('free-worker', 600).goal_id, free.id);
  const claimMs = performance.now() - claimStart;
  const expireJob = coordinator.db.prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?");
  for (const { job } of running) expireJob.run(job.id);
  coordinator.db.exec(`CREATE TRIGGER interrupt_mixed_expiry BEFORE UPDATE ON goals
    WHEN OLD.id='${running[24].goal.id}' AND NEW.status='uncertain'
    BEGIN SELECT RAISE(ABORT, 'injected mixed expiry interruption'); END`);
  const rollbackStart = performance.now();
  assert.throws(() => coordinator.expireStale(), /injected mixed expiry interruption/);
  const rollbackMs = performance.now() - rollbackStart;
  coordinator.close();
  const reopenStart = performance.now();
  coordinator = new Coordinator(database);
  const reopenMs = performance.now() - reopenStart;
  assert.equal(coordinator.goals().goals.length, 769);
  for (const { goal, job } of running) {
    assert.equal(coordinator.getJob(String(job.id)).status, 'running');
    assert.equal(coordinator.getGoal(String(goal.id)).status, 'active');
    assert.equal(coordinator.events(String(job.id)).filter(event => event.kind === 'lease_expired').length, 0);
  }
  coordinator.db.exec('DROP TRIGGER interrupt_mixed_expiry');
  const expiryStart = performance.now();
  assert.equal(coordinator.expireStale().length, 48);
  const expiryMs = performance.now() - expiryStart;
  assert.equal(coordinator.expireStale().length, 0);
  for (const { goal, job } of running) {
    assert.equal(coordinator.getGoal(String(goal.id)).status, 'uncertain');
    assert.equal(coordinator.events(String(job.id)).filter(event => event.kind === 'lease_expired').length, 1);
  }
  assert.equal(coordinator.claim('blocked-worker', 600, String(blocked[0].id)), null);
  coordinator.reconcile(String(running[0].job.id), 'failed', 'Preserved workspace checked');
  assert.equal(coordinator.claim('reconciled-worker', 600, String(blocked[0].id)).goal_id, blocked[0].id);
  const timings = { claimMs, rollbackMs, reopenMs, expiryMs };
  t.diagnostic(`mixed load timings ${JSON.stringify(timings)}`);
  for (const [phase, elapsed] of Object.entries(timings)) {
    assert.ok(elapsed < 5000, `${phase} took ${elapsed.toFixed(1)} ms`);
  }
});

test('claim expires stale work before dispatch and requires reconciliation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-claim-expiry-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const first = coordinator.createGoal({ objective: 'First job', successCriteria: 'Done',
    constraints: 'Preserve state', idempotencyKey: 'claim-expiry-first', reserveCredits: 1,
    projectRoot: join(root, 'same-project') }).goal;
  const second = coordinator.createGoal({ objective: 'Second job', successCriteria: 'Done',
    constraints: 'Preserve state', idempotencyKey: 'claim-expiry-second', reserveCredits: 1,
    projectRoot: join(root, 'same-project') }).goal;
  coordinator.resume();
  const running = coordinator.claim('expired-worker', 1, String(first.id));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  assert.equal(coordinator.claim('replacement-worker', 600, String(second.id)), null);
  assert.equal(coordinator.getJob(String(running.id)).status, 'uncertain');
  assert.equal(coordinator.getGoal(String(first.id)).status, 'uncertain');
  assert.equal(coordinator.events(String(running.id)).filter(event => event.kind === 'lease_expired').length, 1);
});

test('batch lease expiry rolls back on failure and recovers after restart', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-batch-expiry-'));
  const database = join(root, 'coordinator.sqlite');
  let coordinator = new Coordinator(database);
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const jobs = [];
  const goals = [];
  coordinator.resume();
  for (let index = 0; index < 12; index++) {
    const goal = coordinator.createGoal({
      objective: 'Preserve independent leased work', successCriteria: 'Reconcile before replacement',
      constraints: 'Retain every event', idempotencyKey: `batch-expiry-${index}`,
      reserveCredits: 1, projectRoot: join(root, `project-${index}`),
    }).goal;
    goals.push(goal);
    jobs.push(coordinator.claim(`worker-${index}`, 600, String(goal.id)));
  }
  const replacement = coordinator.createGoal({
    objective: 'Replace expired work', successCriteria: 'Claim after reconciliation',
    constraints: 'Preserve conflict boundary', idempotencyKey: 'batch-expiry-replacement',
    reserveCredits: 1, projectRoot: join(root, 'project-0'),
  }).goal;
  coordinator.db.prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE status='running'").run();
  coordinator.db.exec(`CREATE TRIGGER interrupt_batch_expiry BEFORE UPDATE ON goals
    WHEN OLD.id='${goals[6].id}' AND NEW.status='uncertain'
    BEGIN SELECT RAISE(ABORT, 'injected batch expiry interruption'); END`);
  assert.throws(() => coordinator.expireStale(), /injected batch expiry interruption/);
  coordinator.close();
  coordinator = new Coordinator(database);
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(coordinator.getJob(String(jobs[index].id)).status, 'running');
    assert.equal(coordinator.getGoal(String(goals[index].id)).status, 'active');
    assert.equal(coordinator.events(String(jobs[index].id)).filter(event => event.kind === 'lease_expired').length, 0);
  }
  coordinator.db.exec('DROP TRIGGER interrupt_batch_expiry');
  const started = performance.now();
  const expired = coordinator.expireStale();
  const elapsedMs = performance.now() - started;
  assert.deepEqual(new Set(expired), new Set(jobs.map(job => String(job.id))));
  assert.ok(elapsedMs < 5000, `12-job batch expiry took ${elapsedMs.toFixed(1)} ms`);
  assert.equal(coordinator.expireStale().length, 0);
  assert.equal(coordinator.claim('replacement', 600, String(replacement.id)), null);
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(coordinator.getGoal(String(goals[index].id)).status, 'uncertain');
    assert.equal(coordinator.events(String(jobs[index].id)).filter(event => event.kind === 'lease_expired').length, 1);
  }
  coordinator.reconcile(String(jobs[0].id), 'failed', 'Preserved workspace checked');
  assert.equal(coordinator.claim('replacement', 600, String(replacement.id)).goal_id, replacement.id);
});

test('emergency stop survives restart and holds conflicting work until reconciliation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-stop-restart-'));
  const database = join(root, 'coordinator.sqlite');
  let coordinator = new Coordinator(database);
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (key) => coordinator.createGoal({
    objective: 'Complete isolated work', successCriteria: 'Verified result',
    constraints: 'Reconcile stopped work', idempotencyKey: key,
    reserveCredits: 1, projectRoot: join(root, 'shared-project'),
  }).goal;
  const first = create('stop-restart-first');
  const second = create('stop-restart-second');
  coordinator.resume();
  const running = coordinator.claim('first-worker', 600, String(first.id));
  assert.deepEqual(coordinator.stopNow('Owner requested an emergency stop'), [running.id]);
  assert.equal(coordinator.stopRequested(String(running.id), 'first-worker'), true);
  assert.throws(() => coordinator.heartbeat(String(running.id), 'first-worker'), /heartbeat rejected/);
  coordinator.close();
  coordinator = new Coordinator(database);
  assert.equal(coordinator.getJob(String(running.id)).stop_requested, 1);
  coordinator.acknowledgeStopped(String(running.id), 'Worker stopped with edits preserved');
  assert.equal(coordinator.getGoal(String(first.id)).status, 'uncertain');
  coordinator.resume();
  assert.equal(coordinator.claim('replacement', 600, String(second.id)), null);
  coordinator.close();
  coordinator = new Coordinator(database);
  assert.equal(coordinator.getJob(String(running.id)).status, 'uncertain');
  assert.equal(coordinator.claim('replacement', 600, String(second.id)), null);
  coordinator.reconcile(String(running.id), 'failed', 'Preserved edits checked; no completed work');
  assert.equal(coordinator.getGoal(String(first.id)).status, 'blocked');
  assert.equal(coordinator.claim('replacement', 600, String(second.id)).goal_id, second.id);
  assert.equal(coordinator.events(String(running.id)).filter(event => event.kind === 'reconciled').length, 1);
});

test('representative durable state load reopens with goals and events intact', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-state-load-'));
  const database = join(root, 'coordinator.sqlite');
  let coordinator = new Coordinator(database);
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ids = [];
  for (let index = 0; index < 240; index++) {
    ids.push(String(coordinator.createGoal({
      objective: 'Preserve durable state', successCriteria: 'State survives restart',
      constraints: 'No state loss', idempotencyKey: `state-load-${index}`,
      reserveCredits: 1, projectRoot: join(root, `project-${index}`),
    }).goal.id));
  }
  coordinator.close();
  const started = performance.now();
  coordinator = new Coordinator(database);
  const goals = coordinator.goals().goals;
  const elapsedMs = performance.now() - started;
  assert.equal(goals.length, 240);
  assert.equal(new Set(goals.map(goal => goal.id)).size, 240);
  assert.equal(coordinator.goalEvents(ids.at(-1)).at(0).kind, 'created');
  assert.ok(elapsedMs < 5000, `representative state reopen took ${elapsedMs.toFixed(1)} ms`);
});

test('interrupted reconciliation rolls back job, goal, and event changes across restart', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-reconcile-interruption-'));
  const database = join(root, 'coordinator.sqlite');
  let coordinator = new Coordinator(database);
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const goal = coordinator.createGoal({
    objective: 'Preserve a large event history', successCriteria: 'Reconcile atomically',
    constraints: 'Keep all evidence', idempotencyKey: 'reconcile-interruption', reserveCredits: 1,
    projectRoot: join(root, 'project'),
  }).goal;
  coordinator.resume();
  const job = coordinator.claim('worker', 600, String(goal.id));
  for (let index = 0; index < 500; index++) {
    coordinator.db.prepare('INSERT INTO goal_events (goal_id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(goal.id, 'history_fixture', JSON.stringify({ index }), new Date().toISOString());
  }
  coordinator.stopNow('Interrupt work');
  coordinator.acknowledgeStopped(String(job.id), 'Workspace preserved');
  const before = coordinator.goalEvents(String(goal.id)).length;
  coordinator.db.exec("CREATE TRIGGER interrupt_reconcile BEFORE UPDATE ON goals WHEN NEW.status='blocked' BEGIN SELECT RAISE(ABORT, 'injected interruption'); END");
  assert.throws(() => coordinator.reconcile(String(job.id), 'failed', 'Checked preserved workspace'), /injected interruption/);
  coordinator.close();
  coordinator = new Coordinator(database);
  assert.equal(coordinator.getJob(String(job.id)).status, 'uncertain');
  assert.equal(coordinator.getGoal(String(goal.id)).status, 'uncertain');
  assert.equal(coordinator.goalEvents(String(goal.id)).length, before);
  assert.equal(coordinator.events(String(job.id)).filter(event => event.kind === 'reconciled').length, 0);
  coordinator.db.exec('DROP TRIGGER interrupt_reconcile');
  const started = performance.now();
  coordinator.reconcile(String(job.id), 'failed', 'Checked preserved workspace');
  const elapsedMs = performance.now() - started;
  assert.equal(coordinator.getJob(String(job.id)).status, 'failed');
  assert.equal(coordinator.goalEvents(String(goal.id)).length, before + 1);
  assert.ok(elapsedMs < 5000, `500-event reconciliation took ${elapsedMs.toFixed(1)} ms`);
});

test('a host-corrected first-stage technical block can queue a replacement', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-technical-retry-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = coordinator.createGoal({
    objective: 'Finish a verified milestone', successCriteria: 'All checks pass', constraints: 'Preserve evidence',
    idempotencyKey: 'technical-retry-stage-one', reserveCredits: 1,
  });
  const goalId = String(created.goal.id);
  coordinator.resume();
  const job = coordinator.claim('test-worker', 600, goalId);
  coordinator.finishGoalIteration(String(job.id), 'Verifier failed before apply', undefined, {
    status: 'blocked', summary: 'Verifier failed before apply', evidence: ['check failed'],
    nextObjective: null, nextStreamObjective: null, remainingCriterion: null, question: null,
    recovery: { diagnosis: 'cwd was wrong', nextObjective: 'repair cwd and rerun checks', scope: 'same-approved-scope' },
  });
  assert.equal(coordinator.getGoal(goalId).status, 'blocked');
  const retried = coordinator.retryFailedGoal(goalId, 'The host repaired and verified the cwd failure.');
  assert.equal(retried.status, 'paused');
  assert.equal(retried.current_iteration, 2);
  const replacement = coordinator.getJob(String(retried.current_job_id));
  assert.equal(replacement.package_stage_iteration, 1);
  assert.equal(replacement.status, 'queued');
});

test('external host reconciliation does not require a model receipt that cannot exist', () => {
  const job = { id: 'job-1', status: 'completed' };
  const event = { kind: 'iteration_completed_external_verification', detail: JSON.stringify({
    jobId: 'job-1', modelInvokedForReconciliation: false,
  }) };
  assert.deepEqual(externallyVerifiedReceiptDisposition(job, [event]), {
    jobId: 'job-1', status: 'completed', verified: null,
    requiredForCompletedResult: false, receiptExpected: false,
    externallyVerifiedCompletion: true, modelInvokedForReconciliation: false,
    disposition: 'not_applicable_external_verification_without_model_receipt',
  });
  assert.equal(externallyVerifiedReceiptDisposition(job, [{ ...event, detail: JSON.stringify({
    jobId: 'different-job', modelInvokedForReconciliation: false,
  }) }]), null);
  assert.equal(externallyVerifiedReceiptDisposition(job, [{ ...event, detail: JSON.stringify({
    jobId: 'job-1', modelInvokedForReconciliation: true,
  }) }]), null);
});

test('historical receipt audit does not require a deleted worker workspace', () => {
  const missingWorkspace = join(tmpdir(), `amadeus-deleted-worker-${process.pid}-${Date.now()}`);
  assert.equal(verifyReceiptWorkspace(missingWorkspace, true, true), null);
  assert.throws(() => verifyReceiptWorkspace(missingWorkspace, true, false));
});

test('receipt audit follows the project-sibling worker root after host migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-receipt-root-'));
  const legacyRoot = join(root, 'legacy-workers');
  const currentRoot = join(root, 'project-sibling-workers');
  const workspaceName = 'job-a1';
  mkdirSync(join(currentRoot, workspaceName), { recursive: true });
  assert.equal(selectReceiptWorkspace(workspaceName, [currentRoot, legacyRoot]), join(currentRoot, workspaceName));
  mkdirSync(join(legacyRoot, workspaceName), { recursive: true });
  assert.throws(() => selectReceiptWorkspace(workspaceName, [currentRoot, legacyRoot]), /Multiple worker workspaces/);
  rmSync(root, { recursive: true, force: true });
});

test('ordinary-software verification can close a preserved failed worker iteration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-external-verification-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = coordinator.createGoal({
    objective: 'Apply preserved documentation milestone',
    successCriteria: 'Authoritative files match and checks pass',
    constraints: 'No second model run',
    idempotencyKey: 'external-failed-worker',
    reserveCredits: 1,
  });
  const goalId = String(created.goal.id);
  coordinator.resume();
  const job = coordinator.claim('test-worker', 600, goalId);
  assert.ok(job);
  coordinator.finish(String(job.id), 'failed', 'Worker stopped after preserving its edits');

  const completed = coordinator.completeExternallyVerifiedGoalIteration(
    String(job.id),
    'Origin host applied the preserved files and all deterministic checks passed.',
  );

  assert.equal(completed.status, 'completed');
  assert.equal(coordinator.getJob(String(job.id)).status, 'completed');
  assert.equal(
    coordinator.getJob(String(job.id)).outcome,
    'Origin host applied the preserved files and all deterministic checks passed.',
  );
});
test('ordinary-software verification can close the latest explicitly stopped uncertain iteration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-stopped-external-verification-'));
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'));
  t.after(() => {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = coordinator.createGoal({
    objective: 'Apply the verified host patch',
    successCriteria: 'Host checks pass',
    constraints: 'Do not dispatch another model',
    idempotencyKey: 'external-stopped-worker',
    reserveCredits: 1,
  });
  const goalId = String(created.goal.id);
  coordinator.resume();
  const job = coordinator.claim('test-worker', 600, goalId);
  assert.ok(job);
  coordinator.stopGoal(goalId, 'The origin host is completing the verified patch directly');
  coordinator.acknowledgeStopped(String(job.id), 'Worker stopped before returning a result');

  const completed = coordinator.completeExternallyVerifiedGoalIteration(
    String(job.id),
    'Origin host applied the exact patch and all deterministic checks passed.',
  );

  assert.equal(completed.status, 'completed');
  assert.equal(coordinator.getJob(String(job.id)).status, 'completed');
  assert.equal(coordinator.getGoal(goalId).current_job_id, null);
});
test('reports verified ordinary host checks and excludes failed or model claims', () => {
  const event = (note) => ({ event: { kind: 'ordinary_software_external_verification' }, detail: { detail: JSON.stringify(note) } });
  assert.deepEqual(recordedHostVerificationCommands([
    event({ modelInvoked: false, checks: [{ command: 'pytest -q', passed: true, exitCode: 0 }, { command: 'failed-check', passed: true, exitCode: 1 }] }),
    event({ modelInvoked: true, checks: [{ command: 'unverified', passed: true, exitCode: 0 }] }),
    { event: { kind: 'untrusted' }, detail: { detail: '{}' } },
  ]), ['pytest -q']);
});

test('does not report incompatible mixed-provider cache totals as percentages', () => {
  assert.equal(comparableCacheShare(100, 80, []), 80);
  assert.equal(comparableCacheShare(100, 2000, [{ provider: 'cursor' }]), null);
  assert.equal(comparableCacheShare(0, 0, []), 0);
});

test('recognizes the live already-decoded durable event shape', () => {
  assert.deepEqual(recordedHostVerificationCommands([
    { event: { kind: 'ordinary_software_external_verification' }, detail: { modelInvoked: false, checks: [{ command: 'python -m pytest -q', passed: true, exitCode: 0 }] } },
  ]), ['python -m pytest -q']);
});

test('live progress preserves routing allocation before terminal completion', () => {
  const live = liveProgressSummary({
    done: false, stage: 'Validation', stateLabel: 'Working',
    route: 'cursor-browser-login / auto / low', lastActivity: '2026-10-05T07:00:00Z', remaining: 'verify authenticated flow',
    economics: { allocationPercentages: [{ route: 'ordinary software', percentage: 66.7, completedSteps: 2 }, { route: 'Cursor', model: 'auto', percentage: 33.3, completedSteps: 1 }] },
  });
  assert.equal(live.productResult, 'in_progress');
  assert.equal(live.workAllocation.percentages[1].route, 'Cursor');
  assert.equal(live.workAllocation.percentages[1].percentage, 33.3);
});

test('builds a durable owner-facing report with a plain-language brief plus optional diagnostics', () => {
  const git = { name: 'git_milestone', status: 'pass', summary: 'commitMessage=Milestone: fixed; sha=abc; push=pushed', evidence: [{ commitMessage: 'Milestone: fixed', commit: 'abc', pushOutcome: 'pushed' }] };
  const report = ownerFacingCompletionReport({
    productResult: 'incomplete', coordinatorVerdict: 'partially_proven', summary: 'Work is preserved but unfinished.',
    verifiedProgress: 'The local change is finished.', whatRemains: 'Another person still needs to test sign-in.', needsFromYou: null,
    workAllocation: { basis: 'completed-routed-steps', allocationPercentages: [{ route: 'ordinary software', percentage: 100 }] },
    checks: [{ name: 'verification_depth', status: 'partial', summary: 'Patch integrity only.' }, git],
    usage: { inputTokens: 0 }, completionScope: { completedEntity: 'coordinator-goal' },
  });
  assert.equal(report.title, 'Amadeus task-end report');
  assert.equal(report.ownerBrief.whatWasDone, 'The local change is finished.');
  assert.equal(report.ownerBrief.whatIsStillOutstanding, 'Another person still needs to test sign-in.');
  assert.equal(report.ownerBrief.whatYouNeedToDo, 'Nothing is needed from you right now.');
  assert.match(report.ownerBrief.referenceNote, /plain-English description/);
  assert.equal(report.productResult, 'incomplete');
  assert.equal(report.coordinatorVerdict, 'partially_proven');
  assert.equal(report.workAllocation.allocationPercentages[0].percentage, 100);
  assert.deepEqual(report.gitMilestone, { status: 'pass', summary: git.summary, evidence: git.evidence });
});

test('Git milestone reporting requires a successful push and includes the exact commit message', () => {
  const pushed = { status: 'committed_and_pushed', commitMessage: 'Milestone: verified repair', commit: 'abc123', branch: 'master', remote: 'origin', pushOutcome: 'pushed', reason: 'ok' };
  assert.equal(gitMilestoneCheckStatus(pushed), 'pass');
  assert.equal(gitMilestoneCheckStatus({ ...pushed, status: 'committed_not_pushed', pushOutcome: 'failed' }), 'partial');
  assert.equal(gitMilestoneCheckStatus({ status: 'skipped', reason: 'Unrelated changes' }), 'fail');
  assert.match(formatMilestoneGitOwnerSummary(pushed), /commitMessage=Milestone: verified repair/);
  assert.match(formatMilestoneGitOwnerSummary(pushed), /sha=abc123/);
  assert.match(formatMilestoneGitOwnerSummary(pushed), /push=pushed/);
});
