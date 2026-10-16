#!/usr/bin/env node
/** Prepare the public packaged runtime without probing the computer. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onboardingStatus, setupPackagedRuntime } from "../plugins/amadeus/scripts/privacy-onboarding.mjs";
import { defaultMachineConfigPath, loadMachineConfig } from "../plugins/amadeus/scripts/amadeus-runtime.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = defaultMachineConfigPath();
const required = [
  join(root, "plugins", "amadeus", "runtime", "src", "coordinator.ts"),
  ...["operations-review.json", "worker-config.json", "cursor-worker-config.json", "claude-worker-config.json"]
    .map(name => join(root, "plugins", "amadeus", "runtime", "config-templates", name)),
];
const missing = required.filter(path => !existsSync(path));
const nodeOk = Number(process.versions.node.split(".")[0]) >= 24;
if (missing.length || !nodeOk) {
  process.stderr.write(JSON.stringify({ ok: false, nodeVersion: process.version, missing,
    guidance: "Use Node 24+ and build the packaged runtime with npm run amadeus:build before setup." }) + "\n");
  process.exitCode = 2;
} else {
  const before = onboardingStatus({ configPath });
  const after = before.state === "ready" && loadMachineConfig(configPath)?.developerMode === true
    ? before
    : setupPackagedRuntime({ configPath, enableClaude: process.argv.includes("--enable-claude") });
  process.stdout.write(JSON.stringify({ ok: after.state === "ready", configPath,
    runtimeAuthority: "packaged", firstRun: !before.configPresent,
    discoveryConsent: after.discoveryConsent, next: ["npm run amadeus:self-test"] }, null, 2) + "\n");
  if (after.state !== "ready") process.exitCode = 2;
}
