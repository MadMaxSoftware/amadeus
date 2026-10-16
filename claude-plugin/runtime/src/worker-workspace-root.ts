import { createHash } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";

/** MXC cannot use AppData as a process working directory. Keep disposable
 * workspaces beside (never inside) the assigned project while durable private
 * state remains under the configured Amadeus state root. */
export function resolveWorkerWorkspaceRoot(projectRoot: string, stateRoot: string, platform = process.platform): string {
  const project = resolve(projectRoot);
  if (platform !== "win32") return join(resolve(stateRoot), "worker-workspaces");
  const parent = dirname(project);
  if (parent === parse(project).root) throw new Error("Amadeus MXC workers require a project inside a writable parent directory");
  const key = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 16);
  return join(parent, ".amadeus-worker-workspaces", key);
}
