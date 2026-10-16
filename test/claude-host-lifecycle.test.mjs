import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stageClaudePackage } from '../scripts/build-claude-package.mjs';
import {
  disableClaudeHost,
  installClaudeHost,
  preflightClaudeHost,
  rollbackClaudeHost,
  uninstallClaudeHost,
  updateClaudeHost,
} from '../scripts/claude-host-lifecycle.mjs';
import { runClaudeHostCanary } from '../scripts/claude-host-canary.mjs';
import { readPluginVersion } from '../plugins/amadeus/scripts/amadeus-lifecycle.mjs';

function tempRoot(label) {
  const root = join(process.cwd(), 'verification', 'tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, label));
}

test('Claude host preflight reports missing CLI honestly without enabling a worker', () => {
  const result = preflightClaudeHost({
    env: { ...process.env, CLAUDE_EXECUTABLE: '', PATH: '' },
    runCommand: () => ({ status: 1, stdout: '', stderr: 'not found', error: null }),
  });
  assert.equal(result.available, false);
  assert.equal(result.claudeInstalled, false);
  assert.equal(result.workerEnabled, false);
  assert.equal(result.billing, 'subscription-signin-only');
  assert.ok(result.checks.some((check) => check.name === 'claude-cli' && check.ok === false));
});

test('Claude host preflight resolves the official Windows npm shim to its native executable', () => {
  const temporary = tempRoot('claude-windows-shim-');
  try {
    const shim = join(temporary, 'claude');
    const native = join(temporary, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(shim, 'npm shim fixture');
    writeFileSync(native, 'native fixture');
    const preflight = preflightClaudeHost({
      env: { ...process.env, CLAUDE_EXECUTABLE: shim, PATH: '' },
      runCommand: (executable, args = []) => {
        assert.equal(executable, native);
        if (args[0] === '--version') return { status: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '', error: null };
        return { status: 0, stdout: 'install update uninstall enable disable list\n', stderr: '', error: null };
      },
    });
    assert.equal(preflight.available, true);
    assert.equal(preflight.executable, native);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude host install/update/rollback/disable/uninstall preserve foreign settings and never enable workers', () => {
  const temporary = tempRoot('claude-host-');
  try {
    const candidate = join(temporary, 'candidate');
    const claudeHome = join(temporary, 'claude-home');
    const projectRoot = join(temporary, 'project');
    const stateRoot = join(temporary, 'amadeus-state');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, 'coordinator.sqlite'), 'preserve-me');
    const manifest = stageClaudePackage(process.cwd(), candidate);
    const settingsDir = join(projectRoot, '.claude');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.local.json'), `${JSON.stringify({
      theme: 'dark',
      enabledPlugins: { 'other@marketplace': true },
    }, null, 2)}\n`);

    const installed = installClaudeHost({
      mode: 'filesystem-mirror',
      candidateDirectory: candidate,
      claudeHome,
      projectRoot,
      stateRoot,
      scope: 'local',
      enable: true,
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.workerEnabled, false);
    assert.equal(installed.credentialsCopied, false);
    assert.equal(installed.billing, 'subscription-signin-only');
    assert.ok(existsSync(join(installed.cacheRoot, '.claude-plugin', 'plugin.json')));
    assert.equal(existsSync(join(stateRoot, 'coordinator.sqlite')), true);
    assert.equal(readFileSync(join(stateRoot, 'coordinator.sqlite'), 'utf8'), 'preserve-me');

    const settings = JSON.parse(readFileSync(installed.settingsPath, 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.enabledPlugins['other@marketplace'], true);
    assert.equal(settings.enabledPlugins['amadeus@amadeus'], true);

    writeFileSync(join(installed.cacheRoot, 'scripts', 'server.mjs'), 'tampered-for-rollback');
    const updated = updateClaudeHost({
      mode: 'filesystem-mirror',
      candidateDirectory: candidate,
      claudeHome,
      projectRoot,
      scope: 'local',
      rollbackDirectory: join(temporary, 'rollback'),
    });
    assert.equal(updated.ok, true);
    assert.ok(updated.rollbackDirectory);
    assert.equal(updated.workerEnabled, false);

    const rolled = rollbackClaudeHost({
      claudeHome,
      version: manifest.version,
      rollbackDirectory: updated.rollbackDirectory,
    });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.workerEnabled, false);

    const disabled = disableClaudeHost({ mode: 'filesystem-mirror', claudeHome, projectRoot, scope: 'local' });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    assert.equal(JSON.parse(readFileSync(installed.settingsPath, 'utf8')).enabledPlugins['amadeus@amadeus'], false);
    assert.equal(JSON.parse(readFileSync(installed.settingsPath, 'utf8')).theme, 'dark');

    const removed = uninstallClaudeHost({
      mode: 'filesystem-mirror',
      claudeHome,
      projectRoot,
      scope: 'local',
      version: manifest.version,
      keepData: false,
    });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(installed.cacheRoot), false);
    assert.equal(JSON.parse(readFileSync(installed.settingsPath, 'utf8')).theme, 'dark');
    assert.equal(JSON.parse(readFileSync(installed.settingsPath, 'utf8')).enabledPlugins?.['amadeus@amadeus'], undefined);
    assert.equal(removed.workerEnabled, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude host CLI mode fails closed when preflight is unavailable and readPluginVersion accepts Claude manifests', () => {
  const temporary = tempRoot('claude-cli-');
  try {
    const candidate = join(temporary, 'candidate');
    stageClaudePackage(process.cwd(), candidate);
    const result = installClaudeHost({
      mode: 'cli',
      candidateDirectory: candidate,
      claudeHome: join(temporary, 'home'),
      projectRoot: join(temporary, 'project'),
      scope: 'local',
      env: { PATH: '' },
      runCommand: () => ({ status: 1, stdout: '', stderr: 'missing', error: null }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.workerEnabled, false);
    assert.equal(readPluginVersion(candidate), JSON.parse(readFileSync(join(candidate, '.claude-plugin', 'plugin.json'), 'utf8')).version);
    assert.throws(() => {
      mkdirSync(join(candidate, '.codex-plugin'), { recursive: true });
      writeFileSync(join(candidate, '.codex-plugin', 'plugin.json'), '{"version":"0.0.0"}');
      readPluginVersion(candidate);
    }, /Ambiguous/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude host CLI mode uses a marketplace directory and enable/list verbs', () => {
  const temporary = tempRoot('claude-cli-market-');
  try {
    const candidate = join(temporary, 'candidate');
    const marketplace = join(temporary, 'marketplace');
    const projectRoot = join(temporary, 'project');
    const fakeClaude = join(temporary, 'claude.exe');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(fakeClaude, 'fake-claude');
    stageClaudePackage(process.cwd(), candidate);
    const calls = [];
    const result = installClaudeHost({
      mode: 'cli',
      candidateDirectory: candidate,
      marketplaceDirectory: null,
      autoMarketplaceDirectory: marketplace,
      repositoryRoot: process.cwd(),
      claudeHome: join(temporary, 'home'),
      projectRoot,
      scope: 'local',
      enable: true,
      env: { ...process.env, PATH: temporary, CLAUDE_EXECUTABLE: fakeClaude },
      runCommand: (executable, args = []) => {
        assert.equal(executable, fakeClaude);
        calls.push(args.join(' '));
        if (args.includes('--version') || args[0] === '--version') {
          return { status: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '', error: null };
        }
        if (args.includes('--help')) {
          return { status: 0, stdout: 'install update uninstall enable disable list\n', stderr: '', error: null };
        }
        if (args.includes('marketplace') && args.includes('add')) {
          assert.ok(args.includes('--settings'));
          assert.ok(args.some((value) => String(value).includes('marketplace')));
          return { status: 0, stdout: `${JSON.stringify({ command: 'marketplace-add', outcome: 'ok' })}\n`, stderr: '', error: null };
        }
        if (args.includes('install')) {
          assert.ok(args.includes('--marketplace'));
          return { status: 0, stdout: `${JSON.stringify({ command: 'install', outcome: 'ok' })}\n`, stderr: '', error: null };
        }
        if (args.includes('enable')) {
          return { status: 0, stdout: `${JSON.stringify({ command: 'enable', outcome: 'ok' })}\n`, stderr: '', error: null };
        }
        if (args.includes('list')) {
          return {
            status: 0,
            stdout: `${JSON.stringify([{ id: 'amadeus@amadeus', enabled: true, version: '0.3.8' }])}\n`,
            stderr: '',
            error: null,
          };
        }
        return { status: 0, stdout: '', stderr: '', error: null };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.listedEnabled, true);
    assert.equal(result.workerEnabled, false);
    assert.ok(existsSync(join(marketplace, '.claude-plugin', 'marketplace.json')));
    assert.ok(calls.some((line) => line.includes('marketplace add')));
    assert.ok(calls.some((line) => line.includes('--marketplace')));
    assert.ok(calls.some((line) => /\bplugin enable\b/.test(line) || line.includes('enable amadeus@amadeus')));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude host canary records absence honestly and never claims support', () => {
  const temporary = tempRoot('claude-canary-');
  try {
    const evidence = runClaudeHostCanary({
      repository: process.cwd(),
      evidenceDir: temporary,
      env: { ...process.env, CLAUDE_EXECUTABLE: '', PATH: '' },
      runCommand: () => ({ status: 1, stdout: '', stderr: 'absent', error: null }),
    });
    assert.equal(evidence.supportClaim, false);
    assert.equal(evidence.liveSession, false);
    assert.equal(evidence.signedInWorkerDispatched, false);
    assert.equal(evidence.apiBillingUsed, false);
    assert.equal(evidence.credentialsCopied, false);
    assert.equal(evidence.auth?.loggedIn, false);
    assert.match(evidence.outcome, /absent|unavailable/i);
    assert.equal(existsSync(evidence.evidencePath), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude host canary records present CLI that is not signed in without claiming support', () => {
  const temporary = tempRoot('claude-canary-auth-');
  try {
    const evidence = runClaudeHostCanary({
      repository: process.cwd(),
      evidenceDir: temporary,
      env: { ...process.env, CLAUDE_EXECUTABLE: 'C:\\tools\\claude.exe', PATH: '' },
      runCommand: (_exe, args = []) => {
        if (args[0] === '--version') return { status: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '', error: null };
        if (args[0] === 'plugin') return { status: 0, stdout: 'install update uninstall enable disable list\n', stderr: '', error: null };
        if (args[0] === 'auth') {
          return {
            status: 1,
            stdout: `${JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })}\n`,
            stderr: '',
            error: null,
          };
        }
        return { status: 0, stdout: 'C:\\tools\\claude.exe\n', stderr: '', error: null };
      },
    });
    assert.equal(evidence.preflight.available, true);
    assert.equal(evidence.auth.loggedIn, false);
    assert.equal(evidence.supportClaim, false);
    assert.match(evidence.outcome, /not-signed-in/i);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
