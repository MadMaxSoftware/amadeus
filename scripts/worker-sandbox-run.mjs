#!/usr/bin/env node
// Run a command inside a real Codex MXC worker sandbox, over a fresh worker copy of this
// repository in the production workspace location, with a worker's environment. Use it to
// check that tests and :sandbox scripts behave the way workers will see them. No model calls.
//
//   npm run worker:sandbox-run -- -- node <npm-cli.js> test
//   npm run worker:sandbox-run -- --build-step [--touch src/file.ts]
//
// --build-step runs the build step declared in .amadeus/verify.json exactly as the
// verifier does; --touch first appends a comment to a file, as a worker edit would.
// Requires Windows and the Codex CLI.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const buildStep = argv.includes("--build-step");
const touch = argv.includes("--touch") ? argv[argv.indexOf("--touch") + 1] : null;
const command = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
if (!buildStep && !command.length) throw new Error("Give a command after --, or --build-step");
const load = (name) => import(pathToFileURL(join(repo, "src", name)).href);
const { materializeWorkspace } = await load("worker-isolation.ts");
const { resolveWorkerWorkspaceRoot } = await load("worker-workspace-root.ts");
const { portableWorkerConfig } = await load("portable-runtime.ts");
const { prepareWorkspaceIsolationAcceptance } = await load("workspace-isolation-acceptance.ts");
const { buildCodexInvocation, buildCodexSandboxCommand, runWorkerCommand, WINDOWS_WORKER_NODE_OPTIONS } = await load("codex-adapter.ts");
const { readBuildStep } = await load("verification-checks.mjs");

const root = mkdtempSync(join(tmpdir(), "amadeus-sandbox-run-"));
// The production layout: beside the project, under parent folders the sandbox denies.
const workspaceRoot = join(resolveWorkerWorkspaceRoot(repo, root), `sandbox-run-${Date.now()}`);
try {
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const files = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter(Boolean)
    .filter((path) => { try { return statSync(join(repo, path)).isFile(); } catch { return false; } })
    .map((path) => {
      const bytes = readFileSync(join(repo, path));
      return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  const manifest = join(artifacts, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: repo, baseRevision: "sandbox-run" }, files }));
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot, workspaceId: "run-a1" });
  const template = JSON.parse(readFileSync(join(repo, "config-templates", "worker-config.json"), "utf8"));
  let config = portableWorkerConfig({ ...template, enabled: true, developmentMode: true, writableWorkspacePaths: ["."], deniedSourceRoot: repo }, repo);
  config = prepareWorkspaceIsolationAcceptance({ adapter: "codex", config, workspace, artifactRoot: artifacts, workspaceId: "run-a1" });
  const permissions = buildCodexInvocation(config, workspace, "No model call", { allowWorkingChanges: true })
    .find((argument) => argument.startsWith("permissions."));
  if (touch) writeFileSync(join(workspace, touch), `${readFileSync(join(workspace, touch), "utf8")}// worker-sandbox-run edit\n`);
  // Workers' own commands get the worker Node options; verifier checks clear them.
  let [executable, ...args] = command;
  let nodeOptions = WINDOWS_WORKER_NODE_OPTIONS;
  if (buildStep) {
    const step = readBuildStep(repo, workspace);
    if (!step) throw new Error(".amadeus/verify.json declares no build step");
    ({ executable, args } = step);
    nodeOptions = "";
    console.log(`[worker-sandbox-run] build step: ${step.command}`);
  }
  const runtimeHome = join(root, "runtime-home");
  mkdirSync(runtimeHome, { recursive: true });
  const result = await runWorkerCommand("codex", buildCodexSandboxCommand(config, workspace, permissions, executable, args),
    workspace, 900, undefined, { CODEX_HOME: runtimeHome, AMADEUS_WORKER: "1", NODE_OPTIONS: nodeOptions }, 300);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const changed = execFileSync("git", ["-c", `safe.directory=${workspace}`, "-C", workspace, "status", "--short"], { encoding: "utf8" });
  console.log(`\n[worker-sandbox-run] changed files:\n${changed || "(none)\n"}[worker-sandbox-run] exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
  process.exitCode = result.exitCode === 0 && !result.timedOut ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
