/** Run clean-machine tests from a workspace fixture when Node cannot realpath C:\. */
import { registerHooks } from 'node:module';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const temporaryRoot = join(root, '.tmp', 'clean-machine-gate');
mkdirSync(temporaryRoot, { recursive: true });
const fixture = mkdtempSync(join(temporaryRoot, 'amadeus-clean-test-runner-'));

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
      if (url.startsWith(prefix) && /\.mjs$/.test(url)) {
        return {
          format: 'module',
          source: readFileSync(fileURLToPath(url), 'utf8'),
          shortCircuit: true,
        };
      }
      return next(url, context);
    },
  });
}

function childNodeOptions(rootPath) {
  const childHook = `import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs'; import {fileURLToPath,pathToFileURL} from 'node:url';
(${installRepositoryHooks.toString()})(${JSON.stringify(rootPath)});`;
  return `--preserve-symlinks-main --preserve-symlinks --import=data:text/javascript;base64,${Buffer.from(childHook).toString('base64')}`;
}

try {
  const source = join(fixture, 'source');
  mkdirSync(join(source, 'test'), { recursive: true });
  mkdirSync(join(source, 'scripts'), { recursive: true });
  mkdirSync(join(source, '.tmp'), { recursive: true });
  cpSync(join(root, 'plugins', 'amadeus'), join(source, 'plugins', 'amadeus'), { recursive: true });
  cpSync(join(root, 'scripts', 'install-dependencies.mjs'), join(source, 'scripts', 'install-dependencies.mjs'));
  cpSync(join(root, 'test', 'amadeus-clean-machine.test.mjs'), join(source, 'test', 'amadeus-clean-machine.test.mjs'));
  writeFileSync(join(source, 'package.json'), '{"type":"module"}\n');

  const result = spawnSync(process.execPath, [
    '--test',
    '--test-isolation=none',
    'test/amadeus-clean-machine.test.mjs',
  ], {
    cwd: source,
    env: {
      ...process.env,
      NODE_OPTIONS: childNodeOptions(source),
      TEMP: join(source, '.tmp'),
      TMP: join(source, '.tmp'),
      TMPDIR: join(source, '.tmp'),
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
