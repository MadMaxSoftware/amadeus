/**
 * Live check of a Claude development worker (decision D5): no Claude or Cursor
 * configuration, the Codex MXC sandbox, file edits and one shell command.
 * Makes ONE real Claude subscription call on a throwaway git project next to
 * this repository, then deletes it (set LIVE_KEEP=1 to keep it).
 * Usage: npm run claude:worker-live-check
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
// Outside AppData/Local/Temp/claude, which Claude Code protects as its own folder.
const scratch = process.env.LIVE_SCRATCH || join(repo, "..", "amadeus-claude-worker-live-check");
const src = (name) => pathToFileURL(join(repo, "src", name)).href;
const { ClaudeWorkerDriver } = await import(src("claude-worker-driver.ts"));
const { writeDevelopmentManifest } = await import(src("development-project.ts"));
const { resolveWorkerWorkspaceRoot } = await import(src("worker-workspace-root.ts"));

const project = join(scratch, "live-claude-project");
const stateRoot = join(scratch, "live-claude-state");
for (const old of [project, stateRoot, join(scratch, ".amadeus-worker-workspaces")]) rmSync(old, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
mkdirSync(stateRoot, { recursive: true });
// On exit, print each tool result the worker received (truncated) for diagnosis.
process.on("exit", () => {
  const stream = join(stateRoot, "patches", "live-claude-check-a1.claude-result.jsonl");
  if (!existsSync(stream)) return;
  for (const line of readFileSync(stream, "utf8").split(/\r?\n/)) {
    if (!line.includes("tool_result")) continue;
    try { console.error("TOOL", JSON.stringify(JSON.parse(line).message.content.map((c) => c.content)).slice(0, 500)); } catch {}
  }
});
writeFileSync(join(project, "README.md"), "fixture\n");
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", private: true }) + "\n");
const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
git("init", "-q"); git("add", "."); git("-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-qm", "init");

const manifest = join(stateRoot, "manifest.json");
writeDevelopmentManifest(project, manifest);
const config = join(stateRoot, "stage-worker.json");
writeFileSync(config, JSON.stringify({ developmentMode: true, deniedSourceRoot: project, writableWorkspacePaths: ["."],
  model: null, maximumRuntimeSeconds: 600, maximumIdleSeconds: 180 }, null, 2));

const driver = new ClaudeWorkerDriver({ config, manifest, workspaceRoot: resolveWorkerWorkspaceRoot(project, stateRoot),
  artifactRoot: join(stateRoot, "patches"), heartbeatSeconds: 30 });
const progress = [];
const started = Date.now();
try {
  const result = await driver.run({
    jobId: "live-claude-check", attempt: 1, reservedCredits: 0, goalId: null, goalIteration: null,
    objective: "Create a file named hello.txt containing exactly the text: hi from claude. Then run the shell command `git status --short` and include its output in a one-sentence reply. Do not change any other file.",
    signal: new AbortController().signal, heartbeat: () => {}, progress: (p) => progress.push(p.summary),
  });
  const patch = result.patch ? readFileSync(result.patch.path, "utf8") : null;
  const ok = Boolean(patch?.includes("hello.txt")) && /\?\? hello\.txt/.test(result.outcome);
  if (!ok) process.exitCode = 1;
  console.log(JSON.stringify({ ok, seconds: Math.round((Date.now() - started) / 1000), outcome: result.outcome.slice(0, 200),
    usage: result.providerUsage, changedFiles: result.patch?.changedFiles ?? 0, patchMentionsHello: Boolean(patch?.includes("hello.txt")),
    progress }, null, 2));
} catch (error) {
  const artifacts = join(stateRoot, "patches");
  const tail = (name) => existsSync(join(artifacts, name)) ? readFileSync(join(artifacts, name), "utf8").slice(-1500) : null;
  console.log(JSON.stringify({ ok: false, seconds: Math.round((Date.now() - started) / 1000),
    error: String(error?.message ?? error).slice(0, 2000), progress,
    acceptance: tail("live-claude-check-a1.claude-isolation.acceptance.jsonl"),
    stderr: tail("live-claude-check-a1.claude-stderr.txt") }, null, 2));
  process.exitCode = 1;
}

process.on("exit", () => { if (!process.env.LIVE_KEEP) rmSync(scratch, { recursive: true, force: true }); });
