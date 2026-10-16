import { spawnSync, type ChildProcess } from "node:child_process";

/** Stop this worker and its descendants, never other workers or host processes. */
export function terminateWorkerTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") { child.kill(); return; }
  const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true, encoding: "utf8", timeout: 10_000,
  });
  if (result.status !== 0) {
    try { process.kill(child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    throw new Error(`Worker process-tree termination could not be confirmed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
}
