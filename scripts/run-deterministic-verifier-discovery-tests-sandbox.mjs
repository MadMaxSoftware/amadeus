/**
 * Sandbox-friendly checks for verification-checks.mjs sandbox-runner selection.
 * Loads the module via data: URL so restricted Windows sandboxes never
 * realpath() entry files under C:\.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

async function loadModule() {
  const absolute = path.join(root, "src", "verification-checks.mjs");
  const source = fs.readFileSync(absolute, "utf8");
  return import(toDataUrl(source));
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

const verifier = await loadModule();

await test("resolveSandboxTestRunner maps amadeus updates providers test", () => {
  assert.equal(
    verifier.resolveSandboxTestRunner(root, "test/amadeus-updates-providers.test.mjs"),
    "scripts/run-updates-providers-tests-sandbox.mjs",
  );
  assert.equal(
    verifier.resolveSandboxTestRunner(root, "test/deterministic-verifier-discovery.test.mjs"),
    "scripts/run-deterministic-verifier-discovery-tests-sandbox.mjs",
  );
  assert.equal(verifier.resolveSandboxTestRunner(root, "test/missing.test.mjs"), null);
});

await test("buildSandboxPipeCheck uses powershell stdin pipe", () => {
  const check = verifier.buildSandboxPipeCheck("scripts/run-updates-providers-tests-sandbox.mjs", "node");
  assert.equal(check.executable, "powershell");
  const joined = check.args.join(" ");
  assert.ok(joined.includes("Get-Content"));
  assert.ok(joined.includes("--input-type=module"));
  assert.ok(joined.includes("run-updates-providers-tests-sandbox.mjs"));
  assert.ok(joined.includes("$env:NODE_OPTIONS=''"), "must clear host NODE_OPTIONS for sandbox Node");
});

await test("buildSandboxPipeCheck sets the project cwd inside piped Node", () => {
  const workspace = path.join("C:\\", "worker", "workspace");
  const check = verifier.buildSandboxPipeCheck("scripts/run-updates-providers-tests-sandbox.mjs", "node", workspace);
  const joined = check.args.join(" ");
  assert.ok(joined.includes("process.chdir"));
  assert.ok(joined.includes("StartsWith('#!')"));
  assert.ok(joined.includes("run-updates-providers-tests-sandbox.mjs"));
});

await test("auto-discovery prefers sandbox runner over node --test", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "amadeus-verifier-auto-"));
  fs.mkdirSync(path.join(temp, "test"), { recursive: true });
  fs.mkdirSync(path.join(temp, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(temp, "package.json"), `${JSON.stringify({ type: "module", scripts: {} }, null, 2)}\n`);
  fs.writeFileSync(path.join(temp, "test", "amadeus-updates-providers.test.mjs"), "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  fs.writeFileSync(path.join(temp, "scripts", "run-updates-providers-tests-sandbox.mjs"), "console.log(\"sandbox\");\n");
  const checks = verifier.discoverVerificationChecks(temp, ["test/amadeus-updates-providers.test.mjs"]);
  assert.ok(checks.some((check) => check.command === "git diff --check"),
    "temp fixtures without workspace-diff-check keep native git integrity");
  const sandbox = checks.find((check) => String(check.command).includes("run-updates-providers-tests-sandbox.mjs"));
  assert.ok(sandbox, "expected sandbox pipe check");
  assert.equal(sandbox.executable, "powershell");
  assert.ok(!checks.some((check) => Array.isArray(check.args) && check.args[0] === "--test"),
    "must not fall back to direct node --test when sandbox runner exists");
});

await test("coordinator.verify sandbox scripts become powershell pipes", () => {
  const checks = verifier.discoverVerificationChecks(root, []);
  assert.equal(checks[0]?.command, "powershell pipe scripts/workspace-diff-check.mjs");
  assert.equal(checks.filter((check) => check.command === "powershell pipe scripts/workspace-diff-check.mjs").length, 1);
  assert.ok(!checks.some((check) => check.command === "git diff --check"));
  assert.ok(checks.some((check) => String(check.command).includes("run-updates-providers-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-deterministic-verifier-discovery-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-excluded-path-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-branding-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("workspace-diff-check")));
  assert.ok(checks.some((check) => String(check.command).includes("powershell pipe scripts/workspace-diff-check.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-public-safety-sandbox.mjs")));
  assert.ok(checks.every((check) => check.command === "git diff --check" || check.executable === "powershell" || check.tool === "npm"));
});

await test("workspace diff check runs through the cwd-aware PowerShell pipe", () => {
  assert.match(fs.readFileSync(path.join(root, "scripts", "workspace-diff-check.mjs"), "utf8"), /^#!\/usr\/bin\/env node/);
  const check = verifier.discoverVerificationChecks(root, [])
    .find((candidate) => candidate.command === "powershell pipe scripts/workspace-diff-check.mjs");
  assert.ok(check);
  const result = spawnSync(check.executable, check.args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /workspace-diff-check: clean/);
});

await test("isDirectWorkspaceIntegrityCheck covers git and workspace-diff-check", () => {
  assert.equal(verifier.isDirectWorkspaceIntegrityCheck({ tool: "git", command: "git diff --check" }), true);
  assert.equal(verifier.isDirectWorkspaceIntegrityCheck({ tool: "node", command: "powershell pipe scripts/workspace-diff-check.mjs" }), true);
  assert.equal(verifier.isDirectWorkspaceIntegrityCheck({ tool: "npm", command: "npm run workspace-diff-check" }), true);
  assert.equal(verifier.isDirectWorkspaceIntegrityCheck({ tool: "npm", command: "npm run public-safety" }), false);
});

await test("discoverVerificationChecks falls back to node --test without sandbox runner", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "amadeus-verifier-"));
  fs.mkdirSync(path.join(temp, "test"), { recursive: true });
  fs.writeFileSync(path.join(temp, "package.json"), `${JSON.stringify({ type: "module", scripts: {} }, null, 2)}\n`);
  fs.writeFileSync(path.join(temp, "test", "plain.test.mjs"), "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  const checks = verifier.discoverVerificationChecks(temp, ["test/plain.test.mjs"]);
  assert.ok(checks.some((check) => check.args?.[0] === "--test"));
});

console.log(`\n# pass ${passed} fail ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
