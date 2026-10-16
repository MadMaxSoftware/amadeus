/** Focused Claude-milestone validation without C:\ realpath. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const temporary = join(root, '.tmp', 'focused-validation-temp');
mkdirSync(temporary, { recursive: true });
mkdirSync(join(root, 'verification', 'tmp'), { recursive: true });
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.TMPDIR = temporary;

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
        const source = readFileSync(fileURLToPath(url), 'utf8');
        return {
          format: 'module',
          source: url.endsWith('.ts') ? stripTypeScriptTypes(source) : source,
          shortCircuit: true,
        };
      }
      return next(url, context);
    },
  });
}

installRepositoryHooks(root);
const childHook = `import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs'; import {fileURLToPath,pathToFileURL} from 'node:url';
(${installRepositoryHooks.toString()})(${JSON.stringify(root)});`;
process.env.NODE_OPTIONS = `--preserve-symlinks-main --preserve-symlinks --import=data:text/javascript;base64,${Buffer.from(childHook).toString('base64')}`;

// Rebuild/verify runtime with cwd-safe packager.
{
  const code = readFileSync(join(root, 'verification/build-runtime-cwd.mjs'), 'utf8');
  process.argv = [process.execPath, join(root, 'verification/build-runtime-cwd.mjs')];
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

for (const path of [
  'test/claude-static-parity.test.mjs',
  'test/claude-package.test.mjs',
  'test/claude-host-lifecycle.test.mjs',
  'test/claude-signed-in-worker.test.mjs',
  'test/local-checkpoint-handoff.test.mjs',
]) {
  await import(pathToFileURL(join(root, path)).href);
}

const canary = await import(pathToFileURL(join(root, 'scripts/claude-host-canary.mjs')).href);
const evidence = canary.runClaudeHostCanary({ repository: root, evidenceDir: join(root, 'verification', 'claude-canary') });
console.log('CANARY', JSON.stringify({
  outcome: evidence.outcome,
  supportClaim: evidence.supportClaim,
  available: evidence.preflight?.available,
  version: evidence.preflight?.version,
}));
