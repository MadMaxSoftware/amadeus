#!/usr/bin/env node
// Live, non-model check of the Codex development sandbox on this machine.
// Builds a throwaway project, runs the same per-workspace isolation acceptance
// the Codex worker driver runs before any model call, and reports the result.
// Requires Windows and a signed-in Codex desktop install; it never calls a model.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const load = (name) => import(pathToFileURL(join(repo, "src", name)).href);
const { materializeWorkspace } = await load("worker-isolation.ts");
const { portableWorkerConfig } = await load("portable-runtime.ts");
const { prepareWorkspaceIsolationAcceptance } = await load("workspace-isolation-acceptance.ts");
const { buildCodexInvocation } = await load("codex-adapter.ts");

if (process.platform !== "win32") {
  console.log(JSON.stringify({ ok: false, skipped: "The Codex MXC sandbox probe runs on Windows only." }));
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "amadeus-codex-probe-"));
try {
  const project = join(root, "project");
  const artifacts = join(root, "artifacts");
  mkdirSync(project, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(project, "readme.txt"), "probe project\n");
  const bytes = readFileSync(join(project, "readme.txt"));
  const manifest = join(artifacts, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, source: { projectRoot: project, baseRevision: "probe" },
    files: [{ path: "readme.txt", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, "workspaces"), workspaceId: "probe-a1" });
  const template = JSON.parse(readFileSync(join(repo, "config-templates", "worker-config.json"), "utf8"));
  let config = portableWorkerConfig({ ...template, executable: process.env.AMADEUS_CODEX_EXECUTABLE ?? template.executable,
    enabled: true, developmentMode: true, writableWorkspacePaths: ["."], deniedSourceRoot: project }, project);
  config = prepareWorkspaceIsolationAcceptance({ adapter: "codex", config, workspace, artifactRoot: artifacts, workspaceId: "probe-a1" });
  const receipt = JSON.parse(readFileSync(config.isolationReceipt, "utf8"));
  buildCodexInvocation(config, workspace, "probe");
  console.log(JSON.stringify({ ok: true, modelInvoked: false, sensitiveLocationsDenied: config.deniedSensitivePaths.length,
    outsideWorkspaceReadsDenied: receipt.outsideWorkspaceReadsDenied, protectedEvidenceDenied: receipt.protectedEvidenceDenied,
    commandNetworkEnabled: receipt.commandNetworkEnabled }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, modelInvoked: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error) }));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
