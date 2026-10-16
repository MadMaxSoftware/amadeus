import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishClaudeMarketplace, stageClaudeMarketplace, stageClaudePackage, verifyClaudePackage } from '../scripts/build-claude-package.mjs';
import { readPackagedRuntimeIdentity, resolveCoordinatorLayout } from '../plugins/amadeus/scripts/amadeus-runtime.mjs';
import { spawnRepoModule } from '../scripts/spawn-repo-module.mjs';

function rewriteTextTreeWithCrlf(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) rewriteTextTreeWithCrlf(path);
    else if (/\.(?:json|mjs|cjs|js|ts|md|ya?ml|txt|ps1)$/i.test(name)) {
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    }
  }
}

test('Claude staging is deterministic, self-contained, inert and uses the shared runtime', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'amadeus-claude-'));
  try {
    const first = join(temporary, 'first candidate'), second = join(temporary, 'second');
    const manifest = stageClaudePackage(process.cwd(), first);
    assert.deepEqual(stageClaudePackage(process.cwd(), second), manifest);
    assert.equal(verifyClaudePackage(first, manifest), true);
    rewriteTextTreeWithCrlf(second);
    assert.equal(verifyClaudePackage(second, manifest), true);
    assert.equal(existsSync(join(first, '.codex-plugin')), false);
    assert.equal(existsSync(join(first, 'config.json')), false);
    assert.equal(existsSync(join(first, 'skills/maestro/SKILL.md')), true);
    assert.deepEqual(readFileSync(join(first, 'runtime/manifest.json')), Buffer.from(readFileSync('plugins/amadeus/runtime/manifest.json', 'utf8').replaceAll('\r\n', '\n')));
    const metaUrl = pathToFileURL(join(first, 'scripts/amadeus-runtime.mjs')).href;
    assert.equal(readPackagedRuntimeIdentity(metaUrl).pluginVersion, manifest.version);
    const layout = resolveCoordinatorLayout({ metaUrl, configPath: join(temporary, 'absent.json'), env: {} });
    assert.equal(layout.coordinatorRoot, join(first, 'runtime'));
    assert.equal(layout.authority, 'packaged-runtime');
    const hook = JSON.parse(readFileSync(join(first, 'hooks/hooks.json')));
    assert.equal(hook.hooks.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
    const plugin = JSON.parse(readFileSync(join(first, '.claude-plugin/plugin.json')));
    assert.equal(plugin.displayName, 'Amadeus');
    // Preserve repository short-circuit hooks when present; strip host-injected require paths only.
    const nodeOptions = String(process.env.NODE_OPTIONS || '').split(/\s+/).filter((part) => part.startsWith('--import=data:') || part.startsWith('--preserve-symlinks')).join(' ');
    const env = { ...process.env, NODE_OPTIONS: nodeOptions, AMADEUS_WORKER: '1', AMADEUS_HOME: join(temporary, 'state'), AMADEUS_CONFIG: join(temporary, 'absent.json') };
    const result = spawnRepoModule(join(first, 'hooks/session-start.mjs'), { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /isolated Amadeus worker/);
    assert.equal(existsSync(env.AMADEUS_HOME), false);
    const input = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }].map(value => JSON.stringify(value)).join('\n') + '\n';
    const backend = spawnRepoModule(join(first, 'scripts/server.mjs'), { input, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(backend.status, 0, backend.stderr || backend.stdout);
    const messages = backend.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(messages.find(message => message.id === 2)?.result?.tools.some(tool => tool.name === 'amadeus_onboarding_status'));
    assert.equal(existsSync(env.AMADEUS_HOME), false);
    assert.throws(() => stageClaudePackage(process.cwd(), first), /EEXIST/);
    writeFileSync(join(first, 'scripts/server.mjs'), 'tampered');
    assert.throws(() => verifyClaudePackage(first, manifest), /integrity mismatch/);
    writeFileSync(join(second, 'unexpected.json'), '{}');
    assert.throws(() => verifyClaudePackage(second, manifest), /Unexpected candidate/);
    mkdirSync(join(first, '.codex-plugin'));
    writeFileSync(join(first, '.codex-plugin/plugin.json'), '{}');
    assert.throws(() => readPackagedRuntimeIdentity(metaUrl), /Ambiguous/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Claude marketplace staging embeds a plain candidate and marketplace manifest', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'amadeus-claude-market-'));
  try {
    const market = join(temporary, 'marketplace');
    const staged = stageClaudeMarketplace(process.cwd(), market);
    assert.equal(staged.marketplaceName, 'amadeus');
    assert.equal(staged.pluginId, 'amadeus@amadeus');
    assert.equal(existsSync(join(market, '.claude-plugin', 'marketplace.json')), true);
    assert.equal(existsSync(join(market, 'amadeus', '.claude-plugin', 'plugin.json')), true);
    assert.equal(existsSync(join(market, 'amadeus', '.codex-plugin')), false);
    const catalog = JSON.parse(readFileSync(join(market, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(catalog.name, 'amadeus');
    assert.equal(catalog.plugins[0].source, './amadeus');
    assert.equal(catalog.plugins[0].version, staged.manifest.version);
    const hook = JSON.parse(readFileSync(join(market, 'amadeus', 'hooks', 'hooks.json'), 'utf8'));
    assert.equal(hook.hooks.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
    assert.throws(() => stageClaudeMarketplace(process.cwd(), market), /already exists/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('published GitHub marketplace is complete and synchronized', () => {
  const result = publishClaudeMarketplace(process.cwd(), { check: true });
  assert.equal(result.checked, true);
  const catalog = JSON.parse(readFileSync(result.catalogPath, 'utf8'));
  assert.equal(catalog.name, 'amadeus');
  assert.equal(catalog.plugins[0].name, 'amadeus');
  assert.equal(catalog.plugins[0].source, './claude-plugin');
  assert.equal(catalog.plugins[0].version, result.manifest.version);
  assert.equal(existsSync(join(result.target, '.claude-plugin', 'plugin.json')), true);
  assert.equal(existsSync(join(result.target, '.codex-plugin')), false);
});

test('Claude staging refuses stale source and foreign files before writing', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'amadeus-claude-drift-'));
  try {
    const repo = join(temporary, 'repo'), target = join(temporary, 'candidate');
    mkdirSync(repo);
    for (const path of ['agent-package', 'plugins', 'src', 'config-templates', 'package.json']) cpSync(path, join(repo, path), { recursive: true });
    const source = join(repo, 'src/host-drivers.ts'), original = readFileSync(source);
    writeFileSync(source, 'stale');
    assert.throws(() => stageClaudePackage(repo, target), /Stale runtime/);
    assert.equal(existsSync(target), false);
    writeFileSync(source, original);
    const foreign = join(repo, 'plugins/amadeus/config.json');
    writeFileSync(foreign, '{}');
    assert.throws(() => stageClaudePackage(repo, target), /Unexpected public package/);
    assert.equal(existsSync(target), false);
    rmSync(foreign);
    await t.test('linked script directories are rejected', t => {
      const linked = join(repo, 'plugins/amadeus/scripts/linked');
      try { symlinkSync(join(repo, 'src'), linked, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host denies creation of link fixture; containment requires host verification');
        throw error;
      }
      try {
        assert.throws(() => stageClaudePackage(repo, target), /Linked package asset/);
        assert.equal(existsSync(target), false);
      } finally { unlinkSync(linked); }
    });
    writeFileSync(join(repo, 'agent-package/skills/maestro/SKILL.md'), 'drift');
    assert.throws(() => stageClaudePackage(repo, target), /Stale canonical/);
    assert.equal(existsSync(target), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
