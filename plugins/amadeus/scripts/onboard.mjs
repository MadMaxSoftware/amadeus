#!/usr/bin/env node
/**
 * Per-machine Amadeus onboarding. Writes private runtime config outside the
 * distributable package and reports missing dependencies clearly.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { onboardingStatus, recordDiscoveryChoice, setupPackagedRuntime } from "./privacy-onboarding.mjs";
import {
  AMADEUS_PRODUCT,
  buildProductionPaths,
  defaultMachineConfigPath,
  lifecycleStatePaths,
  missingDependencyReport,
  writeMachineConfig,
} from "./amadeus-runtime.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}


function discoverSetupRoot(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.AMADEUS_SETUP_ROOT?.trim()) return resolve(process.env.AMADEUS_SETUP_ROOT.trim());
  // Walk from this package: plugin-source/amadeus -> setup candidate
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const here = resolve(pluginRoot, "..", "..");
  const nested = join(here, "coordinator", "src", "coordinator.ts");
  if (existsSync(nested)) return here;
  const flat = join(here, "src", "coordinator.ts");
  if (existsSync(flat)) {
    const parent = resolve(here, "..", "..");
    if (existsSync(join(parent, "coordinator", "src", "coordinator.ts"))) return parent;
    return here;
  }
  throw new Error("Unable to discover setup root. Pass --setup-root <path>.");
}

const configPath = argValue("--config") ? resolve(argValue("--config")) : defaultMachineConfigPath();
const previous = onboardingStatus({ configPath });
const choice = argValue("--discovery-consent");
if (choice && !["allow", "deny", "skip"].includes(choice)) throw new Error("Use --discovery-consent allow, deny, or skip.");
process.stderr.write(`${previous.disclosure}\n`);
let allow = choice === "allow" ? true : choice === "deny" ? false : null;
if (!choice && previous.onboardingRequired && process.stdin.isTTY && !process.argv.includes("--non-interactive")) {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question("Allow later capability discovery? Type yes to allow; Enter keeps it disabled: ");
    allow = answer.trim().toLowerCase() === "yes";
  } finally { terminal.close(); }
}
// A privacy decision is independent of runtime setup and never performs discovery.
const privacyStateRoot = argValue("--state-root") ? resolve(argValue("--state-root")) : previous.stateRoot;
if (allow !== null) recordDiscoveryChoice({ consent: allow, disclosureVersion: previous.disclosureVersion }, { configPath, stateRoot: privacyStateRoot });
if (process.argv.includes("--privacy-only")) {
  process.stdout.write(`${JSON.stringify(onboardingStatus({ configPath, stateRoot: privacyStateRoot }), null, 2)}\n`);
  process.exit(0);
}
if (!argValue("--setup-root")) {
  process.stdout.write(JSON.stringify(setupPackagedRuntime({ configPath, stateRoot: privacyStateRoot }), null, 2) + "\n");
  process.exit(0);
}
const developerMode = process.argv.includes("--developer-mode")
  || String(process.env.AMADEUS_DEVELOPER_MODE ?? "").trim() === "1";
if (!developerMode) {
  process.stderr.write(
    "Refusing --setup-root without developer mode. Public installs use the packaged runtime. "
      + "Pass --developer-mode (or AMADEUS_DEVELOPER_MODE=1) only for a verified Amadeus source checkout.\n",
  );
  process.exit(2);
}
const setupRoot = discoverSetupRoot(argValue("--setup-root"));
const stateRoot = argValue("--state-root")
  ? resolve(argValue("--state-root"))
  : (process.env.AMADEUS_HOME?.trim()
    ? resolve(process.env.AMADEUS_HOME.trim())
    : privacyStateRoot);

const written = writeMachineConfig({
  setupRoot,
  stateRoot,
  developerMode: true,
  runtimeAuthority: "developer-source",
}, configPath);
const paths = buildProductionPaths({
  setupRoot: written.setupRoot,
  stateRoot: written.stateRoot,
  configPath,
  developerMode: true,
  metaUrl: import.meta.url,
});
const report = missingDependencyReport(paths);

const lifecycle = lifecycleStatePaths(written.stateRoot);
const result = {
  ok: report.ok,
  product: `${AMADEUS_PRODUCT.displayName}  -  ${AMADEUS_PRODUCT.descriptor}`,
  publisher: AMADEUS_PRODUCT.publisher,
  configPath,
  config: written,
  privacy: onboardingStatus({ configPath, stateRoot }),
  dependencyReport: report,
  lifecycle: {
    ...lifecycle,
    updateChecksConsentDefault: false,
    providerDiscoveryConsentDefault: false,
    localModelRoutingStableDefault: false,
    guidance: [
      "Update checks against MadMaxSoftware/amadeus require explicit consent (see docs/UPDATE.md).",
      "Computer-only provider discovery requires separate consent; LAN scanning is never enabled (see docs/ONBOARDING.md).",
      "Each discovered provider needs separate approval before enable; detection alone grants no routing authority.",
      "Experimental local-model routing (0.4.x) stays disabled on the stable channel until the friend-machine pilot passes (docs/LOCAL_MODEL_PILOT.md).",
    ],
  },
  compatibility: {
    internalMcpServerId: AMADEUS_PRODUCT.internalMcpServerId,
    note: "Existing durable goals remain readable when stateRoot points at the prior coordinator-state database.",
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!report.ok) {
  process.stderr.write("Amadeus onboarding found missing dependencies. See dependencyReport.missing.\n");
  process.exitCode = 2;
}
