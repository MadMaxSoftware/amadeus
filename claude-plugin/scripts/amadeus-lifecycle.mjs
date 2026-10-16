/**
 * Amadeus lifecycle facade: consent-gated updates + provider discovery/registry
 * + pilot-gated local-model routing status for the stable 0.3.x channel.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkForUpdate,
  defaultUpdatePaths,
  declineUpdateConsent,
  grantUpdateConsent,
  hasUpdateConsent,
  loadJson,
  defaultConsent,
  MARKETPLACE_UPGRADE_COMMAND,
  marketplaceUpgradeCommandFor,
} from "./update-manager.mjs";
import {
  defaultDiscoveryPaths,
  declineDiscoveryConsent,
  discoverProviders,
  grantDiscoveryConsent,
  hasDiscoveryConsent,
  defaultDiscoveryConsent,
  mergeManualEndpoint,
  rescanProviders,
  loadDiscoveryJson,
} from "./provider-discovery.mjs";
import {
  addManualEndpoint,
  approveProvider,
  defaultRegistryPath,
  enableProvider,
  listRoutableProviders,
  loadRegistry,
  migrateRegistry,
  recordDiscovery,
  saveRegistry,
  setProviderQualification,
} from "./provider-registry.mjs";
import { qualifyProvider } from "./capability-qualification.mjs";
import {
  isLocalModelPilotGateOpen,
  PILOT_GATE,
} from "./local-model-worker.mjs";
import {
  planRouteWithLocalModels,
  selectQualifiedLocalRoute,
  stableChannelLocalRoutingStatus,
} from "./local-model-routing.mjs";

export function readPluginVersion(pluginRoot) {
  const codexPlugin = join(pluginRoot, ".codex-plugin", "plugin.json");
  const claudePlugin = join(pluginRoot, ".claude-plugin", "plugin.json");
  const hasCodex = existsSync(codexPlugin);
  const hasClaude = existsSync(claudePlugin);
  if (hasCodex && hasClaude) throw new Error("Ambiguous packaged host identity");
  const pluginJson = hasCodex ? codexPlugin : hasClaude ? claudePlugin : null;
  if (!pluginJson) return null;
  try {
    const parsed = JSON.parse(readFileSync(pluginJson, "utf8"));
    return String(parsed.version || "").split("+")[0] || null;
  } catch {
    return null;
  }
}

export function defaultPluginRoot(metaUrl = import.meta.url) {
  try {
    const href = String(metaUrl || "");
    if (href.startsWith("file:")) return dirname(dirname(fileURLToPath(href)));
  } catch {
    // Fall through when evaluated outside a file: URL (tests / sandbox runners).
  }
  return join(process.cwd(), "plugins", "amadeus");
}

/**
 * Read-only lifecycle status for MCP/status tools. Never probes, checks
 * releases, or writes state. Update checks run only through amadeus_check_updates.
 */
export async function runLifecycleStatus(input = {}) {
  const stateRoot = input.stateRoot;
  if (!stateRoot) {
    return {
      ok: false,
      reason: "stateRoot required for lifecycle state.",
      updates: null,
      providers: null,
      localRouting: stableChannelLocalRoutingStatus(),
    };
  }
  const updatePaths = defaultUpdatePaths(stateRoot);
  const discoveryPaths = defaultDiscoveryPaths(stateRoot);
  const registryPath = defaultRegistryPath(stateRoot);
  const pluginRoot = input.pluginRoot ?? defaultPluginRoot();
  const currentVersion = input.currentVersion ?? readPluginVersion(pluginRoot) ?? "0.0.0";

  const updateConsent = loadJson(updatePaths.consentPath, defaultConsent());
  let updates = null;
  if (hasUpdateConsent(updateConsent)) {
    updates = {
      ok: true,
      status: "not-checked",
      checked: false,
      reason: "Status is read-only. Only amadeus_check_updates contacts GitHub, at most once per 24 hours unless forced; this status tool does not.",
    };
  } else {
    updates = {
      ok: false,
      status: "consent-required",
      checked: false,
      reason: "Update checks require explicit owner consent.",
      marketplaceUpgradeCommand: MARKETPLACE_UPGRADE_COMMAND,
    };
  }

  // Normalize in memory only. Status must never write or initiate collection.
  const registry = migrateRegistry(loadRegistry(registryPath));

  return {
    ok: true,
    currentVersion,
    updates,
    providers: {
      discoveryConsent: hasDiscoveryConsent(loadDiscoveryJson(discoveryPaths.consentPath, defaultDiscoveryConsent())),
      registryPath,
      providerCount: Object.keys(registry.providers).length,
      routableOnStable: listRoutableProviders(registry, {
        requirePilotGate: true,
        pilotGateOpen: isLocalModelPilotGateOpen({ releaseChannel: "stable" }),
      }).length,
    },
    localRouting: stableChannelLocalRoutingStatus(),
    pilotGate: {
      ...PILOT_GATE,
      open: isLocalModelPilotGateOpen(input.pilotGate || { releaseChannel: "stable" }),
    },
  };
}

export {
  checkForUpdate,
  grantUpdateConsent,
  declineUpdateConsent,
  hasUpdateConsent,
  MARKETPLACE_UPGRADE_COMMAND,
  marketplaceUpgradeCommandFor,
  defaultUpdatePaths,
  grantDiscoveryConsent,
  declineDiscoveryConsent,
  hasDiscoveryConsent,
  discoverProviders,
  rescanProviders,
  mergeManualEndpoint,
  defaultDiscoveryPaths,
  loadRegistry,
  saveRegistry,
  migrateRegistry,
  recordDiscovery,
  approveProvider,
  enableProvider,
  setProviderQualification,
  listRoutableProviders,
  defaultRegistryPath,
  addManualEndpoint,
  qualifyProvider,
  selectQualifiedLocalRoute,
  planRouteWithLocalModels,
  isLocalModelPilotGateOpen,
  stableChannelLocalRoutingStatus,
  PILOT_GATE,
};
