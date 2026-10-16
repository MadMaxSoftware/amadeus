import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCodexExecutable } from './codex-adapter.ts';

/** Home-folder locations a development worker never needs: credentials, tool logins, browser profiles and personal documents. */
const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube', '.config', '.codex', '.claude', '.cursor',
  '.git-credentials', '.npmrc', '.netrc', '.pypirc',
  join('AppData', 'Roaming'), join('AppData', 'Local', 'Google'), join('AppData', 'Local', 'Microsoft', 'Edge'),
  join('AppData', 'Local', 'BraveSoftware'), join('AppData', 'Local', 'Mozilla'),
  'Documents', 'Desktop', 'Downloads', 'Pictures', 'OneDrive',
];

/** Existing sensitive home paths that do not contain the project (a worker must still reach its own project). */
export function defaultSensitivePaths(home: string, sourceRoot: string, present: (path: string) => boolean = existsSync): string[] {
  const keep = [resolve(sourceRoot), dirname(resolve(sourceRoot))].map((path) => path.toLowerCase());
  const candidates = SENSITIVE_HOME_PATHS.map((path) => resolve(home, path));
  // Live MXC probes showed a deny on AppData\Roaming does not reach every
  // application folder inside it (some carry their own ACLs), so each
  // immediate child is denied explicitly as well.
  const roaming = resolve(home, 'AppData', 'Roaming');
  if (present(roaming)) {
    try {
      for (const entry of readdirSync(roaming, { withFileTypes: true })) {
        // MXC's process minimum re-allows Roaming\Microsoft (Windows shell and
        // DPAPI-protected credential stores); listing it would claim a denial
        // the live acceptance check shows the sandbox cannot enforce.
        if (entry.isDirectory() && entry.name.toLowerCase() !== 'microsoft') candidates.push(join(roaming, entry.name));
      }
    } catch { /* an unreadable Roaming folder keeps the folder-level deny only */ }
  }
  return candidates.filter((path) => present(path)
    && !keep.some((root) => root === path.toLowerCase() || root.startsWith(`${path.toLowerCase()}${sep}`)));
}

/** Bind known dependencies at task execution, never enumerate installed software. */
export function portableWorkerConfig(config: Record<string, any>, sourceRoot: string, options: {
  resolveExecutable?: () => string; exists?: (path: string) => boolean;
} = {}): Record<string, any> {
  const present = options.exists ?? existsSync;
  let executable = config.executable;
  if (!executable || !isAbsolute(executable)) {
    executable = options.resolveExecutable?.() ?? resolveCodexExecutable();
    if (!isAbsolute(executable)) {
      try { executable = execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(path => present(join(dirname(path), 'codex-code-mode-host.exe'))) ?? ''; }
      catch { executable = ''; }
    }
  }
  const codeModeHostExecutable = config.codeModeHostExecutable ?? join(dirname(executable || '.'), 'codex-code-mode-host.exe');
  if (!executable || !isAbsolute(executable) || !present(executable) || !isAbsolute(codeModeHostExecutable) || !present(codeModeHostExecutable)) throw new Error('A supported local Codex executable and adjacent code-mode host are required. Run dependency setup in the supported desktop host.');
  const source = resolve(sourceRoot);
  return { ...config, executable, codeModeHostExecutable,
    isolationAcceptanceHarness: config.isolationAcceptanceHarness ?? join(import.meta.dirname, 'portable-acceptance.mjs'),
    isolationSecurityStateProbe: config.isolationSecurityStateProbe ?? join(import.meta.dirname, 'Read-IsolationSecurityState.ps1'),
    assignedProjectRoot: config.assignedProjectRoot ?? source,
    readableProjectRoots: config.readableProjectRoots?.length ? config.readableProjectRoots : [source],
    deniedParentPaths: config.deniedParentPaths?.length ? config.deniedParentPaths : [dirname(source)],
    protectedPaths: config.protectedPaths?.length ? config.protectedPaths : ['.git', '.env', '.ssh', '.aws', '.codex'].map(path => join(source, path)),
    deniedSensitivePaths: config.deniedSensitivePaths ?? defaultSensitivePaths(homedir(), source, present),
    deniedSourceRoot: source,
  };
}
