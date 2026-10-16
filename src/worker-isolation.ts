import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export type ManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  state?: string;
};

export type BackupManifest = {
  schemaVersion: number;
  source: { projectRoot: string; baseRevision: string };
  files: ManifestFile[];
};

export type IsolationReceipt = {
  schemaVersion: 1;
  workspaceId: string;
  sourceRevision: string;
  sourceManifestSha256: string;
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

const receiptName = ".worker-isolation.json";
const forbiddenSegments = new Set([
  ".git",
]);

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizeManifestPath(input: string): string {
  const value = input.replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Manifest path must be relative: ${input}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe manifest path: ${input}`);
  }
  if (parts.some((part) => forbiddenSegments.has(part.toLowerCase()))) {
    throw new Error(`Forbidden path in worker manifest: ${input}`);
  }
  return parts.join("/");
}

function containedPath(root: string, relativePath: string): string {
  const candidate = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${relativePath}`);
  }
  return candidate;
}

function regularSourcePath(root: string, relativePath: string): string {
  let current = root;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) ||
        (index === parts.length - 1 && !info.isFile())) {
      throw new Error(`Source path contains a link or non-regular component: ${relativePath}`);
    }
  }
  return current;
}

export function loadManifest(manifestPath: string): BackupManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.schemaVersion !== 1 || !manifest.source?.projectRoot || !manifest.source?.baseRevision) {
    throw new Error("Unsupported or incomplete backup manifest");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Worker manifest has no files");
  }
  return manifest;
}

export function validateManifestSources(manifestPathInput: string): {
  manifestPath: string;
  manifestSha256: string;
  sourceRoot: string;
  sourceRevision: string;
  files: number;
  bytes: number;
} {
  const manifestPath = realpathSync(manifestPathInput);
  const manifest = loadManifest(manifestPath);
  const sourceRoot = realpathSync(manifest.source.projectRoot);
  const seen = new Set<string>();
  let bytes = 0;
  for (const item of manifest.files) {
    const path = normalizeManifestPath(item.path);
    if (seen.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
    seen.add(path);
    const source = regularSourcePath(sourceRoot, path);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source is not a regular file: ${path}`);
    if (info.size !== item.bytes || sha256(source) !== item.sha256.toUpperCase()) {
      throw new Error(`Source changed since manifest preparation: ${path}`);
    }
    bytes += info.size;
  }
  return {
    manifestPath,
    manifestSha256: sha256(manifestPath),
    sourceRoot,
    sourceRevision: manifest.source.baseRevision,
    files: seen.size,
    bytes,
  };
}

export function materializeWorkspace(input: {
  manifestPath: string;
  workspaceRoot: string;
  workspaceId: string;
}): { workspace: string; receipt: IsolationReceipt } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.workspaceId)) {
    throw new Error("workspaceId must be 1-64 safe filename characters");
  }
  const manifestPath = realpathSync(input.manifestPath);
  const manifest = loadManifest(manifestPath);
  const sourceRoot = realpathSync(manifest.source.projectRoot);
  const workspaceRoot = resolve(input.workspaceRoot);
  mkdirSync(workspaceRoot, { recursive: true });
  const workspace = containedPath(workspaceRoot, input.workspaceId);
  if (existsSync(workspace)) throw new Error(`Workspace already exists: ${workspace}`);
  mkdirSync(workspace, { recursive: false });

  const seen = new Set<string>();
  const copied: IsolationReceipt["files"] = [];
  for (const item of manifest.files) {
    const path = normalizeManifestPath(item.path);
    if (seen.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
    seen.add(path);
    const source = regularSourcePath(sourceRoot, path);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source is not a regular file: ${path}`);
    const sourceHash = sha256(source);
    if (info.size !== item.bytes || sourceHash !== item.sha256.toUpperCase()) {
      throw new Error(`Source changed since manifest preparation: ${path}`);
    }
    const destination = containedPath(workspace, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (sha256(destination) !== sourceHash) throw new Error(`Copy verification failed: ${path}`);
    copied.push({ path, bytes: info.size, sha256: sourceHash });
  }

  const receipt: IsolationReceipt = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    sourceRevision: manifest.source.baseRevision,
    sourceManifestSha256: sha256(manifestPath),
    createdAt: new Date().toISOString(),
    files: copied,
  };
  writeFileSync(join(workspace, receiptName), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  git(workspace, ["init", "-b", "worker"]);
  git(workspace, ["config", "user.name", "Amadeus"]);
  git(workspace, ["config", "user.email", "coordinator@localhost.invalid"]);
  git(workspace, ["add", "--force", "--all"]);
  execFileSync("git", ["-c", `safe.directory=${workspace}`, "-C", workspace, "commit", "-m", `Isolated worker snapshot ${input.workspaceId}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  // State migration may expose the workspace root through an AppData junction.
  // MXC evaluates the launch path itself, so return the canonical target rather
  // than an AppData alias that Windows treats as non-writable.
  const canonicalWorkspace = realpathSync(workspace);
  verifyWorkspace(canonicalWorkspace);
  return { workspace: canonicalWorkspace, receipt };
}

export function materializeWritableWorkspacePaths(workspaceInput: string, paths: string[]): void {
  const workspace = realpathSync(workspaceInput);
  if (!Array.isArray(paths)) {
    throw new Error("writableWorkspacePaths must be an array");
  }
  const seen = new Set<string>();
  for (const input of paths) {
    if (input === ".") continue;
    const path = normalizeManifestPath(input);
    if (seen.has(path)) throw new Error(`Duplicate writable workspace path: ${path}`);
    seen.add(path);
    const target = containedPath(workspace, path);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new Error(`Writable workspace path is not a regular file or directory: ${path}`);
      }
      continue;
    }
    mkdirSync(target, { recursive: true });
    if (!statSync(target).isDirectory()) throw new Error(`Failed to materialize writable workspace directory: ${path}`);
  }
}

export function verifyWorkspace(workspaceInput: string, options: { allowWorkingChanges?: boolean } = {}): IsolationReceipt {
  const workspace = realpathSync(workspaceInput);
  const receipt = JSON.parse(readFileSync(join(workspace, receiptName), "utf8")) as IsolationReceipt;
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.files)) throw new Error("Invalid isolation receipt");
  if (git(workspace, ["rev-list", "--all", "--count"]) !== "1") {
    throw new Error("Worker repository must contain exactly one commit");
  }
  if (git(workspace, ["rev-list", "--max-parents=0", "--all", "--count"]) !== "1") {
    throw new Error("Worker commit must be a history-free root commit");
  }
  if (git(workspace, ["remote"])) throw new Error("Worker repository must not have remotes");

  const expected = new Set([receiptName, ...receipt.files.map((file) => normalizeManifestPath(file.path))]);
  const reachable = git(workspace, ["log", "--all", "--format=", "--name-only"])
    .split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
  for (const path of reachable) {
    normalizeManifestPath(path === receiptName ? "worker-receipt.json" : path);
    if (!expected.has(path)) throw new Error(`Unexpected path reachable through Git history: ${path}`);
  }
  if (new Set(reachable).size !== expected.size) throw new Error("Git history does not match isolation receipt");
  if (!options.allowWorkingChanges && git(workspace, ["status", "--porcelain=v1"])) throw new Error("Worker repository is not clean");
  return receipt;
}
