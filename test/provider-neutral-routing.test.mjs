import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_TIER_MODELS, orderModelProviders, selectWorkRoute } from '../src/work-routing.ts';
import { claudeDevelopmentArguments } from '../src/claude-adapter.ts';
import { buildCodexInvocation } from '../src/codex-adapter.ts';
import { portableClaudeConfig } from '../src/portable-runtime.ts';
import { materializeWorkspace } from '../src/worker-isolation.ts';

const catalog = { fetchedAt: 'fixture', models: [
  { slug: 'gpt-frontier', priority: 0, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-workhorse', priority: 1, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-efficient', priority: 2, supportedEfforts: ['low', 'medium'] },
] };
const CODEX = 'codex-chatgpt-signin';
const CLAUDE = 'claude-subscription-signin';
const routine = 'Implement the helper function';

test('provider order: owner preference, then away from the host, then Codex', () => {
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE] }), [CODEX, CLAUDE]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CODEX }), [CLAUDE, CODEX]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CLAUDE }), [CODEX, CLAUDE]);
  assert.deepEqual(orderModelProviders({ available: [CODEX, CLAUDE], hostProvider: CLAUDE, preferredProvider: CLAUDE }), [CLAUDE, CODEX]);
  assert.deepEqual(orderModelProviders({ available: [CLAUDE], hostProvider: CLAUDE }), [CLAUDE]);
});

test('whichever provider is installed runs: Claude-only, Codex-only, or both', () => {
  const claudeOnly = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, codexInstalled: false,
    catalog: { fetchedAt: 'none', models: [] } });
  assert.equal(claudeOnly.provider, CLAUDE);
  assert.equal(claudeOnly.model, CLAUDE_TIER_MODELS.efficient);
  const codexOnly = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: false, catalog });
  assert.equal(codexOnly.provider, CODEX);
  assert.equal(codexOnly.model, 'gpt-efficient');
  assert.throws(() => selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: false, codexInstalled: false,
    catalog: { fetchedAt: 'none', models: [] } }), /No installed subscription model provider/);
});

test('with both installed, workers use the provider the host chat is not on, unless the owner prefers one', () => {
  const fromClaudeChat = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE, catalog });
  assert.equal(fromClaudeChat.provider, CODEX);
  assert.ok(fromClaudeChat.capabilitySignals.includes("spread usage away from the host chat's provider"));
  const fromCodexChat = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CODEX, catalog });
  assert.equal(fromCodexChat.provider, CLAUDE);
  const preferred = selectWorkRoute({ objective: routine, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE,
    preferredProvider: CLAUDE, catalog });
  assert.equal(preferred.provider, CLAUDE);
  assert.ok(preferred.capabilitySignals.includes('owner provider preference'));
});

test('capability tiers are chosen the same way on either provider', () => {
  const design = 'Diagnose the root cause of the intermittent failure and design the architecture change';
  const onClaude = selectWorkRoute({ objective: design, cursorInstalled: false, claudeInstalled: true, hostProvider: CODEX, catalog });
  const onCodex = selectWorkRoute({ objective: design, cursorInstalled: false, claudeInstalled: true, hostProvider: CLAUDE, catalog });
  assert.equal(onClaude.capabilityTier, onCodex.capabilityTier);
  if (onClaude.capabilityTier === 'workhorse') {
    assert.equal(onClaude.model, CLAUDE_TIER_MODELS.workhorse);
    assert.equal(onCodex.model, 'gpt-workhorse');
  }
});

test('a diagnosed failure on one provider moves the retry to the other', () => {
  const afterCodex = selectWorkRoute({ objective: routine, avoidProviders: [CODEX], cursorInstalled: false, claudeInstalled: true, catalog });
  assert.equal(afterCodex.provider, CLAUDE);
  assert.equal(afterCodex.taskClass, 'provider-fallback');
  const afterClaude = selectWorkRoute({ objective: routine, avoidProviders: [CLAUDE], cursorInstalled: false, claudeInstalled: true,
    hostProvider: CODEX, catalog });
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

test('workerCommandsEnabled=false disables the Codex shell tool too', (t) => {
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
