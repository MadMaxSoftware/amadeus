import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_API_KEY_VARIABLES, WORKER_PROVIDERS, providerAllowed, providerLabel, workerProvider } from '../src/worker-providers.ts';
import { selectWorkRoute, tierModelFor } from '../src/work-routing.ts';
import { grokDevelopmentArguments, buildClaudeEnvironment } from '../src/claude-adapter.ts';
import { defaultSensitivePaths, findGrokExecutable, grokSignedIn, portableClaudeConfig } from '../src/portable-runtime.ts';
import { detectUsageLimit } from '../src/provider-limits.ts';
import { assertSubscriptionProviderDeclared } from '../src/provider-flows.ts';
import { isCredentialVariable } from '../src/worker-environment.ts';

const CODEX = 'codex-chatgpt-signin';
const CLAUDE = 'claude-subscription-signin';
const GROK = 'grok-subscription-signin';
const catalog = { fetchedAt: 'fixture', models: [
  { slug: 'gpt-frontier', priority: 0, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-workhorse', priority: 1, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-efficient', priority: 2, supportedEfforts: ['low', 'medium'] },
] };
const routine = 'Implement the helper function';

test('every provider is described once, with a label, sign-in folder and paid-key variables', () => {
  assert.deepEqual(WORKER_PROVIDERS.map((provider) => provider.id), [CODEX, CLAUDE, GROK]);
  assert.deepEqual(WORKER_PROVIDERS.map((provider) => providerLabel(provider.id)), ['Codex', 'Claude', 'Grok']);
  assert.equal(providerLabel('cursor-browser-login'), 'Cursor');
  assert.equal(new Set(WORKER_PROVIDERS.map((provider) => provider.signInFolder)).size, WORKER_PROVIDERS.length);
  for (const name of PROVIDER_API_KEY_VARIABLES) assert.equal(isCredentialVariable(name), true, `${name} never reaches a worker`);
  for (const provider of WORKER_PROVIDERS) {
    for (const name of Object.values(provider.defaultTierModels)) assert.doesNotMatch(name, /\d/, 'tier names carry no version');
  }
});

test('an unverified provider (Grok) routes only after the owner opts in', () => {
  assert.equal(workerProvider(GROK).verifiedLive, false);
  assert.equal(providerAllowed(GROK, undefined), false);
  assert.equal(providerAllowed(GROK, [GROK]), true);
  assert.equal(providerAllowed(CLAUDE, undefined), true);
});

test('routing treats Grok like any other provider once it is installed and allowed', () => {
  const onlyGrok = selectWorkRoute({ objective: routine, cursorInstalled: false, installedProviders: [GROK], catalog });
  assert.equal(onlyGrok.provider, GROK);
  assert.equal(onlyGrok.model, null, 'with no tier setting Grok uses its own default model');
  const configured = selectWorkRoute({ objective: routine, cursorInstalled: false, installedProviders: [CODEX, GROK],
    preferredProvider: GROK, tierModels: { [GROK]: { efficient: 'grok-code-fast' } }, catalog });
  assert.equal(configured.provider, GROK);
  assert.equal(configured.model, 'grok-code-fast');
  const reserve = selectWorkRoute({ objective: routine, cursorInstalled: false, installedProviders: [CODEX, GROK],
    hostProvider: CLAUDE, limitedProviders: [CODEX], catalog });
  assert.equal(reserve.provider, GROK, 'Grok is the reserve when Codex is at its usage limit');
  assert.equal(tierModelFor(GROK, 'frontier', {}), null);
  assert.throws(() => selectWorkRoute({ objective: routine, cursorInstalled: false, installedProviders: [CODEX], catalog: { fetchedAt: 'none', models: [] } }),
    /No installed subscription model provider/, 'Codex still needs its live catalog');
});

test('Grok Build worker arguments match the shared worker rules', () => {
  const on = grokDevelopmentArguments(true, { model: 'grok-code-fast', reasoningEffort: 'low' });
  assert.ok(!on.includes('--yolo') && !on.some((value) => /bypassPermissions/.test(value)), 'never approve every tool');
  assert.equal(on[on.indexOf('--output-format') + 1], 'streaming-messages-json');
  assert.ok(on.includes('--no-auto-update'));
  assert.match(on[on.indexOf('--disallowed-tools') + 1], /web_search/);
  assert.doesNotMatch(on[on.indexOf('--disallowed-tools') + 1], /run_terminal_cmd/);
  assert.ok(on.join(' ').includes('--allow Bash'));
  assert.equal(on[on.indexOf('--model') + 1], 'grok-code-fast');
  assert.equal(on[on.indexOf('--effort') + 1], 'low');
  const off = grokDevelopmentArguments(false);
  assert.match(off[off.indexOf('--disallowed-tools') + 1], /run_terminal_cmd/, 'workerCommandsEnabled=false removes commands');
  assert.ok(!off.join(' ').includes('--allow Bash'));
  assert.ok(!off.includes('--model'), 'no model flag means the CLI default');
});

test('Grok install and sign-in are found without running anything', () => {
  const home = join(tmpdir(), 'grok-home');
  const exe = join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  const present = (path) => path === exe || path === join(home, '.grok', 'auth.json');
  assert.equal(findGrokExecutable({ USERPROFILE: home, HOME: home, PATH: '' }, present), exe);
  assert.equal(findGrokExecutable({ USERPROFILE: home, HOME: home, PATH: '' }, () => false), null);
  assert.equal(grokSignedIn({ USERPROFILE: home, HOME: home }, present), true);
  assert.equal(grokSignedIn({ USERPROFILE: home, HOME: home }, () => false), false, 'an API key alone is not a subscription sign-in');
});

test('a portable Grok worker gets the same sandbox as Claude, with its own sign-in folder only', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-portable-grok-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const stateRoot = join(root, 'state');
  const install = join(root, 'bin', 'grok.exe');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(install, 'fake-grok-binary');
  const grokSignIn = join(homedir(), '.grok');
  const claudeSignIn = join(homedir(), '.claude');
  const codex = { executable: join(root, 'codex.exe'), deniedSourceRoot: project, assignedProjectRoot: project,
    readableProjectRoots: [project], deniedParentPaths: [root], protectedPaths: [join(project, '.git')],
    deniedSensitivePaths: [grokSignIn, claudeSignIn], isolationSecurityStateProbe: join(root, 'probe.ps1') };
  const config = portableClaudeConfig({ cli: 'grok', developmentMode: true, writableWorkspacePaths: ['.'] }, project,
    { stateRoot, claudeExecutable: install, codex });
  assert.equal(config.cli, 'grok');
  assert.equal(config.outputFormat, 'streaming-messages-json');
  assert.equal(config.configurationDirectory, grokSignIn);
  assert.ok(config.executable.startsWith(stateRoot) && config.executable.includes('grok-build'));
  assert.equal(readFileSync(config.executable, 'utf8'), 'fake-grok-binary');
  assert.ok(config.deniedParentPaths.includes(claudeSignIn), 'a Grok worker cannot read the Claude sign-in');
  assert.ok(!config.deniedParentPaths.includes(grokSignIn), 'a Grok worker keeps its own sign-in');
  assert.equal(config.apiKeyAuthenticationAllowed, false);
  const environment = buildClaudeEnvironment({ ...config, containedUserProfile: join(root, 'profile') }, config.configurationDirectory);
  assert.equal(environment.GROK_HOME, grokSignIn);
  assert.equal(environment.XAI_API_KEY, undefined);
});

test('every provider sign-in folder is private to other workers, and Grok is a declared data flow', () => {
  const home = join(tmpdir(), 'sensitive-home');
  const present = (path) => ['.codex', '.claude', '.grok'].some((folder) => path === join(home, folder));
  const denied = defaultSensitivePaths(home, join(home, 'Projects', 'app'), present);
  for (const folder of ['.codex', '.claude', '.grok']) assert.ok(denied.includes(join(home, folder)), folder);
  const flows = join(import.meta.dirname, '..', 'agent-package', 'privacy-flows.json');
  for (const provider of WORKER_PROVIDERS) assert.doesNotThrow(() => assertSubscriptionProviderDeclared(provider.id, flows));
});

test('Grok usage-limit wording pauses or switches like the others', () => {
  assert.ok(detectUsageLimit('Error: Grok usage limit reached for your SuperGrok plan'));
  assert.equal(detectUsageLimit('grok: 3 tests failed'), null);
});
