import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIER_MODELS, orderModelProviders, selectWorkRoute, tierModelFor } from '../src/work-routing.ts';
import { isUnknownClaudeModel } from '../src/claude-worker-driver.ts';
import { Coordinator } from '../src/coordinator.ts';
import { claudeDevelopmentArguments } from '../src/claude-adapter.ts';
import { buildCodexInvocation } from '../src/codex-adapter.ts';
import { portableClaudeConfig } from '../src/portable-runtime.ts';
import { materializeWorkspace } from '../src/worker-isolation.ts';
import { NEEDS_WORKER_WORKSPACE } from './helpers/scratch.mjs';

const catalog = { fetchedAt: 'fixture', models: [
  { slug: 'gpt-frontier', priority: 0, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-workhorse', priority: 1, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-efficient', priority: 2, supportedEfforts: ['low', 'medium'] },
] };
const CODEX = 'codex-chatgpt-signin';
const CLAUDE = 'claude-subscription-signin';
const routine = 'Implement the helper function';

test('provider order: owner preference, then the host chat\'s own provider, then Codex', () => {
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE] }), [CODEX, CLAUDE]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CODEX }), [CODEX, CLAUDE]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CLAUDE }), [CLAUDE, CODEX]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CLAUDE, preferredProvider: CODEX }), [CODEX, CLAUDE]);
  assert.deepEqual(orderModelProviders({ available: [CODEX], hostProvider: CLAUDE }), [CODEX]);
});

test('whichever provider is installed runs: Claude-only, Codex-only, or both', () => {
  const claudeOnly = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, codexInstalled: false,
    catalog: { fetchedAt: 'none', models: [] } });
  assert.equal(claudeOnly.provider, CLAUDE);
  assert.equal(claudeOnly.model, DEFAULT_TIER_MODELS[CLAUDE].efficient);
  const codexOnly = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: false, catalog });
  assert.equal(codexOnly.provider, CODEX);
  assert.equal(codexOnly.model, 'gpt-efficient');
  assert.throws(() => selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: false, codexInstalled: false,
    catalog: { fetchedAt: 'none', models: [] } }), /No installed subscription model provider/);
});

test('with both installed, workers use the host chat\'s own provider, unless the owner prefers the other', () => {
  const fromClaudeChat = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE, catalog });
  assert.equal(fromClaudeChat.provider, CLAUDE);
  assert.ok(fromClaudeChat.capabilitySignals.includes('same provider as the host chat'));
  const fromCodexChat = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CODEX, catalog });
  assert.equal(fromCodexChat.provider, CODEX);
  const preferred = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE,
    preferredProvider: CODEX, catalog });
  assert.equal(preferred.provider, CODEX);
  assert.ok(preferred.capabilitySignals.includes('owner provider preference'));
});

test('a provider at its usage limit is skipped until its reset; with every provider limited, routing refuses', () => {
  const switched = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE,
    limitedProviders: [CLAUDE], catalog });
  assert.equal(switched.provider, CODEX);
  assert.ok(switched.capabilitySignals.includes('other provider is at its usage limit'));
  assert.throws(() => selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE,
    limitedProviders: [CLAUDE, CODEX], catalog }), /at its usage limit/);
});

test('one tier rule for every provider: owner setting, else default family names, else the live catalog', () => {
  for (const tiers of Object.values(DEFAULT_TIER_MODELS)) {
    for (const name of Object.values(tiers)) assert.doesNotMatch(name, /\d/, 'default tier names carry no version');
  }
  const models = catalog.models;
  assert.equal(tierModelFor(CODEX, 'workhorse', { catalog: models }), 'gpt-workhorse');
  assert.equal(tierModelFor(CLAUDE, 'efficient', {}), DEFAULT_TIER_MODELS[CLAUDE].efficient);
  const tierModels = { [CODEX]: { efficient: 'gpt-next-mini' }, [CLAUDE]: { workhorse: 'fable' }, 'grok-signin': { frontier: 'grok-heavy' } };
  assert.equal(tierModelFor(CODEX, 'efficient', { catalog: models, tierModels }), 'gpt-next-mini');
  assert.equal(tierModelFor(CLAUDE, 'workhorse', { tierModels }), 'fable');
  assert.equal(tierModelFor('grok-signin', 'frontier', { tierModels }), 'grok-heavy', 'a new provider needs only a setting');
  assert.equal(tierModelFor('grok-signin', 'efficient', { tierModels }), null);
  assert.equal(tierModelFor(CLAUDE, 'efficient', { tierModels: { [CLAUDE]: { efficient: '  ' } } }), DEFAULT_TIER_MODELS[CLAUDE].efficient,
    'a blank setting falls back to the default name');
  const routed = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CODEX, tierModels, catalog });
  assert.equal(routed.model, 'gpt-next-mini', 'routing uses the owner setting on Codex too');
});

test('an unknown Claude model is recognised so the worker can retry on the default model', () => {
  assert.equal(isUnknownClaudeModel('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}'), true);
  assert.equal(isUnknownClaudeModel('Error: Invalid model name provided'), true);
  assert.equal(isUnknownClaudeModel("There's an issue with the selected model (sonnet-9). It may not exist."), true);
  assert.equal(isUnknownClaudeModel('Claude AI usage limit reached|1792190440'), false);
  assert.equal(isUnknownClaudeModel('npm test failed: 3 failing'), false);
});

test('a usage limit on one provider queues the same step for the other provider instead of pausing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-limit-switch-'));
  let tick = Date.UTC(2026, 9, 17, 0, 0, 0);
  const coordinator = new Coordinator(join(root, 'coordinator.sqlite'), { now: () => new Date(tick += 1000) });
  t.after(() => { coordinator.close(); rmSync(root, { recursive: true, force: true }); });
  coordinator.resume();
  const run = (installedProviders) => {
    const goal = coordinator.createGoal({ objective: 'Implement the helper', successCriteria: 'tests pass', constraints: 'scope',
      idempotencyKey: `limit-${installedProviders.length}`, reserveCredits: 1 }).goal;
    const job = coordinator.claim('worker-a', 600, String(goal.id));
    coordinator.recordAuditNote(String(job.id), 'route_selected', JSON.stringify({ provider: CLAUDE, model: 'sonnet', installedProviders }));
    coordinator.finish(String(job.id), 'failed', 'Claude AI usage limit reached');
    return coordinator.getGoal(String(goal.id));
  };
  const both = run([CODEX, CLAUDE]);
  assert.equal(both.status, 'active', 'the goal keeps running on the other provider');
  assert.ok(coordinator.goalEvents(String(both.id)).some((event) => event.kind === 'usage_limit_switched'
    && JSON.parse(String(event.detail)).switchTo === CODEX));
  assert.deepEqual(coordinator.providersAtUsageLimit(), [CLAUDE]);
  const claudeOnly = run([CLAUDE]);
  assert.equal(claudeOnly.status, 'paused', 'with no other provider the goal waits for the reset');
});

test('capability tiers are chosen the same way on either provider', () => {
  const design = 'Diagnose the root cause of the intermittent failure and design the architecture change';
  const onClaude = selectWorkRoute({ objective: design, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE, catalog });
  const onCodex = selectWorkRoute({ objective: design, cursorInstalled: false, claudeInstalled: true, hostProvider: CODEX, catalog });
  assert.equal(onClaude.capabilityTier, onCodex.capabilityTier);
  if (onClaude.capabilityTier === 'workhorse') {
    assert.equal(onClaude.model, DEFAULT_TIER_MODELS[CLAUDE].workhorse);
    assert.equal(onCodex.model, 'gpt-workhorse');
  }
});

test('a diagnosed failure on one provider moves the retry to the other', () => {
  const afterCodex = selectWorkRoute({ objective: routine, avoidProviders: [CODEX], cursorInstalled: false, claudeInstalled: true, catalog });
  assert.equal(afterCodex.provider, CLAUDE);
  assert.equal(afterCodex.taskClass, 'provider-fallback');
  const afterClaude = selectWorkRoute({ objective: routine, avoidProviders: [CLAUDE], cursorInstalled: false, claudeInstalled: true,
    hostProvider: CLAUDE, catalog });
  assert.equal(afterClaude.provider, CODEX);
});

test('Claude development arguments: equal to Codex, no restricted mode, no user settings, commands per the shared setting', () => {
  const windows = claudeDevelopmentArguments(true, 'win32');
  assert.ok(!windows.includes('--restricted'));
  assert.ok(!windows.includes('bypassPermissions') && !windows.includes('--dangerously-skip-permissions'));
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(windows.includes(flag), flag);
  assert.equal(windows[windows.indexOf('--setting-sources') + 1], '');
  assert.match(windows[windows.indexOf('--tools') + 1], /^PowerShell,/);
  assert.match(claudeDevelopmentArguments(true, 'linux')[claudeDevelopmentArguments(true, 'linux').indexOf('--tools') + 1], /^Bash,/);
  const off = claudeDevelopmentArguments(false, 'win32');
  assert.doesNotMatch(off[off.indexOf('--tools') + 1], /PowerShell|Bash/);
  assert.equal(off[off.indexOf('--allowedTools') + 1], off[off.indexOf('--tools') + 1]);
});

test('workerCommandsEnabled=false disables the Codex shell tool too', { skip: NEEDS_WORKER_WORKSPACE }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-commands-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'project');
  mkdirSync(source);
  writeFileSync(join(source, 'a.txt'), 'hello\n');
  const bytes = readFileSync(join(source, 'a.txt'));
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: source, baseRevision: 'test' },
    files: [{ path: 'a.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, 'ws'), workspaceId: 'w1' });
  const base = { executable: 'codex', model: null, reasoningEffort: 'low', windowsSandbox: 'mxc', deniedSourceRoot: source,
    developmentMode: true, writableWorkspacePaths: ['.'] };
  const shellDisabled = (config) => buildCodexInvocation(config, workspace, 'objective').join(' ').includes('--disable shell_tool');
  assert.equal(shellDisabled(base), false);
  assert.equal(shellDisabled({ ...base, workerCommandsEnabled: true }), false);
  assert.equal(shellDisabled({ ...base, workerCommandsEnabled: false }), true);
});

test('a portable Claude worker config needs no Cursor setup and denies the Codex sensitive folders except its sign-in', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-portable-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const stateRoot = join(root, 'state');
  const install = join(root, 'npm', 'claude.exe');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'npm'), { recursive: true });
  writeFileSync(install, 'fake-claude-binary');
  const sensitive = join(root, 'home-ssh');
  const signIn = join(homedir(), '.claude');
  const codex = { executable: join(root, 'codex.exe'), deniedSourceRoot: project, assignedProjectRoot: project,
    readableProjectRoots: [project], deniedParentPaths: [root], protectedPaths: [join(project, '.git')],
    deniedSensitivePaths: [sensitive, signIn], isolationSecurityStateProbe: join(root, 'probe.ps1') };
  const config = portableClaudeConfig({ developmentMode: true, writableWorkspacePaths: ['.'] }, project,
    { stateRoot, claudeExecutable: install, codex });
  assert.equal(config.containmentExecutable, codex.executable);
  assert.ok(config.executable.startsWith(stateRoot), 'executable is staged inside the Amadeus state folder');
  assert.equal(readFileSync(config.executable, 'utf8'), 'fake-claude-binary');
  assert.ok(config.deniedParentPaths.includes(sensitive));
  assert.ok(!config.deniedParentPaths.includes(signIn), 'Claude keeps its own sign-in folder');
  assert.ok(config.deniedParentPaths.some((path) => path.endsWith('deny-probe')) && existsSync(config.deniedParentPaths[0]));
  assert.deepEqual(config.readableProjectRoots, [project]);
  assert.equal(config.apiKeyAuthenticationAllowed, false);
  assert.equal(config.writableWorkspacePaths[0], '.');
});
