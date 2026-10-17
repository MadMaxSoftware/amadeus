/**
 * Sandbox rules shared by every worker adapter (plan item 2.9, step 2). Codex,
 * the Claude-style CLIs (Claude Code, Grok Build) and Cursor all run inside the
 * Codex CLI's MXC sandbox; this file is the one place that validates their
 * workspace and project scope and writes their filesystem permissions, so a
 * hardening reaches every provider at once. Where the adapters' earlier copies
 * had drifted apart, the strictest version is the one kept here.
 */
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKER_RUNTIME_DIRECTORY } from "./worker-runtime-layout.ts";

export type ProjectScope = {
  assignedProjectRoot: string;
  readableProjectRoots: string[];
  /** See DeniedPathRule. */
  deniedParentPaths: string[];
  protectedPaths: string[];
  /** Credential, tool-login and personal folders, outside every project (Codex keeps these apart from deniedParentPaths). */
  deniedSensitivePaths?: string[];
};

/**
 * What a config's `deniedParentPaths` lists. Codex workers deny the folders
 * above the project ("ancestors"); Claude-style and Cursor workers, whose
 * policy reads nothing by default, list private folders that must not contain
 * a project ("outside-projects"). The rule is explicit so the two meanings
 * cannot be confused by a later change.
 */
export type DeniedPathRule = "ancestors" | "outside-projects";

export function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

/**
 * Validate the workspace-relative paths a worker may write. Absent means none
 * unless `required`. Never the repository metadata, the isolation receipt or
 * the Amadeus runtime folder; duplicates are compared without letter case.
 */
export function normalizeWritableWorkspacePaths(paths: string[] | undefined, options: { label?: string; required?: boolean } = {}): string[] {
  const label = options.label ?? "Worker";
  if (paths === undefined && !options.required) return [];
  if (!Array.isArray(paths)) throw new Error(`${label} writableWorkspacePaths must be an array`);
  const normalized = paths.map((value) => {
    if (value === ".") return value;
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      throw new Error(`${label} writable paths must be relative forward-slash paths`);
    }
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || parts[0].toLowerCase() === ".git"
      || parts[0].toLowerCase() === WORKER_RUNTIME_DIRECTORY || value === ".worker-isolation.json") {
      throw new Error(`Unsafe ${label} writable path`);
    }
    return value;
  });
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new Error(`Duplicate ${label} writable path`);
  }
  return normalized;
}

/** Validate a config's project scope; null when the config defines none. */
export function normalizeProjectScope(config: {
  assignedProjectRoot?: string; readableProjectRoots?: string[]; deniedParentPaths?: string[];
  protectedPaths?: string[]; deniedSensitivePaths?: string[];
}, options: { label: string; deniedPaths: DeniedPathRule }): ProjectScope | null {
  const { label } = options;
  const configured = config.assignedProjectRoot !== undefined || config.readableProjectRoots !== undefined
    || config.deniedParentPaths !== undefined || config.protectedPaths !== undefined;
  if (!configured) return null;
  if (!config.assignedProjectRoot || !Array.isArray(config.readableProjectRoots)
    || !Array.isArray(config.deniedParentPaths) || !Array.isArray(config.protectedPaths)) {
    throw new Error(`${label} project scope requires assignedProjectRoot, readableProjectRoots, deniedParentPaths, and protectedPaths`);
  }
  const readableProjectRoots = config.readableProjectRoots.map((path) => {
    if (!isAbsolute(path)) throw new Error(`${label} readable project roots must be absolute`);
    const resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`${label} readable project root is missing: ${resolved}`);
    return resolved;
  });
  if (readableProjectRoots.length === 0 || new Set(readableProjectRoots.map((path) => path.toLowerCase())).size !== readableProjectRoots.length) {
    throw new Error(`${label} readable project roots must be nonempty and unique`);
  }
  const assignedProjectRoot = resolve(config.assignedProjectRoot);
  if (!readableProjectRoots.some((path) => isWithin(path, assignedProjectRoot))) {
    throw new Error(`${label} assigned project must be inside a readable account root`);
  }
  const deniedParentPaths = config.deniedParentPaths.map((path) => {
    if (!isAbsolute(path)) throw new Error(`${label} denied parent paths must be absolute`);
    return resolve(path);
  });
  const unique = new Set(deniedParentPaths.map((path) => path.toLowerCase())).size === deniedParentPaths.length;
  if (options.deniedPaths === "ancestors") {
    if (deniedParentPaths.length === 0 || !unique
      || !readableProjectRoots.every((project) => deniedParentPaths.some((parent) => isWithin(parent, project) && parent.toLowerCase() !== project.toLowerCase()))) {
      throw new Error(`${label} denied parent paths must be unique ancestors of every readable project root`);
    }
  } else if (deniedParentPaths.length === 0 || !unique
    || deniedParentPaths.some((denied) => readableProjectRoots.some((root) => isWithin(denied, root)))) {
    throw new Error(`${label} denied user paths must be unique and must not contain readable account roots`);
  }
  const protectedPaths = config.protectedPaths.map((path) => {
    if (!isAbsolute(path)) throw new Error(`${label} protected paths must be absolute`);
    const resolved = resolve(path);
    if (!readableProjectRoots.some((root) => isWithin(root, resolved)) || readableProjectRoots.some((root) => root.toLowerCase() === resolved.toLowerCase())) {
      throw new Error(`${label} protected paths must be strict children of registered project roots`);
    }
    return resolved;
  });
  if (new Set(protectedPaths.map((path) => path.toLowerCase())).size !== protectedPaths.length) {
    throw new Error(`${label} protected paths must be unique`);
  }
  const deniedSensitivePaths = (config.deniedSensitivePaths ?? []).map((path) => {
    if (!isAbsolute(path)) throw new Error(`${label} denied sensitive paths must be absolute`);
    const resolved = resolve(path);
    if (readableProjectRoots.some((root) => isWithin(resolved, root))) throw new Error("A denied sensitive path must not contain a readable project root");
    return resolved;
  });
  return { assignedProjectRoot, readableProjectRoots, deniedParentPaths, protectedPaths, deniedSensitivePaths };
}

/** Workspace contents an isolation check expects to stay unchanged (metadata, receipt, runtime folder, read-only children). */
export function stableWorkspaceChildren(path: string, writablePaths: string[]): string[] {
  if (!existsSync(path)) return [];
  const mutableTopLevels = new Set(writablePaths.filter((value) => value !== ".").map((value) => value.split("/")[0].toLowerCase()));
  const allWorkspaceChildrenMutable = writablePaths.includes(".");
  return readdirSync(path)
    .filter((name) => [".git", ".worker-isolation.json", WORKER_RUNTIME_DIRECTORY].includes(name.toLowerCase())
      || !allWorkspaceChildrenMutable && !mutableTopLevels.has(name.toLowerCase()))
    .map((name) => join(path, name));
}

/** Every folder from each writable path up to the workspace root; refuses paths that leave the workspace. */
export function writableParentChain(workspace: string, writablePaths: string[], label = "Worker"): string[] {
  const root = resolve(workspace);
  const parents = new Set<string>([root]);
  for (const relativePath of writablePaths) {
    const target = relativePath === "." ? root : resolve(root, relativePath);
    let parent = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`${label} writable path parent must be materialized before isolation acceptance: ${relativePath}`);
    }
    while (true) {
      const relativeParent = parent.toLowerCase() === root.toLowerCase() ? "" : relative(root, parent);
      if (parent.toLowerCase() !== root.toLowerCase() && (relativeParent.startsWith(`..${sep}`) || relativeParent === ".." || isAbsolute(relativeParent))) {
        throw new Error(`${label} writable path parent escapes the worker workspace: ${relativePath}`);
      }
      parents.add(parent);
      if (parent.toLowerCase() === root.toLowerCase()) break;
      parent = dirname(parent);
    }
  }
  return [...parents];
}

/** Refuse a workspace containing symbolic links or other reparse points, which could point a write outside it. */
export function assertNoWorkspaceReparsePoints(workspace: string, label = "Worker"): void {
  const pending = [workspace];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`${label} workspace contains a prohibited reparse point: ${path}`);
      if (info.isDirectory()) pending.push(path);
    }
  }
}

/** The workspace must not be, or be inside, the authoritative project (either slash style). */
export function assertWorkspaceOutsideProject(workspace: string, deniedSourceRoot: string, message: string): void {
  const workspaceKey = resolve(workspace).toLowerCase();
  const deniedKey = resolve(deniedSourceRoot).toLowerCase();
  if (workspaceKey === deniedKey || workspaceKey.startsWith(`${deniedKey}\\`) || workspaceKey.startsWith(`${deniedKey}/`)) {
    throw new Error(message);
  }
}

const entry = (path: string, access: "read" | "write" | "deny") => `,${JSON.stringify(path)}="${access}"`;

/** The `:workspace_roots` table: the workspace itself, explicit writable children, and its metadata. */
export function workspacePermissionEntries(writablePaths: string[], metadataAccess: "read" | "deny"): string {
  return [
    `"."="${writablePaths.includes(".") ? "write" : "read"}"`,
    ...writablePaths.filter((path) => path !== ".").map((path) => `${JSON.stringify(path)}="write"`),
    `".git"="${metadataAccess}"`,
    `".worker-isolation.json"="${metadataAccess}"`,
  ].join(",");
}

/**
 * The development-worker policy every provider uses: a read baseline (the
 * Windows sandbox requires one), then the private folders, protected evidence
 * and protected project paths denied, then exact allowances for the project,
 * the worker's own process files and the workspace.
 */
export function developmentFilesystemPolicy(input: {
  scope: ProjectScope;
  /** Folders denied in addition to the scope's own (e.g. the protected evidence folder). */
  extraDenies?: string[];
  /** Files and folders the worker process itself needs to read (executable, shims, sign-in). */
  processReadPaths?: string[];
  workspace: string;
  writablePaths: string[];
  metadataAccess: "read" | "deny";
  /** Extra entries appended verbatim (the per-job runtime layout). */
  runtimePermissions?: string;
}): string {
  const workspaceRoot = resolve(input.workspace);
  const denies = [...input.scope.deniedParentPaths, ...(input.scope.deniedSensitivePaths ?? []), ...(input.extraDenies ?? []).map((path) => resolve(path))]
    .map((path) => entry(path, "deny")).join("");
  const reads = [...input.scope.readableProjectRoots, ...(input.processReadPaths ?? []).map((path) => resolve(path))]
    .map((path) => entry(path, "read")).join("");
  const protectedDenies = input.scope.protectedPaths.map((path) => entry(path, "deny")).join("");
  const workspaceAccess = entry(workspaceRoot, input.writablePaths.includes(".") ? "write" : "read");
  const writes = input.writablePaths.filter((path) => path !== ".").map((path) => entry(resolve(workspaceRoot, path), "write")).join("");
  const metadata = [".git", ".worker-isolation.json"].map((path) => entry(resolve(workspaceRoot, path), input.metadataAccess)).join("");
  return `":root"="read",":minimal"="read"${denies}${reads}${protectedDenies}${workspaceAccess}${writes}${metadata},":workspace_roots"={${workspacePermissionEntries(input.writablePaths, input.metadataAccess)}}${input.runtimePermissions ?? ""}`;
}

/**
 * The bounded (non-development) policy for Claude-style and Cursor workers:
 * nothing is readable by default; only traversal to the project, the project
 * itself, the worker's process files and the workspace are allowed.
 */
export function denyByDefaultFilesystemPolicy(input: {
  scope: ProjectScope; workspacePermissions: string; absoluteWorkspaceWrites: string[]; runtimePermissions: string; processReadPaths: string[];
}): string {
  const traversalReads = [...new Set(input.scope.readableProjectRoots.map((path) => dirname(path)))].map((path) => entry(path, "read")).join("");
  const parentDenies = input.scope.deniedParentPaths.map((path) => entry(path, "deny")).join("");
  const reads = input.scope.readableProjectRoots.map((path) => entry(path, "read")).join("");
  const denies = input.scope.protectedPaths.map((path) => entry(path, "deny")).join("");
  const processReads = input.processReadPaths.map((path) => entry(resolve(path), "read")).join("");
  const exactWrites = input.absoluteWorkspaceWrites.map((path) => entry(path, "write")).join("");
  return `":root"="deny",":minimal"="read"${traversalReads}${parentDenies}${reads}${denies}${processReads},":workspace_roots"={${input.workspacePermissions}}${exactWrites}${input.runtimePermissions}`;
}

/** Launch a worker CLI inside the Codex CLI's MXC sandbox with one named permission profile. */
export function containedLaunch(input: {
  containmentExecutable: string; sandbox: string; profile: string; description: string; filesystem: string; networkEnabled: boolean;
  cwd: string; executable: string; executableArguments?: string[]; args: string[];
}): { executable: string; args: string[]; cwd: string } {
  const permissionDefinition = `{description=${JSON.stringify(input.description)},filesystem={${input.filesystem}},network={enabled=${input.networkEnabled}}}`;
  return {
    executable: input.containmentExecutable,
    args: [
      "sandbox", "-C", input.cwd,
      "-c", `windows.sandbox=${JSON.stringify(input.sandbox)}`,
      "-c", `permissions.${input.profile}=${permissionDefinition}`,
      "-c", `default_permissions=${JSON.stringify(input.profile)}`,
      "-P", input.profile,
      "--", input.executable, ...(input.executableArguments ?? []), ...input.args,
    ],
    cwd: input.cwd,
  };
}
