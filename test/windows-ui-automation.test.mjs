import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseWindowsUiObjective,
  runWindowsUiPlan,
  validateWindowsUiPlan,
} from '../src/windows-ui-automation.ts';
import { deterministicCommand, selectWorkRoute } from '../src/work-routing.ts';

const safePlan = (overrides = {}) => ({
  schemaVersion: 1,
  application: { vendor: 'ZEISS', processName: 'ZEISSInspect.exe', windowTitleContains: 'ZEISS INSPECT' },
  timeoutMs: 5000,
  controls: [{ key: 'help', automationId: 'HelpButton', name: 'Help', actions: ['invoke', 'setValue'] }],
  actions: [{ type: 'inspect' }, { type: 'focus' }],
  ...overrides,
});

function fixture(plan = safePlan()) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-uia-'));
  const directory = join(root, '.amadeus', 'ui-plans');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'zeiss.json'), JSON.stringify(plan));
  const script = join(root, 'windows-ui-automation.ps1');
  writeFileSync(script, '# fixed test helper');
  return { root, script };
}

test('only exact workspace-local Windows UI plan objectives route to ordinary software', () => {
  assert.equal(parseWindowsUiObjective('inspect ZEISS UI plan .amadeus/ui-plans/zeiss.json'), 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json');
  assert.equal(parseWindowsUiObjective('execute Windows UI plan `.amadeus/ui-plans/zeiss.json`'), 'windows-ui-execute:.amadeus/ui-plans/zeiss.json');
  assert.equal(parseWindowsUiObjective('click the ZEISS window'), undefined);
  assert.equal(parseWindowsUiObjective('execute Windows UI plan ../zeiss.json'), undefined);
  assert.equal(deterministicCommand('inspect ZEISS UI plan .amadeus/ui-plans/zeiss.json'), 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json');
});

test('generic UI plans accept arbitrary applications and standard UI actions', () => {
  const generic = validateWindowsUiPlan(safePlan({ application: { vendor: 'Microsoft', processName: 'notepad.exe', windowTitleContains: 'Untitled - Notepad' } }), 'inspect');
  assert.equal(generic.application.processName, 'notepad.exe');
  const shell = validateWindowsUiPlan(safePlan({ application: { vendor: 'Microsoft', processName: 'powershell.exe', windowTitleContains: 'Windows PowerShell' } }), 'inspect');
  assert.equal(shell.application.processName, 'powershell.exe');
  const text = validateWindowsUiPlan(safePlan({ actions: [{ type: 'setValue', control: 'help', value: 'AI-directed text' }] }), 'execute');
  assert.equal(text.actions[0].value, 'AI-directed text');
  assert.throws(() => validateWindowsUiPlan(safePlan({ actions: [{ type: 'invoke', control: 'missing' }] }), 'inspect'), /does not allow/);
});

test('Windows UI inspection is bounded, no-model, and invokes only the fixed helper', () => {
  const { root, script } = fixture();
  let observed;
  const result = runWindowsUiPlan(root, 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json', {
    platform: 'win32', scriptPath: script, execute(executable, args, options) {
      observed = { executable, args, options };
      return '{"action":"inspect","window":"ZEISS INSPECT"}\n';
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.mode, 'inspect');
  assert.equal(result.evidence.length, 1);
  assert.equal(observed.executable, 'powershell.exe');
  assert.ok(observed.args.includes('-NoProfile'));
  assert.ok(observed.args.includes(script));
  assert.equal(observed.options.timeout, 5000);
});

test('unavailable capability and timeouts fail closed without a model fallback', () => {
  const { root, script } = fixture();
  assert.equal(runWindowsUiPlan(root, 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json', { platform: 'linux', scriptPath: script }).status, 'unavailable');
  const result = runWindowsUiPlan(root, 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json', {
    platform: 'win32', scriptPath: script, execute() { const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.timedOut, true);
  assert.match(result.summary, /bounded timeout/);
  const rejected = runWindowsUiPlan(root, 'windows-ui-inspect:.amadeus/ui-plans/missing.json', { platform: 'win32', scriptPath: script });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.summary, /rejected before launch/);
});

test('an exact ZEISS plan outranks subscription providers while ordinary goals stay unchanged', () => {
  const catalog = { fetchedAt: 'fixture', models: [{ slug: 'efficient', priority: 1, supportedEfforts: ['low'] }] };
  const route = selectWorkRoute({ objective: 'inspect ZEISS UI plan .amadeus/ui-plans/zeiss.json', cursorInstalled: true, catalog,
    desktopAutomationAllowed: true });
  assert.equal(route.provider, 'software');
  assert.equal(route.command, 'windows-ui-inspect:.amadeus/ui-plans/zeiss.json');
  assert.equal(selectWorkRoute({ objective: 'Implement a feature', cursorInstalled: true, catalog }).provider, 'cursor-browser-login');
});

test('the same deterministic route accepts non-ZEISS Windows applications', () => {
  assert.equal(parseWindowsUiObjective('inspect Windows UI plan .amadeus/ui-plans/notepad.json'), 'windows-ui-inspect:.amadeus/ui-plans/notepad.json');
  assert.equal(parseWindowsUiObjective('execute Notepad Windows UI plan .amadeus/ui-plans/notepad.json'), 'windows-ui-execute:.amadeus/ui-plans/notepad.json');
});

test('a Windows UI plan drives the desktop only when the owner wrote the objective', () => {
  const catalog = { fetchedAt: 'fixture', models: [{ slug: 'efficient', priority: 1, supportedEfforts: ['low'] }] };
  const objective = 'execute Windows UI plan .amadeus/ui-plans/notepad.json';
  // A worker-proposed continuation (or any caller that does not opt in) stays sandboxed model work.
  for (const input of [{}, { desktopAutomationAllowed: false }]) {
    const route = selectWorkRoute({ objective, cursorInstalled: true, catalog, ...input });
    assert.notEqual(route.provider, 'software');
    assert.equal(route.command, undefined);
  }
  assert.equal(selectWorkRoute({ objective, cursorInstalled: true, catalog, desktopAutomationAllowed: true }).command,
    'windows-ui-execute:.amadeus/ui-plans/notepad.json');
  // Ordinary deterministic test commands are unaffected.
  assert.equal(selectWorkRoute({ objective: 'run npm test', cursorInstalled: true, catalog }).command, 'npm-test');
});
