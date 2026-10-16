import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BackupManifest } from "./worker-isolation.ts";
import { excludedDevelopmentPath as excludedDevelopmentPathImpl } from "./excluded-development-path.mjs";

// Credentials/runtime metadata and local staging mirrors (PR-split, tool caches).
export function excludedDevelopmentPath(path: string): boolean {
  return excludedDevelopmentPathImpl(path);
}

export function developmentManifest(projectRoot: string): BackupManifest {
  if (!isAbsolute(projectRoot)) throw new Error("Use the selected project's absolute folder path");
  const root = realpathSync(projectRoot);
  if (!lstatSync(root).isDirectory() || dirname(root) === root) throw new Error("Select a project folder, not a drive root");
  let names: string[];
  let revision = "unversioned";
  try {
    const git = (args: string[]) => execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
    const gitRoot = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
    if (gitRoot.toLowerCase() !== root.toLowerCase()) throw new Error("not repository root");
    names = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
    try { revision = git(["rev-parse", "HEAD"]).trim(); } catch { /* unborn repository */ }
  } catch {
    names = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        const path = relative(root, full).replaceAll("\\", "/");
        if (excludedDevelopmentPath(path)) continue;
        if (entry.isSymbolicLink()) throw new Error(`Project link needs an explicit target: ${path}`);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) names.push(path);
      }
    };
    visit(root);
  }
  const files = names.filter((path) => !excludedDevelopmentPath(path) && existsSync(join(root, path))).sort().map((path) => {
    if (path.split("/").includes("..") || isAbsolute(path)) throw new Error("Project path escapes its root");
    const full = join(root, path);
    if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error(`Unsupported project file: ${path}`);
    const data = readFileSync(full);
    return { path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex").toUpperCase() };
  });
  return { schemaVersion: 1, source: { projectRoot: root, baseRevision: revision }, files };
}

export function writeDevelopmentManifest(projectRoot: string, path: string): void {
  writeFileSync(path, `${JSON.stringify(developmentManifest(projectRoot), null, 2)}\n`);
}

/** Local project-specific recovery copy; no remote upload or retention deletion. */
export class ProjectCheckpointDriver {
  private readonly options: { projectRoot: string; checkpointRoot: string };
  constructor(options: { projectRoot: string; checkpointRoot: string }) { this.options = options; }
  async createVerifiedCheckpoint(jobId: string): Promise<string> {
    const manifest = developmentManifest(this.options.projectRoot);
    const directory = join(this.options.checkpointRoot, `${jobId}-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    for (const file of manifest.files) {
      const target = join(directory, "files", file.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(manifest.source.projectRoot, file.path), target);
      if (createHash("sha256").update(readFileSync(target)).digest("hex").toUpperCase() !== file.sha256) throw new Error(`Checkpoint verification failed: ${file.path}`);
    }
    const receipt = resolve(directory, "receipt.json");
    writeFileSync(receipt, JSON.stringify({ verified: true, kind: "project-source-checkpoint", ...manifest }, null, 2));
    return receipt;
  }
}
