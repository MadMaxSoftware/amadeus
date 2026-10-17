/**
 * Live check of a Codex development worker with the allowlisted worker environment
 * (H9): sign-in found, sandbox accepted, a file edit, and shell commands that use
 * Node and Git. Makes ONE real Codex subscription call on a throwaway git project
 * next to this repository, then deletes it (set LIVE_KEEP=1 to keep it).
 * Usage: npm run codex:worker-live-check
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const scratch = process.env.LIVE_SCRATCH || join(repo, "..", "amadeus-codex-worker-live-check");
const src = (name) => pathToFileURL(join(repo, "src", name)).href;
const { CodexWorkerDriver } = await import(src("codex-worker-driver.ts"));
const { writeDevelopmentManifest } = await import(src("development-project.ts"));
const { resolveWorkerWorkspaceRoot } = await import(src("worker-workspace-root.ts"));

const project = join(scratch, "live-codex-project");
const stateRoot = join(scratch, "live-codex-state");
for (const old of [project, stateRoot, join(scratch, ".amadeus-worker-workspaces")]) rmSync(old, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
mkdirSync(stateRoot, { recursive: true });
writeFileSync(join(project, "README.md"), "fixture\n");
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", private: true }) + "\n");
const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
git("init", "-q"); git("add", "."); git("-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-qm", "init");

const manifest = join(stateRoot, "manifest.json");
writeDevelopmentManifest(project, manifest);
const template = JSON.parse(readFileSync(join(repo, "config-templates", "worker-config.json"), "utf8"));
const config = join(stateRoot, "worker-config.json");
writeFileSync(config, JSON.stringify({ ...template, enabled: true, paidDispatchEnabled: true, developmentMode: true,
  deniedSourceRoot: project, writableWorkspacePaths: ["."], maximumRuntimeSeconds: 600, maximumIdleSeconds: 180 }, null, 2));

const driver = new CodexWorkerDriver({ config, manifest, workspaceRoot: resolveWorkerWorkspaceRoot(project, stateRoot),
  artifactRoot: join(stateRoot, "patches"), heartbeatSeconds: 30 });
const progress = [];
const started = Date.now();
try {
  const result = await driver.run({
    jobId: "live-codex-check", attempt: 1, reservedCredits: 0, goalId: null, goalIteration: null,
    objective: "Create a file named hello.txt containing exactly the text: hi from codex. Then run the shell commands `node --version` and `git status --short` and include both outputs in a one-sentence reply. Do not change any other file.",
    signal: new AbortController().signal, heartbeat: () => {}, progress: (p) => progress.push(p.summary),
  });
  const patch = result.patch ? readFileSync(result.patch.path, "utf8") : null;
  const ok = Boolean(patch?.includes("hello.txt")) && /\bv\d+\.\d+/.test(result.outcome) && /hello\.txt/.test(result.outcome);
  if (!ok) process.exitCode = 1;
  console.log(JSON.stringify({ ok, seconds: Math.round((Date.now() - started) / 1000), outcome: result.outcome.slice(0, 300),
    inputTokens: result.usage?.inputTokens ?? null, changedFiles: result.patch?.changedFiles ?? 0, progress }, null, 2));
} catch (error) {
  const artifacts = join(stateRoot, "patches");
  const tail = (name) => existsSync(join(artifacts, name)) ? readFileSync(join(artifacts, name), "utf8").slice(-1500) : null;
  console.log(JSON.stringify({ ok: false, seconds: Math.round((Date.now() - started) / 1000),
    error: String(error?.message ?? error).slice(0, 2000), progress, stderr: tail("live-codex-check-a1.stderr.txt") }, null, 2));
  process.exitCode = 1;
}

process.on("exit", () => { if (!process.env.LIVE_KEEP) rmSync(scratch, { recursive: true, force: true }); });
