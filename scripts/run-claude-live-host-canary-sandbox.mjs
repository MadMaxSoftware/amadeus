/** Live Claude host canary without C:\ realpath on the entry script. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const temporary = join(root, '.tmp', 'claude-live-host-temp');
mkdirSync(temporary, { recursive: true });
mkdirSync(join(root, 'verification', 'claude-live-host'), { recursive: true });
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

const { runClaudeLiveHostCanary } = await import(pathToFileURL(join(root, 'scripts/claude-live-host-canary.mjs')).href);
const workRoot = join(temporary, `work-${Date.now()}`);
const evidence = runClaudeLiveHostCanary({
  repository: root,
  evidenceDir: join(root, 'verification', 'claude-live-host'),
  workRoot,
  keepWorkRoot: true,
});
process.stdout.write(`${JSON.stringify({
  ok: evidence.ok,
  outcome: evidence.outcome,
  criteria: evidence.criteria,
  evidencePath: evidence.evidencePath,
  listedEnabled: evidence.listedEnabled,
  enabledInSettings: evidence.enabledInSettings,
  installOk: evidence.installOk,
  session: evidence.session,
  engine: evidence.engine,
}, null, 2)}\n`);
process.exitCode = evidence.ok ? 0 : 1;
