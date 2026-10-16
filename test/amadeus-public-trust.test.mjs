import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPrivacyFlow, loadPrivacyFlowRegistry } from "../plugins/amadeus/scripts/privacy-guard.mjs";
import { previewSupportBundle, writeApprovedSupportBundle } from "../plugins/amadeus/scripts/support-bundle.mjs";
import { checkForUpdate, defaultConsent, defaultUpdatePaths } from "../plugins/amadeus/scripts/update-manager.mjs";
import { isLocalModelPilotGateOpen, runIsolatedLocalCompletion } from "../plugins/amadeus/scripts/local-model-worker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("privacy registry is default-deny and contains only the approved public flows", () => {
  const registry = loadPrivacyFlowRegistry();
  assert.equal(registry.defaultDecision, "deny");
  assert.deepEqual(registry.flows.map((flow) => flow.id).sort(), [
    "github-release-check",
    "local-openai-compatible",
    "subscription-provider-execution",
  ]);
  assert.ok(registry.flows.every((flow) => flow.explicitConsent === true && flow.defaultEnabled === false));
  assert.throws(() => assertPrivacyFlow({ flowId: "undeclared-network-call", consent: true }),
    (error) => error.code === "UNDECLARED_PRIVACY_FLOW");
});

test("release checks are recipient-, purpose-, and category-bound", () => {
  const valid = {
    flowId: "github-release-check",
    endpoint: "https://api.github.com/repos/MadMaxSoftware/amadeus/releases/latest",
    dataCategories: ["repository-identifier", "http-request-metadata"],
  };
  assert.throws(() => assertPrivacyFlow(valid), (error) => error.code === "PRIVACY_CONSENT_REQUIRED");
  assert.equal(assertPrivacyFlow({ ...valid, consent: true }).flowId, "github-release-check");
  assert.throws(() => assertPrivacyFlow({ ...valid, consent: true, endpoint: "https://example.com/latest" }),
    (error) => error.code === "PRIVACY_ENDPOINT_DENIED");
  assert.throws(() => assertPrivacyFlow({ ...valid, consent: true, dataCategories: ["prompts"] }),
    (error) => error.code === "PRIVACY_CATEGORY_DENIED");
});

test("local-provider flow accepts approved loopback only and rejects LAN/WAN", () => {
  const base = {
    flowId: "local-openai-compatible",
    consent: true,
    dataCategories: ["task-instructions", "approved-project-content"],
  };
  assert.equal(assertPrivacyFlow({ ...base, endpoint: "http://127.0.0.1:11434/v1" }).flowId, "local-openai-compatible");
  assert.throws(() => assertPrivacyFlow({ ...base, endpoint: "http://192.168.1.9:11434/v1" }));
  assert.throws(() => assertPrivacyFlow({ ...base, endpoint: "https://models.example.com/v1" }));
});

test("subscription execution permits only explicitly approved Codex or Cursor", () => {
  const base = {
    flowId: "subscription-provider-execution",
    consent: true,
    dataCategories: ["task-instructions", "isolated-project-content"],
  };
  assert.equal(assertPrivacyFlow({ ...base, provider: "codex-chatgpt-signin" }).flowId, "subscription-provider-execution");
  assert.equal(assertPrivacyFlow({ ...base, provider: "cursor-browser-login" }).flowId, "subscription-provider-execution");
  assert.throws(() => assertPrivacyFlow({ ...base, provider: "unknown-provider" }),
    (error) => error.code === "PRIVACY_PROVIDER_DENIED");
});

test("support bundles are local, previewed, redacted, and never uploaded", () => {
  assert.throws(() => previewSupportBundle({ entries: [] }), (error) => error.code === "USER_INITIATION_REQUIRED");
  const preview = previewSupportBundle({
    userInitiated: true,
    entries: [{ name: "diagnostic.txt", content: "token=super-secret-value C:\\Users\\Example\\project" }],
  });
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.uploaded, false);
  assert.equal(preview.uploadSupported, false);
  assert.doesNotMatch(preview.entries[0].content, /super-secret-value|C:\\Users\\Example/);
  const path = join(mkdtempSync(join(tmpdir(), "amadeus-support-")), "bundle.json");
  assert.throws(() => writeApprovedSupportBundle(path, preview, false),
    (error) => error.code === "SUPPORT_BUNDLE_APPROVAL_REQUIRED");
  const saved = writeApprovedSupportBundle(path, preview, true);
  assert.equal(saved.uploaded, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).uploaded, false);
});

test("update consent is off by default; declined checks make no network call", async () => {
  assert.equal(defaultConsent().updateChecks, false);
  let calls = 0;
  const paths = defaultUpdatePaths(mkdtempSync(join(tmpdir(), "amadeus-update-")));
  const declined = await checkForUpdate({
    paths,
    consent: defaultConsent(),
    currentVersion: "0.3.1",
    force: true,
    fetchLatestRelease: async () => { calls += 1; return { tag_name: "v0.3.2" }; },
  });
  assert.equal(declined.status, "consent-required");
  assert.equal(calls, 0);

  let received;
  const allowed = await checkForUpdate({
    paths,
    consent: { updateChecks: true },
    currentVersion: "0.3.1",
    force: true,
    fetchLatestRelease: async (input) => { received = input; return { tag_name: "v0.3.2" }; },
  });
  assert.equal(allowed.status, "newer");
  assert.equal(received.privacyFlow.flowId, "github-release-check");
});

test("local model execution needs provider-specific approval and remains pilot-gated", async () => {
  const pilotGate = { releaseChannel: "experimental", experimentalEnabled: true, friendPilotPassed: true };
  assert.equal(isLocalModelPilotGateOpen(pilotGate), true);
  await assert.rejects(() => runIsolatedLocalCompletion({
    endpoint: "http://127.0.0.1:11434/v1",
    pilotGate,
    model: "test-model",
    providerApproved: false,
    transport: async () => ({ ok: true }),
  }), (error) => error.code === "PRIVACY_CONSENT_REQUIRED");
  const result = await runIsolatedLocalCompletion({
    endpoint: "http://127.0.0.1:11434/v1",
    pilotGate,
    model: "test-model",
    providerApproved: true,
    transport: async ({ privacy }) => {
      assert.equal(privacy.flowId, "local-openai-compatible");
      return { ok: true, output: "local result" };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(isLocalModelPilotGateOpen({ releaseChannel: "stable", experimentalEnabled: true, friendPilotPassed: true }), false);
});

test("public policy, contribution gate, workflow, and off-by-default machine config ship", () => {
  for (const path of ["PRIVACY.md", "CONTRIBUTING.md", ".github/pull_request_template.md", ".github/workflows/public-safety.yml"]) {
    assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
  }
  const config = JSON.parse(readFileSync(join(root, "plugins", "amadeus", "config.example.json"), "utf8"));
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.runtimeAuthority, "packaged");
  assert.equal(config.developerMode, false);
  assert.equal(config.consents.updateChecks, false);
  assert.equal(config.consents.providerDiscovery, false);
  assert.equal(config.localModelRouting.experimentalPilotGate, false);
  assert.equal(existsSync(join(root, "docs", "USAGE_STATISTICS.md")), true);
  assert.equal(existsSync(join(root, "docs", "LEGACY_COUPLING_AUDIT.md")), true);
  const workflow = readFileSync(join(root, ".github", "workflows", "public-safety.yml"), "utf8");
  assert.match(workflow, /npm run public-safety/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run amadeus:self-test/);
});
