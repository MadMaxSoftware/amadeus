/** Run reporting tests from a fixture when Node cannot realpath C:\. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.cwd();
const temporaryRoot = join(source, '.tmp', 'reporting-gate');
mkdirSync(temporaryRoot, { recursive: true });
const fixture = mkdtempSync(join(temporaryRoot, 'amadeus-reporting-gate-'));

function installRepositoryHooks(rootPath) {
  const prefix = pathToFileURL(`${rootPath}/`).href;
  registerHooks({
    resolve(specifier, context, next) {
      const url = specifier.startsWith('file:') ? specifier
        : /^\.\.?\//.test(specifier) && context.parentURL?.startsWith(prefix)
          ? new URL(specifier, context.parentURL).href
          : null;
      if (url?.startsWith(prefix)) return { url, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(prefix) && /\.(?:mjs|ts)$/.test(url)) {
        const sourceText = readFileSync(fileURLToPath(url), 'utf8');
        return {
          format: 'module',
          source: url.endsWith('.ts') ? stripTypeScriptTypes(sourceText) : sourceText,
          shortCircuit: true,
        };
      }
      return next(url, context);
    },
  });
}

function childNodeOptions(rootPath) {
  const childHook = `import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs'; import {fileURLToPath,pathToFileURL} from 'node:url';
(${installRepositoryHooks.toString()})(${JSON.stringify(rootPath)});`;
  return `--preserve-symlinks-main --preserve-symlinks --import=data:text/javascript;base64,${Buffer.from(childHook).toString('base64')}`;
}

try {
  for (const path of ['src', 'config-templates', 'plugins/amadeus', 'test/completion-reporting.test.mjs', 'package.json']) {
    const target = join(fixture, path);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(source, path), target, { recursive: true });
  }
  mkdirSync(join(fixture, '.tmp'), { recursive: true });
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', 'test/completion-reporting.test.mjs'], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_OPTIONS: childNodeOptions(fixture),
      AMADEUS_WORKER: '',
      TEMP: join(fixture, '.tmp'),
      TMP: join(fixture, '.tmp'),
      TMPDIR: join(fixture, '.tmp'),
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
