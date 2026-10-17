/**
 * Regenerate every packaged copy (plugins/amadeus, its runtime, claude-plugin) from the
 * sources, in a form that runs inside the worker sandbox. Declared as the build step in
 * .amadeus/verify.json, so the coordinator runs it before verification and workers that
 * change src/ do not have to.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(join(process.cwd(), 'scripts', 'run-packaged-tests-sandbox.mjs'), 'utf8');
// Piped on stdin like the npm script does, so Node never realpath()s an entry file.
const result = spawnSync(process.execPath, ['--input-type=module'], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_OPTIONS: '', AMADEUS_PACKAGE_BUILD: '1' },
  input: runner,
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: 300000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
