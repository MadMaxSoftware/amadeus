/** Run Claude host lifecycle and signed-in worker tests without C:\ realpath. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let root = process.cwd();
try {
  mkdirSync(join(root, '.tmp', 'claude-host-test-temp'), { recursive: true });
  mkdirSync(join(root, 'verification', 'tmp'), { recursive: true });
} catch (error) {
  if (!['EPERM', 'EACCES', 'EROFS'].includes(error?.code)) throw error;
  // Read-only worker workspace: these tests write beside the repository, so
  // run them from a private copy in the sandbox's own temp directory. Worker
  // metadata stays behind; it is denied or irrelevant to these suites.
  const source = root;
  root = mkdtempSync(join(tmpdir(), 'amadeus-claude-host-'));
  cpSync(source, root, {
    recursive: true,
    filter: (path) => {
      const top = relative(source, path).split(sep)[0];
      return !['.git', '.worker-isolation.json', '.tmp', 'verification', 'node_modules'].includes(top);
    },
  });
  const fixture = root;
  process.on('exit', () => {
    process.chdir(dirname(fixture)); // Windows cannot remove the current directory.
    rmSync(fixture, { recursive: true, force: true });
  });
  process.chdir(root);
  mkdirSync(join(root, '.tmp', 'claude-host-test-temp'), { recursive: true });
  mkdirSync(join(root, 'verification', 'tmp'), { recursive: true });
}
const temporary = join(root, '.tmp', 'claude-host-test-temp');
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

for (const path of [
  'test/claude-host-lifecycle.test.mjs',
  'test/claude-signed-in-worker.test.mjs',
  'test/local-checkpoint-handoff.test.mjs',
]) {
  await import(pathToFileURL(join(root, path)).href);
}
