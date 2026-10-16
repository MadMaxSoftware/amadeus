import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKER_RUNTIME_DIRECTORY = ".amadeus-runtime";

/** Prepare an ignored runtime root inside an already isolated Git workspace. */
export function prepareWorkspaceRuntimeRoot(workspace: string): string {
  const root = resolve(workspace);
  const gitDirectory = join(root, ".git");
  const excludePath = join(gitDirectory, "info", "exclude");
  if (!existsSync(gitDirectory) || !lstatSync(gitDirectory).isDirectory() || lstatSync(gitDirectory).isSymbolicLink()) {
    throw new Error("Worker runtime requires an isolated Git workspace");
  }
  const ignoreRule = `${WORKER_RUNTIME_DIRECTORY}/`;
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!existing.split(/\r?\n/).includes(ignoreRule)) {
    appendFileSync(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${ignoreRule}\n`, "utf8");
  }
  const runtimeRoot = join(root, WORKER_RUNTIME_DIRECTORY);
  mkdirSync(runtimeRoot, { recursive: false });
  return runtimeRoot;
}

/** The runtime parent is traversable; only the selected job child is writable. */
export function workerRuntimeLayout(root: string, child?: string): string {
  if (!child) return "";
  const parent = resolve(root);
  const writable = resolve(child);
  const rel = relative(parent, writable);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error("Worker runtime directory must be a direct child of runtimeConfigurationRoot");
  }
  for (const path of [parent]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Worker runtime directory must exist without reparse points: ${path}`);
    }
  }
  return `,${JSON.stringify(parent)}="read",${JSON.stringify(writable)}="write"`;
}
