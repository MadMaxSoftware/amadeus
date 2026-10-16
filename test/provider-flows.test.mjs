import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSubscriptionProviderDeclared, privacyFlowsPath } from '../src/provider-flows.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const providers = ['codex-chatgpt-signin', 'cursor-browser-login', 'claude-subscription-signin'];

test('every packaged runtime finds a registry that declares all subscription providers', () => {
  for (const runtimeRoot of [repoRoot, join(repoRoot, 'plugins', 'amadeus', 'runtime'), join(repoRoot, 'claude-plugin', 'runtime')]) {
    const flows = privacyFlowsPath(runtimeRoot);
    assert.ok(flows, `no registry found for ${runtimeRoot}`);
    for (const provider of providers) assertSubscriptionProviderDeclared(provider, flows);
  }
});

test('undeclared providers and a missing registry fail closed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-flows-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flows = join(dir, 'privacy-flows.json');
  writeFileSync(flows, JSON.stringify({ defaultDecision: 'deny', flows: [
    { id: 'subscription-provider-execution', allowedOrigins: ['codex-chatgpt-signin'] },
  ] }));
  assertSubscriptionProviderDeclared('codex-chatgpt-signin', flows);
  assert.throws(() => assertSubscriptionProviderDeclared('claude-subscription-signin', flows), /not declared/);
  assert.throws(() => assertSubscriptionProviderDeclared('codex-chatgpt-signin', null), /not found/);
});
