/** Load only repository modules without ancestor realpath traversal in restricted workers. */
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.cwd();
// Host Windows sandboxes often redirect os.tmpdir() into AC\Temp where rename()
// is denied (EPERM). Point Node temp vars at the writable workspace so
// consolidation's atomic journal publication and fixture trees can rename.
const workspaceTemp = join(root, ".tmp", "test-temp");
mkdirSync(workspaceTemp, { recursive: true });
process.env.TEMP = workspaceTemp;
process.env.TMP = workspaceTemp;
process.env.TMPDIR = workspaceTemp;
function installRepositoryHooks(root) {
  const prefix = pathToFileURL(`${root}/`).href;
  registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith("file:") ? specifier :
      /^\.\.?\//.test(specifier) && context.parentURL?.startsWith(prefix) ? new URL(specifier, context.parentURL).href : null;
    if (url?.startsWith(prefix)) return { url, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(prefix) && /\.(?:mjs|ts)$/.test(url)) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", source: url.endsWith(".ts") ? stripTypeScriptTypes(source) : source, shortCircuit: true };
    }
    return next(url, context);
  },
  });
}
installRepositoryHooks(root);
const childHook = `import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs'; import {fileURLToPath,pathToFileURL} from 'node:url';
(${installRepositoryHooks.toString()})(${JSON.stringify(root)});`;
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --preserve-symlinks-main --preserve-symlinks --import=data:text/javascript;base64,${Buffer.from(childHook).toString("base64")}`;
await import(pathToFileURL(join(root, "test/amadeus-state-consolidation.test.mjs")).href);
