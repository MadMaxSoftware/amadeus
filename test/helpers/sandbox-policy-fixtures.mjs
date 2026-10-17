// Sandbox launches each worker adapter builds for fixed setups, with machine
// paths replaced by placeholders. The snapshot test compares these against a
// recorded copy so any change to a worker's sandbox rules is deliberate.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { materializeWorkspace } from '../../src/worker-isolation.ts';
import { buildCodexInvocation } from '../../src/codex-adapter.ts';
import { buildClaudeContainmentLaunch } from '../../src/claude-adapter.ts';
import { buildCursorContainmentLaunch } from '../../src/cursor-adapter.ts';
import { WORKER_RUNTIME_DIRECTORY } from '../../src/worker-runtime-layout.ts';

const SRC = resolve(import.meta.dirname, '..', '..', 'src');

export function sandboxPolicySnapshots() {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-sandbox-snapshot-'));
  try {
    const projects = join(root, 'Projects');
    const project = join(projects, 'app');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'a.txt'), 'hello\n');
    const bytes = readFileSync(join(project, 'a.txt'));
    const manifest = join(root, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: project, baseRevision: 'test' },
      files: [{ path: 'a.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    const workspace = (id) => materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, 'workspaces'), workspaceId: id }).workspace;
    const file = (path, text = 'x') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path; };
    const home = join(root, 'home');
    const sensitive = [join(home, '.ssh'), join(home, '.codex'), join(home, '.grok')];
    for (const path of sensitive) mkdirSync(path, { recursive: true });
    const receipts = join(root, 'state', 'patches');
    mkdirSync(receipts, { recursive: true });
    const codexExe = file(join(root, 'bin', 'codex.exe'));
    const scope = { assignedProjectRoot: project, readableProjectRoots: [project], protectedPaths: [join(project, '.git')] };
    const out = {};

    // Codex: scoped development, unscoped development, read-only, bounded write.
    const codexBase = { executable: codexExe, model: null, reasoningEffort: 'low', windowsSandbox: 'mxc', deniedSourceRoot: project };
    out.codexScopedDevelopment = buildCodexInvocation({ ...codexBase, developmentMode: true, writableWorkspacePaths: ['.'],
      ...scope, deniedParentPaths: [projects], deniedSensitivePaths: sensitive, isolationReceipt: join(receipts, 'c1.receipt.json') },
      workspace('codex-dev'), 'objective');
    out.codexUnscopedDevelopment = buildCodexInvocation({ ...codexBase, developmentMode: true, writableWorkspacePaths: ['.', 'docs'] },
      workspace('codex-unscoped'), 'objective');
    out.codexReadOnly = buildCodexInvocation({ ...codexBase, writableWorkspacePaths: [] }, workspace('codex-ro'), 'objective');
    out.codexBoundedWrite = buildCodexInvocation({ ...codexBase, writableWorkspacePaths: ['docs'] }, workspace('codex-bw'), 'objective');

    // Claude-style: scoped development and scoped bounded (non-development).
    const claudeConfig = (ws, extra) => ({
      schemaVersion: 1, executable: file(join(root, 'bin', 'claude.exe')), containmentExecutable: codexExe,
      containmentProfile: 'claude_contained', containmentWindowsSandbox: 'mxc',
      containedAppData: join(root, 'providers', 'claude', 'appdata'), containedUsername: 'amadeus-worker',
      containedUserProfile: join(root, 'providers', 'claude', 'profile'),
      userInfoShim: join(SRC, 'claude-windows-userinfo-shim.cjs'), pathVerifierShim: join(SRC, 'claude-path-verifier-shim.cjs'),
      authentication: 'subscription-signin', apiKeyAuthenticationAllowed: false, outputFormat: 'stream-json', model: null,
      deniedSourceRoot: project, configurationDirectory: join(home, '.claude'),
      runtimeConfigurationRoot: join(ws, WORKER_RUNTIME_DIRECTORY), maximumRuntimeSeconds: 600,
      ...scope, deniedParentPaths: [join(root, 'deny-probe'), ...sensitive], ...extra,
    });
    const claudeDevWs = workspace('claude-dev');
    out.claudeScopedDevelopment = buildClaudeContainmentLaunch(claudeConfig(claudeDevWs, { developmentMode: true,
      writeIsolationReceipt: join(receipts, 'cl.receipt.json') }), claudeDevWs, ['-p', 'objective'], ['.']);
    const claudeBoundedWs = workspace('claude-bounded');
    out.claudeScopedBounded = buildClaudeContainmentLaunch(claudeConfig(claudeBoundedWs, {}), claudeBoundedWs, ['-p', 'objective'], ['docs']);

    // Cursor: scoped development and unscoped development.
    const authFile = file(join(home, 'AppData', 'Roaming', 'Cursor', 'auth.json'), '{}');
    const cursorConfig = (ws, extra) => ({
      schemaVersion: 1, executable: file(join(root, 'bin', 'cursor-agent.exe')), containmentExecutable: codexExe,
      containmentProfile: 'cursor_contained', containmentWindowsSandbox: 'mxc',
      containedAppData: join(root, 'providers', 'cursor', 'appdata'), containedUsername: 'amadeus-worker',
      containedUserProfile: join(root, 'providers', 'cursor', 'profile'),
      userInfoShim: join(SRC, 'cursor-windows-userinfo-shim.cjs'), pathVerifierShim: join(SRC, 'cursor-path-verifier-shim.cjs'),
      authentication: 'browser-login', apiKeyAuthenticationAllowed: false, mode: 'ask', sandbox: 'disabled', outputFormat: 'stream-json',
      model: null, deniedSourceRoot: project, configurationDirectory: join(home, '.cursor'), authenticationFile: authFile,
      runtimeConfigurationRoot: join(ws, WORKER_RUNTIME_DIRECTORY), maximumRuntimeSeconds: 600, developmentMode: true, ...extra,
    });
    const cursorDevWs = workspace('cursor-dev');
    out.cursorScopedDevelopment = buildCursorContainmentLaunch(cursorConfig(cursorDevWs, { ...scope,
      deniedParentPaths: [join(root, 'deny-probe'), ...sensitive] }), cursorDevWs, ['--print', 'objective'], ['.']);
    const cursorUnscopedWs = workspace('cursor-unscoped');
    out.cursorUnscopedDevelopment = buildCursorContainmentLaunch(cursorConfig(cursorUnscopedWs, {}), cursorUnscopedWs, ['--print', 'objective'], ['.']);

    // Replace machine paths with placeholders (both slash styles, and JSON-escaped backslashes).
    let text = JSON.stringify(out, null, 2);
    for (const [path, name] of [[root, '<ROOT>'], [SRC, '<SRC>']]) {
      for (const form of [path, path.replaceAll('\\', '\\\\'), path.replaceAll('\\', '\\\\\\\\'), path.replaceAll('\\', '/')]) {
        text = text.split(form).join(name);
      }
    }
    return JSON.parse(text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
