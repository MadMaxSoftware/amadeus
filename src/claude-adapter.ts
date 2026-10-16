import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { verifyWorkspace } from "./worker-isolation.ts";
import { terminateWorkerTree } from "./worker-process.ts";
import { WORKER_RUNTIME_DIRECTORY, workerRuntimeLayout } from "./worker-runtime-layout.ts";
import { isolationSecurityStateBinding } from "./isolation-security-state.ts";

export type ClaudeAdapterConfig = {
  schemaVersion: 1;
  enabled: boolean;
  dispatchAuthorized: boolean;
  automaticStartup: boolean;
  executable: string;
  executableArguments?: string[];
  containmentExecutable: string;
  containmentProfile: "claude_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  pathVerifierShim: string;
  authentication: "subscription-signin";
  apiKeyAuthenticationAllowed: false;
  spendingRouteReviewed: boolean;
  readOnlyOnly: boolean;
  outputFormat: "stream-json";
  model: string | null;
  deniedSourceRoot: string;
  assignedProjectRoot?: string;
  readableProjectRoots?: string[];
  deniedParentPaths?: string[];
  protectedPaths?: string[];
  configurationDirectory: string;
  runtimeConfigurationRoot: string;
  maximumRuntimeSeconds: number;
  maximumIdleSeconds?: number;
  writableWorkspacePaths?: string[];
  implementationPrepared?: boolean;
  implementationDispatchAuthorized?: boolean;
  readIsolationVerified?: boolean;
  readIsolationReceipt?: string | null;
  writeIsolationVerified?: boolean;
  writeIsolationReceipt?: string | null;
  developmentMode?: boolean;
  /** Shared with Codex workers: may a development worker run commands (default true). */
  workerCommandsEnabled?: boolean;
  isolationAcceptanceHarness?: string | null;
  isolationSecurityStateProbe?: string | null;
};

export type ClaudeWriteIsolationReceipt = {
  schemaVersion: 1;
  executableVersion: string;
  executableSha256: string;
  containmentExecutableSha256: string;
  adapterSha256: string;
  acceptanceHarnessPath: string;
  acceptanceHarnessSha256: string;
  isolationEnvelopeSha256: string;
  securityStateProbePath: string;
  securityStateProbeSha256: string;
  securityBoundaryPaths: string[];
  mutableBoundaryRoots: string[];
  hostSecurityStateFingerprint: string;
  workspace: string;
  writableWorkspacePaths: string[];
  authoritativeRepositoryDenied: boolean;
  outsideWorkspaceWritesDenied: true;
  unapprovedWorkspaceWritesDenied: true;
  /** False for development workers, which may read .git and the receipt (writes stay denied). */
  gitHistoryDenied: boolean;
  isolationReceiptDenied: boolean;
  developmentMode?: boolean;
  gitHistoryWritesDenied?: true;
  isolationReceiptWritesDenied?: true;
  deniedPathsProbed?: number;
  registeredProjectReadsAllowed?: true;
  unassignedProjectWritesDenied?: true;
  protectedPathsDenied?: true;
  parentUserDirectoryDenied?: true;
  containmentExecutable: string;
  containmentProfile: "claude_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  userInfoShimSha256: string;
  runtimeConfigurationRoot: string;
  runtimeConfigurationWritesRestricted: true;
  runtimeConfigurationWriteProbePassed: true;
  runtimeConfigurationNeighborDenied: true;
  testedAt: string;
  apiKeyAuthenticationAllowed: false;
  credentialsCopied: false;
  authenticationDirectoryReadAllowed?: true;
};

export type ClaudeResultReceipt = {
  result: string;
  sessionId: string;
  requestId: string | null;
  durationMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
};

export type ClaudeExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutKind?: "wall-clock" | "idle";
  aborted?: boolean;
  evidenceError?: string;
  stdout: string;
  stderr: string;
  error?: string;
};

export const CLAUDE_WORKER_SAFETY_ARGUMENTS = [
  "--safe-mode", "--restricted", "--strict-mcp-config",
  "--permission-mode", "acceptEdits", "--permission-prompts", "none",
  "--no-session-persistence", "--verbose",
] as const;

/**
 * Tools a development Claude worker may use without a prompt. Restricted mode
 * removes command tools unless named, and the contained process cannot always
 * resolve its workspace's parent folders, so writes would otherwise need a
 * person. The MXC sandbox, not the prompt, is the boundary for these tools.
 */
export const CLAUDE_FILE_TOOLS = "Read,Edit,Write,Glob,Grep";

/**
 * Arguments for a development Claude worker, kept equal to a Codex development
 * worker: the MXC sandbox and project scope are the boundary, and the owner's
 * workerCommandsEnabled setting (default on) decides for both providers whether
 * the worker may run commands. --restricted is not used here: inside the sandbox
 * it cannot resolve the workspace's parent folders and so refuses every write.
 * No settings files, CLAUDE.md, hooks, plugins or MCP servers are loaded.
 */
export function claudeDevelopmentArguments(commandsEnabled: boolean, platform: NodeJS.Platform = process.platform): string[] {
  // Git Bash (MSYS) cannot start inside the Windows MXC sandbox (0xC0000142);
  // PowerShell can, and is what Codex workers use on Windows too.
  const tools = commandsEnabled ? `${platform === "win32" ? "PowerShell" : "Bash"},${CLAUDE_FILE_TOOLS}` : CLAUDE_FILE_TOOLS;
  return ["--safe-mode", "--strict-mcp-config", "--setting-sources", "",
    "--tools", tools, "--allowedTools", tools,
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--no-session-persistence", "--verbose"];
}

function claudeWorkerArguments(config: ClaudeAdapterConfig): readonly string[] {
  return config.developmentMode && !config.readOnlyOnly
    ? claudeDevelopmentArguments(config.workerCommandsEnabled !== false) : CLAUDE_WORKER_SAFETY_ARGUMENTS;
}

const claudeAdapterPath = fileURLToPath(import.meta.url);
export type ClaudeSpawn = typeof spawn;
let claudeSpawnForTests: ClaudeSpawn = spawn;

export function setClaudeSpawnForTests(value: ClaudeSpawn): () => void {
  const previous = claudeSpawnForTests;
  claudeSpawnForTests = value;
  return () => { claudeSpawnForTests = previous; };
}

function sha256File(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Required Claude isolation binding file is missing: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function normalizeWritableWorkspacePaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths)) throw new Error("Claude writableWorkspacePaths must be an array");
  const normalized = paths.map((value) => {
    if (value === ".") return value;
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      throw new Error("Claude writable paths must be relative forward-slash paths");
    }
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || parts[0].toLowerCase() === ".git"
      || parts[0].toLowerCase() === WORKER_RUNTIME_DIRECTORY || value === ".worker-isolation.json") {
      throw new Error("Unsafe Claude writable path");
    }
    return value;
  });
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new Error("Duplicate Claude writable path");
  }
  return normalized;
}

type ProjectScope = { assignedProjectRoot: string; readableProjectRoots: string[]; deniedParentPaths: string[]; protectedPaths: string[] };

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function normalizeProjectScope(config: ClaudeAdapterConfig): ProjectScope | null {
  const configured = config.assignedProjectRoot !== undefined || config.readableProjectRoots !== undefined
    || config.deniedParentPaths !== undefined || config.protectedPaths !== undefined;
  if (!configured) return null;
  if (!config.assignedProjectRoot || !Array.isArray(config.readableProjectRoots)
    || !Array.isArray(config.deniedParentPaths) || !Array.isArray(config.protectedPaths)) {
    throw new Error("Claude project scope requires assignedProjectRoot, readableProjectRoots, deniedParentPaths, and protectedPaths");
  }
  const readableProjectRoots = config.readableProjectRoots.map((path) => {
    if (!isAbsolute(path)) throw new Error("Claude readable project roots must be absolute");
    const resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`Claude readable project root is missing: ${resolved}`);
    return resolved;
  });
  if (readableProjectRoots.length === 0 || new Set(readableProjectRoots.map((path) => path.toLowerCase())).size !== readableProjectRoots.length) {
    throw new Error("Claude readable project roots must be nonempty and unique");
  }
  const assignedProjectRoot = resolve(config.assignedProjectRoot);
  if (!readableProjectRoots.some((path) => isWithin(path, assignedProjectRoot))) {
    throw new Error("Claude assigned project must be inside a readable account root");
  }
  const deniedParentPaths = config.deniedParentPaths.map((path) => {
    if (!isAbsolute(path)) throw new Error("Claude denied parent paths must be absolute");
    return resolve(path);
  });
  if (deniedParentPaths.length === 0 || new Set(deniedParentPaths.map((path) => path.toLowerCase())).size !== deniedParentPaths.length
    || deniedParentPaths.some((denied) => readableProjectRoots.some((root) => isWithin(denied, root)))) {
    throw new Error("Claude denied user paths must be unique and must not contain readable account roots");
  }
  const protectedPaths = config.protectedPaths.map((path) => {
    if (!isAbsolute(path)) throw new Error("Claude protected paths must be absolute");
    const resolved = resolve(path);
    if (!readableProjectRoots.some((root) => isWithin(root, resolved)) || readableProjectRoots.some((root) => root.toLowerCase() === resolved.toLowerCase())) {
      throw new Error("Claude protected paths must be strict children of registered project roots");
    }
    return resolved;
  });
  if (new Set(protectedPaths.map((path) => path.toLowerCase())).size !== protectedPaths.length) {
    throw new Error("Claude protected paths must be unique");
  }
  return { assignedProjectRoot, readableProjectRoots, deniedParentPaths, protectedPaths };
}

function assertNoWorkspaceReparsePoints(workspace: string): void {
  const pending = [workspace];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Claude workspace contains a prohibited reparse point: ${path}`);
      if (info.isDirectory()) pending.push(path);
    }
  }
}

function assertSafeConfig(config: ClaudeAdapterConfig, workspace: string): string {
  if (config.schemaVersion !== 1) throw new Error("Unsupported Claude adapter config");
  if (config.authentication !== "subscription-signin" || config.apiKeyAuthenticationAllowed !== false) {
    throw new Error("Claude adapter permits subscription sign-in only; API-key billing is prohibited");
  }
  if (config.outputFormat !== "stream-json") throw new Error("Claude adapter requires stream-json receipts");
  if (!Number.isSafeInteger(config.maximumRuntimeSeconds) || config.maximumRuntimeSeconds < 0
    || config.maximumIdleSeconds !== undefined && (!Number.isSafeInteger(config.maximumIdleSeconds) || config.maximumIdleSeconds < 0)) {
    throw new Error("Invalid Claude timeout");
  }
  if (!isAbsolute(config.deniedSourceRoot) || !isAbsolute(config.configurationDirectory)
    || !isAbsolute(config.containmentExecutable) || !isAbsolute(config.containedAppData)
    || !isAbsolute(config.containedUserProfile) || !isAbsolute(config.userInfoShim) || !isAbsolute(config.pathVerifierShim)
    || !isAbsolute(config.runtimeConfigurationRoot)) {
    throw new Error("Claude denied source, configuration, containment, and profile paths must be absolute");
  }
  if (!config.containedUsername.trim() || !existsSync(config.userInfoShim) || !existsSync(config.pathVerifierShim)) {
    throw new Error("Claude contained Windows identity fallback is incomplete");
  }
  const resolvedWorkspace = resolve(workspace);
  if (relative(resolvedWorkspace, resolve(config.runtimeConfigurationRoot)) !== WORKER_RUNTIME_DIRECTORY) {
    throw new Error(`Claude runtimeConfigurationRoot must be the ${WORKER_RUNTIME_DIRECTORY} child of the isolated workspace`);
  }
  if (config.containmentProfile !== "claude_contained" || config.containmentWindowsSandbox !== "mxc") {
    throw new Error("Claude workers require the explicit MXC claude_contained sandbox");
  }
  if (!isAbsolute(config.executable) || (config.executableArguments !== undefined
    && (!Array.isArray(config.executableArguments) || config.executableArguments.some((value) => typeof value !== "string" || !value)))) {
    throw new Error("Claude executable must be absolute and launcher arguments must be nonempty strings");
  }
  const deniedRoot = resolve(config.deniedSourceRoot);
  const workspaceKey = resolvedWorkspace.toLowerCase();
  const deniedKey = deniedRoot.toLowerCase();
  if (workspaceKey === deniedKey || workspaceKey.startsWith(`${deniedKey}\\`) || workspaceKey.startsWith(`${deniedKey}/`)) {
    throw new Error("Claude workspace must not be inside the authoritative repository");
  }
  verifyWorkspace(resolvedWorkspace);
  assertNoWorkspaceReparsePoints(resolvedWorkspace);
  return resolvedWorkspace;
}

export function resolveClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  const explicit = environment.CLAUDE_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const userProfile = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  if (userProfile) {
    for (const candidate of [
      join(userProfile, "AppData", "Roaming", "npm", "claude.cmd"),
      join(userProfile, "AppData", "Roaming", "npm", "claude"),
      join(userProfile, ".local", "bin", "claude"),
    ]) {
      if (pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export function buildClaudeEnvironment(
  config: ClaudeAdapterConfig,
  configurationDirectory = config.configurationDirectory,
  workspace?: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolvedConfigurationDirectory = resolve(configurationDirectory);
  const containedProfile = resolve(config.containedUserProfile);
  const containedDrive = containedProfile.match(/^[A-Za-z]:/)?.[0] ?? "";
  const containedHomePath = containedDrive ? containedProfile.slice(containedDrive.length) : containedProfile;
  const temporaryDirectory = resolve(resolvedConfigurationDirectory, "tmp");
  const environment: NodeJS.ProcessEnv = {
    // Workers inherit only process plumbing. A denylist of known API keys
    // misses credentials added by other tools and user-defined variables.
    ...Object.fromEntries([
      "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
      "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
      "OS", "NUMBER_OF_PROCESSORS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
      "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
      "PUBLIC", "ALLUSERSPROFILE", "USERDOMAIN",
    ].filter((key) => sourceEnvironment[key] !== undefined)
      .map((key) => [key, sourceEnvironment[key]])),
    CI: "1",
    AMADEUS_WORKER: "1",
    APPDATA: resolve(config.containedAppData),
    // Keep sign-in state in place and read-only. The per-job directory is used
    // only for temp/cache output below; redirecting CLAUDE_CONFIG_DIR there
    // makes an already signed-in Claude installation appear logged out.
    CLAUDE_CONFIG_DIR: resolve(config.configurationDirectory),
    CLAUDE_CONTAINED_USERNAME: config.containedUsername,
    CLAUDE_CONTAINED_HOME: containedProfile,
    CLAUDE_CONTAINED_WORKSPACE: workspace ? resolve(workspace) : "",
    USERNAME: config.containedUsername,
    USERPROFILE: containedProfile,
    HOME: containedProfile,
    HOMEDRIVE: containedDrive,
    HOMEPATH: containedHomePath,
    LOCALAPPDATA: join(containedProfile, "AppData", "Local"),
    NODE_COMPILE_CACHE: resolve(resolvedConfigurationDirectory, "node-cache"),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  return environment;
}

export function buildClaudeInvocation(config: ClaudeAdapterConfig, workspace: string, objective: string): string[] {
  if (!objective.trim()) throw new Error("objective is required");
  assertSafeConfig(config, workspace);
  if (!config.readOnlyOnly) throw new Error("Read-only Claude invocation requires readOnlyOnly=true");
  const args = ["-p", ...CLAUDE_WORKER_SAFETY_ARGUMENTS, "--output-format", config.outputFormat];
  if (config.model?.trim()) args.push("--model", config.model.trim());
  args.push(objective.trim());
  if (args.some((value) => /dangerously-skip-permissions|dangerously-skip-permissions/i.test(value) || value === "--dangerously-skip-permissions")) {
    throw new Error("Claude adapter must never skip permissions");
  }
  return args;
}

function projectFilesystemPolicy(scope: ProjectScope, workspacePermissions: string, absoluteWorkspaceWrites: string[], runtimePermissions: string, processReadPaths: string[],
  development: { evidenceRoot: string | null } | null = null): string {
  if (development) {
    // Same shape as a Codex development worker: read baseline, then the
    // credential/personal folders, protected evidence and protected project
    // paths denied, then exact project, process and workspace allowances.
    const denies = [...scope.deniedParentPaths, ...(development.evidenceRoot ? [development.evidenceRoot] : [])]
      .map((path) => `,${JSON.stringify(path)}="deny"`).join("");
    const reads = [...scope.readableProjectRoots, ...processReadPaths.map((path) => resolve(path))]
      .map((path) => `,${JSON.stringify(path)}="read"`).join("");
    const protectedDenies = scope.protectedPaths.map((path) => `,${JSON.stringify(path)}="deny"`).join("");
    const exactWrites = absoluteWorkspaceWrites.map((path) => `,${JSON.stringify(path)}="write"`).join("");
    return `":root"="read",":minimal"="read"${denies}${reads}${protectedDenies},":workspace_roots"={${workspacePermissions}}${exactWrites}${runtimePermissions}`;
  }
  const traversalReads = [...new Set(scope.readableProjectRoots.map((path) => dirname(path)))]
    .map((path) => `,${JSON.stringify(path)}="read"`).join("");
  const parentDenies = scope.deniedParentPaths.map((path) => `,${JSON.stringify(path)}="deny"`).join("");
  const reads = scope.readableProjectRoots.map((path) => `,${JSON.stringify(path)}="read"`).join("");
  const denies = scope.protectedPaths.map((path) => `,${JSON.stringify(path)}="deny"`).join("");
  const processReads = processReadPaths.map((path) => `,${JSON.stringify(resolve(path))}="read"`).join("");
  const exactWrites = absoluteWorkspaceWrites.map((path) => `,${JSON.stringify(path)}="write"`).join("");
  return `":root"="deny",":minimal"="read"${traversalReads}${parentDenies}${reads}${denies}${processReads},":workspace_roots"={${workspacePermissions}}${exactWrites}${runtimePermissions}`;
}

export function buildClaudeContainmentLaunch(
  config: ClaudeAdapterConfig,
  workspace: string,
  claudeArgs: string[],
  writableWorkspacePaths: string[] = [],
  runtimeWritableDirectory?: string,
): { executable: string; args: string[]; cwd: string } {
  const cwd = assertSafeConfig(config, workspace);
  const writablePaths = writableWorkspacePaths.length > 0
    ? normalizeWritableWorkspacePaths(writableWorkspacePaths)
    : [];
  const deniedRoot = resolve(config.deniedSourceRoot);
  const runtimeWrite = runtimeWritableDirectory ? resolve(runtimeWritableDirectory) : null;
  const runtimePermissions = workerRuntimeLayout(config.runtimeConfigurationRoot, runtimeWrite ?? undefined);
  const workspacePermissions = [
    `"."="${writablePaths.includes(".") ? "write" : "read"}"`,
    ...writablePaths.filter((path) => path !== ".").map((path) => `${JSON.stringify(path)}="write"`),
    `".git"="${config.developmentMode ? "read" : "deny"}"`,
    `".worker-isolation.json"="${config.developmentMode ? "read" : "deny"}"`,
  ].join(",");
  const projectScope = normalizeProjectScope(config);
  const absoluteWorkspaceWrites = [...new Set(writablePaths.map((path) => resolve(cwd, path)))];
  const launcherReadPaths = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .flatMap((path) => [resolve(path), dirname(resolve(path))]);
  const filesystem = projectScope
    ? projectFilesystemPolicy(projectScope, workspacePermissions, absoluteWorkspaceWrites, runtimePermissions,
      [dirname(config.executable), ...launcherReadPaths, config.containedAppData, config.configurationDirectory, config.userInfoShim, config.pathVerifierShim],
      config.developmentMode && !config.readOnlyOnly
        ? { evidenceRoot: config.writeIsolationReceipt && isAbsolute(config.writeIsolationReceipt) ? dirname(resolve(config.writeIsolationReceipt)) : null }
        : null)
    : `":root"="read",":workspace_roots"={${workspacePermissions}},${JSON.stringify(deniedRoot)}="${config.developmentMode ? "read" : "deny"}"${runtimePermissions}`;
  const permissionDefinition = `{description="Claude contained worker",filesystem={${filesystem}},network={enabled=true}}`;
  return {
    executable: config.containmentExecutable,
    args: [
      "sandbox", "-C", cwd,
      "-c", `windows.sandbox=${JSON.stringify(config.containmentWindowsSandbox)}`,
      "-c", `permissions.${config.containmentProfile}=${permissionDefinition}`,
      "-c", `default_permissions=${JSON.stringify(config.containmentProfile)}`,
      "-P", config.containmentProfile,
      "--", config.executable, ...(config.executableArguments ?? []), ...claudeArgs,
    ],
    cwd,
  };
}

export function buildClaudeImplementationPlan(config: ClaudeAdapterConfig, workspace: string, objective: string): {
  executable: string;
  args: string[];
  cwd: string;
  launched: false;
} {
  if (!objective.trim()) throw new Error("objective is required");
  const cwd = assertSafeConfig(config, workspace);
  normalizeWritableWorkspacePaths(config.writableWorkspacePaths);
  const args = ["-p", ...claudeWorkerArguments(config), "--output-format", config.outputFormat];
  if (config.model?.trim()) args.push("--model", config.model.trim());
  args.push(objective.trim());
  if (args.includes("--dangerously-skip-permissions") || args.includes("bypassPermissions")) {
    throw new Error("Claude adapter must never skip permissions");
  }
  return { executable: config.executable, args, cwd, launched: false };
}

function stableWorkspaceChildren(path: string, writablePaths: string[]): string[] {
  if (!existsSync(path)) return [];
  const mutableTopLevels = new Set(writablePaths.filter((value) => value !== ".").map((value) => value.split("/")[0].toLowerCase()));
  const allWorkspaceChildrenMutable = writablePaths.includes(".");
  return readdirSync(path)
    .filter((name) => [".git", ".worker-isolation.json", WORKER_RUNTIME_DIRECTORY].includes(name.toLowerCase())
      || !allWorkspaceChildrenMutable && !mutableTopLevels.has(name.toLowerCase()))
    .map((name) => join(path, name));
}

function writableParentChain(workspace: string, writablePaths: string[]): string[] {
  const root = resolve(workspace);
  const parents = new Set<string>([root]);
  for (const relativePath of writablePaths) {
    const target = relativePath === "." ? root : resolve(root, relativePath);
    let parent = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`Claude writable path parent must be materialized before isolation acceptance: ${relativePath}`);
    }
    while (true) {
      const relativeParent = parent.toLowerCase() === root.toLowerCase() ? "" : relative(root, parent);
      if (parent.toLowerCase() !== root.toLowerCase() && (relativeParent.startsWith(`..${sep}`) || relativeParent === ".." || isAbsolute(relativeParent))) {
        throw new Error(`Claude writable path parent escapes the worker workspace: ${relativePath}`);
      }
      parents.add(parent);
      if (parent.toLowerCase() === root.toLowerCase()) break;
      parent = dirname(parent);
    }
  }
  return [...parents];
}

export function claudeIsolationEnvelopeSha256(config: ClaudeAdapterConfig, workspace: string): string {
  if (!config.isolationAcceptanceHarness || !isAbsolute(config.isolationAcceptanceHarness)) {
    throw new Error("Claude isolation acceptance harness is not configured");
  }
  const writablePaths = normalizeWritableWorkspacePaths(config.writableWorkspacePaths ?? []);
  const projectScope = normalizeProjectScope(config);
  const plan = buildClaudeImplementationPlan({ ...config, writableWorkspacePaths: writablePaths }, workspace, "isolation-envelope-fingerprint");
  const launch = buildClaudeContainmentLaunch(config, workspace, plan.args, writablePaths);
  const permissionDefinition = launch.args.find((value) => value.startsWith(`permissions.${config.containmentProfile}=`));
  if (!permissionDefinition) throw new Error("Claude effective containment profile could not be derived");
  const launcherArtifacts = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .map((path) => ({ path: resolve(path), sha256: sha256File(path) }));
  const payload = JSON.stringify({
    executable: resolve(config.executable),
    executableArguments: config.executableArguments ?? [],
    launcherArtifacts,
    containmentExecutable: resolve(config.containmentExecutable),
    containmentProfile: config.containmentProfile,
    containmentWindowsSandbox: config.containmentWindowsSandbox,
    workspace: resolve(workspace),
    deniedSourceRoot: resolve(config.deniedSourceRoot),
    ...(projectScope ? {
      assignedProjectRoot: projectScope.assignedProjectRoot,
      readableProjectRoots: projectScope.readableProjectRoots,
      deniedParentPaths: projectScope.deniedParentPaths,
      protectedPaths: projectScope.protectedPaths,
    } : {}),
    containedAppData: resolve(config.containedAppData),
    containedUsername: config.containedUsername,
    containedUserProfile: resolve(config.containedUserProfile),
    userInfoShim: resolve(config.userInfoShim),
    pathVerifierShim: resolve(config.pathVerifierShim),
    pathVerifierShimSha256: sha256File(config.pathVerifierShim),
    configurationDirectory: resolve(config.configurationDirectory),
    runtimeConfigurationRoot: resolve(config.runtimeConfigurationRoot),
    writableWorkspacePaths: writablePaths,
    authentication: config.authentication,
    apiKeyAuthenticationAllowed: config.apiKeyAuthenticationAllowed,
    developmentMode: config.developmentMode === true,
    readOnlyOnly: config.readOnlyOnly,
    invocationArguments: plan.args.slice(0, -1),
    permissionDefinition,
    acceptanceHarnessPath: resolve(config.isolationAcceptanceHarness),
  });
  return createHash("sha256").update(payload).digest("hex").toUpperCase();
}

export function claudeIsolationSecurityState(
  config: ClaudeAdapterConfig,
  workspace: string,
  receiptPath = config.writeIsolationReceipt ?? config.readIsolationReceipt,
) {
  const writablePaths = normalizeWritableWorkspacePaths(config.writableWorkspacePaths ?? []);
  if (!receiptPath || !isAbsolute(receiptPath)) throw new Error("Claude isolation receipt path must be configured before acceptance");
  const projectScope = normalizeProjectScope(config);
  const mutableParents = writableParentChain(workspace, writablePaths);
  const mutableRoots = [...mutableParents, resolve(config.configurationDirectory), resolve(config.runtimeConfigurationRoot)];
  return isolationSecurityStateBinding(config.isolationSecurityStateProbe, "claude", workspace, [
    workspace, config.deniedSourceRoot, config.executable, dirname(config.executable), config.containmentExecutable,
    ...(config.executableArguments ?? []).filter((value) => isAbsolute(value)).flatMap((path) => [path, dirname(path)]),
    ...(projectScope?.deniedParentPaths ?? []), ...(projectScope?.readableProjectRoots ?? []), ...(projectScope?.protectedPaths ?? []),
    config.containedAppData, config.containedUserProfile, config.userInfoShim, config.pathVerifierShim,
    config.configurationDirectory, config.runtimeConfigurationRoot, config.isolationAcceptanceHarness ?? "",
    join(workspace, ".git"), join(workspace, ".worker-isolation.json"), dirname(resolve(receiptPath)),
    ...stableWorkspaceChildren(workspace, writablePaths), ...mutableParents,
  ].filter(Boolean), mutableRoots);
}

function readClaudeExecutableVersion(config: ClaudeAdapterConfig): string {
  const result = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, env: buildClaudeEnvironment(config), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Claude executable version could not be verified");
  }
  return result.stdout.trim();
}

function validatedWriteIsolationReceipt(config: ClaudeAdapterConfig, workspace: string): ClaudeWriteIsolationReceipt | undefined {
  // Development workers may read the registered project, the workspace .git and
  // its receipt (as Codex development workers do); every write stays denied.
  const development = config.developmentMode === true;
  if (!config.writeIsolationVerified || !config.writeIsolationReceipt || !isAbsolute(config.writeIsolationReceipt)) {
    throw new Error("Claude write isolation receipt is required before dispatch");
  }
  if (!existsSync(config.writeIsolationReceipt)) throw new Error("Claude write-isolation receipt is missing");
  const receipt = JSON.parse(readFileSync(config.writeIsolationReceipt, "utf8")) as ClaudeWriteIsolationReceipt;
  const expectedPaths = normalizeWritableWorkspacePaths(config.writableWorkspacePaths);
  const executableVersion = readClaudeExecutableVersion(config);
  const securityState = claudeIsolationSecurityState(config, workspace, config.writeIsolationReceipt);
  const checks: Array<[string, boolean]> = [
    ["schema", receipt.schemaVersion === 1], ["executable version", receipt.executableVersion.trim() === executableVersion],
    ["workspace", resolve(receipt.workspace) === resolve(workspace)], ["executable hash", receipt.executableSha256 === sha256File(config.executable)],
    ["containment hash", receipt.containmentExecutableSha256 === sha256File(config.containmentExecutable)], ["adapter hash", receipt.adapterSha256 === sha256File(claudeAdapterPath)],
    ["harness path", !!config.isolationAcceptanceHarness && resolve(receipt.acceptanceHarnessPath) === resolve(config.isolationAcceptanceHarness)],
    ["harness hash", !!config.isolationAcceptanceHarness && receipt.acceptanceHarnessSha256 === sha256File(config.isolationAcceptanceHarness)],
    ["permission envelope", receipt.isolationEnvelopeSha256 === claudeIsolationEnvelopeSha256(config, workspace)],
    ["security probe path", receipt.securityStateProbePath === securityState.securityStateProbePath], ["security probe hash", receipt.securityStateProbeSha256 === securityState.securityStateProbeSha256],
    ["security boundaries", JSON.stringify(receipt.securityBoundaryPaths) === JSON.stringify(securityState.securityBoundaryPaths)],
    ["mutable boundary roots", JSON.stringify(receipt.mutableBoundaryRoots) === JSON.stringify(securityState.mutableBoundaryRoots)],
    ["host security state", receipt.hostSecurityStateFingerprint === securityState.hostSecurityStateFingerprint],
    ["writable paths", JSON.stringify(receipt.writableWorkspacePaths) === JSON.stringify(expectedPaths)],
    ["authoritative repository probe", receipt.authoritativeRepositoryDenied === !development], ["outside write probe", receipt.outsideWorkspaceWritesDenied === true],
    ["unapproved write probe", receipt.unapprovedWorkspaceWritesDenied === true],
    ["git probe", development ? receipt.gitHistoryWritesDenied === true : receipt.gitHistoryDenied === true],
    ["isolation receipt probe", development ? receipt.isolationReceiptWritesDenied === true : receipt.isolationReceiptDenied === true], ["containment executable", resolve(receipt.containmentExecutable) === resolve(config.containmentExecutable)],
    ["containment profile", receipt.containmentProfile === config.containmentProfile], ["containment sandbox", receipt.containmentWindowsSandbox === config.containmentWindowsSandbox],
    ["contained app data", resolve(receipt.containedAppData) === resolve(config.containedAppData)], ["contained user", receipt.containedUsername === config.containedUsername],
    ["contained profile", resolve(receipt.containedUserProfile) === resolve(config.containedUserProfile)], ["user shim", resolve(receipt.userInfoShim) === resolve(config.userInfoShim)],
    ["user shim hash", receipt.userInfoShimSha256 === sha256File(config.userInfoShim)], ["runtime root", resolve(receipt.runtimeConfigurationRoot) === resolve(config.runtimeConfigurationRoot)],
    ["runtime restriction probe", receipt.runtimeConfigurationWritesRestricted === true], ["runtime write probe", receipt.runtimeConfigurationWriteProbePassed === true],
    ["runtime neighbor probe", receipt.runtimeConfigurationNeighborDenied === true], ["registered project read probe", !normalizeProjectScope(config) || receipt.registeredProjectReadsAllowed === true],
    ["unassigned project write probe", !normalizeProjectScope(config) || receipt.unassignedProjectWritesDenied === true],
    ["protected path probe", !normalizeProjectScope(config) || receipt.protectedPathsDenied === true],
    ["parent directory probe", !normalizeProjectScope(config) || receipt.parentUserDirectoryDenied === true],
    ["API billing", receipt.apiKeyAuthenticationAllowed === false], ["credential copying", receipt.credentialsCopied === false],
    ["authentication directory probe", receipt.authenticationDirectoryReadAllowed === true],
  ];
  const mismatches = checks.filter(([, valid]) => !valid).map(([name]) => name);
  if (mismatches.length > 0) {
    throw new Error(`Claude write-isolation receipt is stale or incomplete (${mismatches.join(", ")}); rerun the approved non-model host acceptance`);
  }
  return receipt;
}

export function assertClaudeImplementationDispatchAllowed(config: ClaudeAdapterConfig, workspace: string): ClaudeWriteIsolationReceipt | undefined {
  if (!config.enabled || !config.dispatchAuthorized || !config.implementationDispatchAuthorized) {
    throw new Error("Claude implementation dispatch is disabled");
  }
  if (!config.implementationPrepared) throw new Error("Claude implementation adapter is not prepared");
  if (config.automaticStartup) throw new Error("Claude automatic startup must remain disabled");
  if (!config.spendingRouteReviewed) throw new Error("Claude spending route has not been reviewed");
  assertSafeConfig(config, workspace);
  if (config.readOnlyOnly) throw new Error("Claude configuration remains read-only");
  buildClaudeImplementationPlan(config, workspace, "dispatch-boundary-check");
  return validatedWriteIsolationReceipt(config, workspace);
}

function saveClaudeEvidence(
  evidence: { stdout: string; stderr: string; captureWorkspace?: boolean },
  sink?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void,
): string | undefined {
  try { sink?.(evidence); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

function spawnClaude(
  config: ClaudeAdapterConfig,
  args: string[],
  workspace: string,
  configurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: ClaudeSpawn; terminate?: (child: ReturnType<ClaudeSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<ClaudeExecutionResult> {
  const effectiveSpawn = options.spawn ?? claudeSpawnForTests;
  return new Promise((resolveResult) => {
    mkdirSync(resolve(configurationDirectory, "tmp"), { recursive: true });
    const writablePaths = config.readOnlyOnly ? [] : normalizeWritableWorkspacePaths(config.writableWorkspacePaths);
    const launch = buildClaudeContainmentLaunch(config, workspace, args, writablePaths, configurationDirectory);
    const child = effectiveSpawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: buildClaudeEnvironment(config, configurationDirectory, workspace),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind: "wall-clock" | "idle" | undefined;
    let aborted = false;
    let settled = false;
    let evidenceError: string | undefined;
    const persist = (captureWorkspace = false) => {
      evidenceError ??= saveClaudeEvidence({ stdout, stderr, captureWorkspace }, options.onEvidence);
    };
    const idleMilliseconds = (config.maximumIdleSeconds ?? 180) * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = config.maximumRuntimeSeconds > 0
      ? setTimeout(() => { timedOut = true; timeoutKind = "wall-clock"; persist(true); abort(); }, config.maximumRuntimeSeconds * 1000)
      : undefined;
    const closeTimers = () => { clearTimeout(timer); clearTimeout(idleTimer); };
    const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      closeTimers();
      signal?.removeEventListener("abort", handleOwnerAbort);
      persist(true);
      resolveResult({ ...result, timedOut, timeoutKind, aborted, evidenceError, stdout, stderr });
    };
    const abort = () => {
      try { (options.terminate ?? terminateWorkerTree)(child); }
      catch (error) { stderr += `\n${String(error)}`; child.kill(); }
    };
    const markActivity = () => {
      persist(false);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; abort(); }, idleMilliseconds);
      }
    };
    const handleOwnerAbort = () => { aborted = true; persist(true); abort(); };
    signal?.addEventListener("abort", handleOwnerAbort, { once: true });
    if (signal?.aborted) { aborted = true; abort(); }
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; markActivity(); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; markActivity(); });
    if (idleMilliseconds > 0) idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; persist(true); abort(); }, idleMilliseconds);
    child.on("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, childSignal) => finish({ exitCode, signal: childSignal }));
  });
}

export async function runClaudeImplementation(
  config: ClaudeAdapterConfig,
  workspace: string,
  objective: string,
  jobConfigurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: ClaudeSpawn; terminate?: (child: ReturnType<ClaudeSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<ClaudeExecutionResult> {
  assertClaudeImplementationDispatchAllowed(config, workspace);
  const plan = buildClaudeImplementationPlan(config, workspace, objective);
  const runtimeRoot = resolve(config.runtimeConfigurationRoot);
  const resolvedJobConfig = resolve(jobConfigurationDirectory);
  const runtimeRelative = relative(runtimeRoot, resolvedJobConfig);
  if (!runtimeRelative || runtimeRelative.startsWith(`..${sep}`) || runtimeRelative === ".." || isAbsolute(runtimeRelative)) {
    throw new Error("Claude job configuration must be inside runtimeConfigurationRoot");
  }
  mkdirSync(resolvedJobConfig, { recursive: true });
  writeFileSync(resolve(resolvedJobConfig, "dispatch-plan.json"), `${JSON.stringify({ ...plan, credentialsCopied: false, apiKeyAuthenticationAllowed: false }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const result = await spawnClaude(config, plan.args, plan.cwd, resolvedJobConfig, signal, options);
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
    try { parseClaudeResult(result.stdout); }
    catch (error) {
      return {
        ...result,
        exitCode: 1,
        error: `Claude exited without one verified success result: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return result;
}

export function parseClaudeResult(jsonl: string): ClaudeResultReceipt {
  const results: ClaudeResultReceipt[] = [];
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const item = event as Record<string, unknown>;
    if (item.type !== "result") continue;
    const isError = item.is_error === true || item.subtype === "error";
    if (isError) continue;
    const resultText = typeof item.result === "string" ? item.result
      : typeof item.content === "string" ? item.content
      : null;
    const sessionId = typeof item.session_id === "string" ? item.session_id
      : typeof item.sessionId === "string" ? item.sessionId
      : null;
    if (!resultText || !sessionId) continue;
    const usageRaw = item.usage;
    let usage: ClaudeResultReceipt["usage"] = null;
    if (usageRaw !== undefined) {
      if (typeof usageRaw !== "object" || usageRaw === null) throw new Error("Claude result usage is malformed");
      const record = usageRaw as Record<string, unknown>;
      const inputTokens = Number(record.input_tokens ?? record.inputTokens);
      const outputTokens = Number(record.output_tokens ?? record.outputTokens);
      const cacheReadTokens = Number(record.cache_read_input_tokens ?? record.cacheReadTokens ?? 0);
      const cacheWriteTokens = Number(record.cache_creation_input_tokens ?? record.cacheWriteTokens ?? 0);
      if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Claude result usage token fields are malformed");
      }
      usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    }
    results.push({
      result: resultText,
      sessionId,
      requestId: typeof item.request_id === "string" ? item.request_id : typeof item.requestId === "string" ? item.requestId : null,
      durationMs: Number.isFinite(item.duration_ms) ? Number(item.duration_ms) : Number.isFinite(item.durationMs) ? Number(item.durationMs) : null,
      usage,
    });
  }
  if (results.length !== 1) throw new Error(`Expected exactly one successful Claude result event; found ${results.length}`);
  return results[0];
}

export function inspectClaudeCli(config: Partial<ClaudeAdapterConfig> & { executable?: string }): Record<string, unknown> {
  if (config.enabled !== true) {
    return { installed: false, modelInvoked: false, reason: "Optional Claude is disabled", supportClaim: false };
  }
  if (typeof config.executable !== "string" || !config.executable.trim()) {
    return { installed: false, modelInvoked: false, reason: "Optional Claude is not configured", supportClaim: false };
  }
  if (config.authentication && config.authentication !== "subscription-signin") {
    return { installed: false, modelInvoked: false, reason: "Claude API-key authentication is prohibited", supportClaim: false };
  }
  if ((config.apiKeyAuthenticationAllowed as unknown) === true) {
    return { installed: false, modelInvoked: false, reason: "Claude API-key billing is prohibited", supportClaim: false };
  }
  const version = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, timeout: 15_000,
  });
  if (version.error || version.status !== 0) {
    return {
      installed: false,
      executable: config.executable,
      modelInvoked: false,
      error: version.error?.message || version.stderr || "version probe failed",
      supportClaim: false,
    };
  }
  return {
    installed: true,
    executable: config.executable,
    version: String(version.stdout || version.stderr || "").trim(),
    modelInvoked: false,
    billing: "subscription-signin-only",
    supportClaim: false,
  };
}

export function qualifyClaudeDispatchBoundaries(config: ClaudeAdapterConfig, workspace: string): {
  workspace: true;
  reads: true;
  writes: boolean;
  shell: boolean;
  history: true;
  credentials: true;
  network: true;
  patch: boolean;
} {
  assertSafeConfig(config, workspace);
  const writable = normalizeWritableWorkspacePaths(config.writableWorkspacePaths ?? []);
  return {
    workspace: true,
    reads: true,
    writes: !config.readOnlyOnly && writable.length > 0,
    shell: Boolean(config.developmentMode) && !config.readOnlyOnly,
    history: true,
    credentials: true,
    network: true,
    patch: !config.readOnlyOnly && writable.length > 0,
  };
}
