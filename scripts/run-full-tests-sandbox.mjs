/** Run the actual declared suite without inaccessible ancestor realpath calls. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
// AC/Temp denies atomic rename in some Windows workers. Keep fixture data in
// the approved workspace; preserve production atomic publication behavior.
const temporary = join(root, '.tmp', 'test-temp');
mkdirSync(temporary, { recursive: true });
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.TMPDIR = temporary;
function installRepositoryHooks(root) {
  const prefix = pathToFileURL(`${root}/`).href;
  registerHooks({
    resolve(specifier, context, next) {
      const url = specifier.startsWith('file:') ? specifier :
        /^\.\.?\//.test(specifier) && context.parentURL?.startsWith(prefix) ? new URL(specifier, context.parentURL).href : null;
      if (url?.startsWith(prefix)) return { url, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(prefix) && /\.(?:mjs|ts)$/.test(url)) {
        const source = readFileSync(fileURLToPath(url), 'utf8');
        return { format: 'module', source: url.endsWith('.ts') ? stripTypeScriptTypes(source) : source, shortCircuit: true };
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
const command = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test.split(/\s+/);
if (command.shift() !== 'node' || command.shift() !== '--test' || command.shift() !== '--test-isolation=none' || command.some(arg => !/^test\/[\w.-]+\.test\.mjs$/.test(arg))) throw new Error('Unsupported full-suite command');
for (const path of command) await import(pathToFileURL(join(root, path)).href);
