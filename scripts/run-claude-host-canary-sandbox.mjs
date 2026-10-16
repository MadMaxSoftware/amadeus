/** Version-bound Claude host canary without C:\ realpath on the entry script. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const temporary = join(root, '.tmp', 'claude-canary-temp');
mkdirSync(temporary, { recursive: true });
mkdirSync(join(root, 'verification', 'tmp'), { recursive: true });
mkdirSync(join(root, 'verification', 'claude-canary'), { recursive: true });
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
const { runClaudeHostCanary } = await import(pathToFileURL(join(root, 'scripts/claude-host-canary.mjs')).href);
const evidence = runClaudeHostCanary({
  repository: root,
  evidenceDir: join(root, 'verification', 'claude-canary'),
});
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode = 0;
