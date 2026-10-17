/** Run the package gate from a temporary fixture when Node cannot realpath C:\. */
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

const fixture = scratchFixture('packaged-gate', 'amadeus-package-gate-');

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
  for (const path of [
    'src', 'config-templates', 'agent-package', 'plugins/amadeus', 'host-fixtures/claude-code',
    'claude-plugin', '.claude-plugin/marketplace.json', 'marketplace.json',
    'test/amadeus-release.test.mjs', 'test/agent-package.test.mjs', 'test/claude-static-parity.test.mjs',
    'test/claude-package.test.mjs', 'scripts/build-claude-package.mjs', 'scripts/build-agent-package.mjs',
    'scripts/build-plugin-runtime.mjs', 'scripts/spawn-repo-module.mjs', 'package.json',
  ]) {
    const target = join(fixture, path);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(source, path), target, { recursive: true });
  }

  const env = {
    ...process.env,
    NODE_OPTIONS: childNodeOptions(fixture),
    AMADEUS_WORKER: '',
    TEMP: join(fixture, '.tmp'),
    TMP: join(fixture, '.tmp'),
    TMPDIR: join(fixture, '.tmp'),
  };
  mkdirSync(join(fixture, '.tmp'), { recursive: true });

  const build = process.env.AMADEUS_PACKAGE_BUILD === '1';
  // Build mode regenerates every packaged copy and copies it back; check mode verifies them and runs the package tests.
  const steps = build ? [
    ['scripts/build-agent-package.mjs'],
    ['scripts/build-plugin-runtime.mjs'],
    ['scripts/build-claude-package.mjs', '--publish'],
  ] : [
    ['scripts/build-agent-package.mjs', '--check'],
    ['scripts/build-plugin-runtime.mjs', '--check'],
    ['scripts/build-claude-package.mjs', '--check-published'],
    ['--test', 'test/amadeus-release.test.mjs', 'test/agent-package.test.mjs', 'test/claude-static-parity.test.mjs', 'test/claude-package.test.mjs'],
  ];
  for (const args of steps) {
    // Prefer -e dynamic import so argv paths never go through Node's main-module realpath.
    const absolute = args[0].startsWith('--')
      ? null
      : join(fixture, args[0]);
    const spawnArgs = absolute
      ? [
        '--input-type=module',
        '-e',
        [
          `import { pathToFileURL as toUrl } from 'node:url';`,
          `const entry = ${JSON.stringify(absolute)};`,
          `process.argv = [process.execPath, entry, ...${JSON.stringify(args.slice(1))}];`,
          `await import(toUrl(entry).href);`,
        ].join('\n'),
      ]
      : args;
    const result = spawnSync(process.execPath, spawnArgs, {
      cwd: fixture,
      env,
      encoding: 'utf8',
      timeout: 120000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    if (build && args[0] === 'scripts/build-agent-package.mjs') {
      cpSync(join(fixture, 'plugins', 'amadeus'), join(source, 'plugins', 'amadeus'), { recursive: true });
    }
    if (build && args[0] === 'scripts/build-plugin-runtime.mjs') {
      // The runtime copy is fully generated: replace it so files removed from src/ disappear too.
      rmSync(join(source, 'plugins', 'amadeus', 'runtime'), { recursive: true, force: true });
      cpSync(join(fixture, 'plugins', 'amadeus', 'runtime'), join(source, 'plugins', 'amadeus', 'runtime'), { recursive: true });
    }
    if (build && args[0] === 'scripts/build-claude-package.mjs') {
      rmSync(join(source, 'claude-plugin'), { recursive: true, force: true });
      cpSync(join(fixture, 'claude-plugin'), join(source, 'claude-plugin'), { recursive: true });
      cpSync(join(fixture, '.claude-plugin', 'marketplace.json'), join(source, '.claude-plugin', 'marketplace.json'));
    }
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
