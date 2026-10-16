/**
 * Spawn a repository ESM file even when the sandbox denies lstat('C:\\')
 * during Node's main-module realpath. Prefer a direct argv path; fall back to
 * `node -e` + dynamic import through repository hooks when present.
 *
 * For CLI scripts whose side effects only run when argv[1] matches import.meta
 * (e.g. Claude host preflight), prefer the dedicated stdin-piped sandbox
 * runners under scripts/run-*-sandbox.mjs instead of this helper.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Any denied ancestor: C:\ on older sandboxes, or the unreadable
// `.amadeus-worker-workspaces` parents above a project-scoped worker workspace.
function deniedAncestorRealpath(stderr) {
  return /EPERM: operation not permitted, lstat '[^']+'/.test(String(stderr || ''));
}

export function spawnRepoModule(scriptPath, options = {}) {
  const absolute = resolve(scriptPath);
  const scriptArgs = Array.isArray(options.scriptArgs) ? options.scriptArgs : [];
  const direct = spawnSync(process.execPath, [absolute, ...scriptArgs], options);
  if (!deniedAncestorRealpath(direct.stderr) && direct.error?.code !== 'EPERM') return direct;
  const fileUrl = pathToFileURL(absolute).href;
  // Preserve argv shape so CLI entrypoints that gate on process.argv[1] still run.
  const evalSource = [
    `import { pathToFileURL as toUrl } from 'node:url';`,
    `const entry = ${JSON.stringify(absolute)};`,
    `process.argv = [process.execPath, entry, ...${JSON.stringify(scriptArgs)}];`,
    `await import(toUrl(entry).href);`,
  ].join('\n');
  const env = { ...(options.env || process.env) };
  // Keep repository short-circuit hooks when the parent sandbox installed them.
  if (!env.NODE_OPTIONS && process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['--input-type=module', '-e', evalSource], {
    ...options,
    env,
  });
}
