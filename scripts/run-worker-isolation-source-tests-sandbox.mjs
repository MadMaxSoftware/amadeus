/** Run worker-isolation source tests from a workspace fixture when Node cannot realpath C:\. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.cwd();

/** Prefer workspace scratch; read-only worker workspaces use the sandbox's private temp. */
function scratchFixture(label, prefix) {
  try {
    const temporaryRoot = join(source, '.tmp', label);
    mkdirSync(temporaryRoot, { recursive: true });
    return mkdtempSync(join(temporaryRoot, prefix));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EROFS'].includes(error?.code)) throw error;
    return mkdtempSync(join(tmpdir(), prefix));
  }
}

const fixture = scratchFixture('isolation-gate', 'amadeus-isolation-test-');

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
        const text = readFileSync(fileURLToPath(url), 'utf8');
        return {
          format: 'module',
          source: url.endsWith('.ts') ? stripTypeScriptTypes(text) : text,
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
  for (const path of ['src/worker-isolation.ts', 'test/worker-isolation-source.test.mjs']) {
    const target = join(fixture, path);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(source, path), target);
  }
  mkdirSync(join(fixture, '.tmp'), { recursive: true });
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', 'test/worker-isolation-source.test.mjs'], {
    cwd: fixture,
    env: {
      ...process.env,
      NODE_OPTIONS: childNodeOptions(fixture),
      TEMP: join(fixture, '.tmp'),
      TMP: join(fixture, '.tmp'),
      TMPDIR: join(fixture, '.tmp'),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
