import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedWorkerEnvironment } from '../src/codex-adapter.ts';
import { buildCursorEnvironment } from '../src/cursor-adapter.ts';
import { isCredentialVariable } from '../src/worker-environment.ts';

const SECRETS = {
  GITHUB_TOKEN: 'x', GH_TOKEN: 'x', NPM_TOKEN: 'x', NODE_AUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x',
  CODEX_API_KEY: 'x', CURSOR_API_KEY: 'x', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', AWS_SESSION_TOKEN: 'x',
  AZURE_CLIENT_SECRET: 'x', GOOGLE_APPLICATION_CREDENTIALS: 'x', HF_TOKEN: 'x', DB_PASSWORD: 'x', SSH_AUTH_SOCK: 'x',
};
const ORDINARY = { PATH: process.env.PATH ?? 'p', TOKENIZERS_PARALLELISM: 'false', SECRETS_DIR_HINT: 'kept', LANG: 'C' };

function withEnvironment(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('credential variable names are recognised without catching ordinary ones', () => {
  for (const name of Object.keys(SECRETS)) assert.equal(isCredentialVariable(name), true, name);
  for (const name of ['PATH', 'TOKENIZERS_PARALLELISM', 'SECRETS_DIR_HINT', 'NODE_OPTIONS', 'USERPROFILE', 'CI']) {
    assert.equal(isCredentialVariable(name), false, name);
  }
});

test('Codex workers and sandbox commands do not inherit host credentials', () => {
  const environment = withEnvironment({ ...SECRETS, ...ORDINARY }, () => isolatedWorkerEnvironment({ NODE_OPTIONS: '--x' }));
  for (const name of Object.keys(SECRETS)) assert.equal(environment[name], undefined, name);
  assert.equal(environment.TOKENIZERS_PARALLELISM, 'false');
  assert.equal(environment.LANG, 'C');
  assert.equal(environment.NODE_OPTIONS, '--x');
  assert.equal(environment.AMADEUS_WORKER, '1');
});

test('Cursor workers do not inherit host credentials', () => {
  const config = { authenticationFile: 'C:\\Users\\u\\AppData\\Roaming\\Cursor\\auth.json', configurationDirectory: 'C:\\w\\.cfg',
    containedUsername: 'u', containedUserProfile: 'C:\\w\\profile', pathVerifierShim: 'C:\\w\\shim.cjs' };
  const environment = withEnvironment({ ...SECRETS, ...ORDINARY }, () => buildCursorEnvironment(config, config.configurationDirectory, 'C:\\w'));
  for (const name of Object.keys(SECRETS)) assert.equal(environment[name], undefined, name);
  assert.equal(environment.LANG, 'C');
  assert.equal(environment.CI, '1');
});
