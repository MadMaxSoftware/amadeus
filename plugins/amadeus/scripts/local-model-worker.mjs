/**
 * Isolated OpenAI-compatible local-model worker (0.4.x experimental path).
 * Loopback-only network, tool allowlist, no credential reads, no telemetry.
 * Stable channel must keep this disabled until the friend-machine pilot passes.
 */
import { assertLoopbackOnly } from "./provider-discovery.mjs";
import { assertPrivacyFlow } from "./privacy-guard.mjs";

export const LOCAL_WORKER_SCHEMA = 1;

/** Default tool allowlist for the isolated local worker. */
export const DEFAULT_TOOL_ALLOWLIST = Object.freeze([
  "read_file",
  "list_directory",
  "run_deterministic_test",
  "apply_authorized_patch",
]);

export const PILOT_GATE = Object.freeze({
  /** Stable 0.3.x channel never auto-routes to local models. */
  stableChannelEnablesLocalRouting: false,
  /** Env / config flag that may open the experimental path after pilot. */
  experimentalFlag: "AMADEUS_EXPERIMENTAL_LOCAL_MODEL_ROUTING",
  /** Product gate: do not claim a friend pilot occurred from this codebase. */
  requiresFriendPilotEvidence: true,
  friendPilotEvidenceEnv: "AMADEUS_FRIEND_PILOT_PASSED",
  releaseChannelStable: "stable",
  releaseChannelExperimental: "experimental",
});

/**
 * Determine whether the experimental local-model routing path may run.
 * Stable channel always returns false unless explicitly marked experimental
 * AND friend-pilot evidence flag is present. Never invent pilot completion.
 */
export function isLocalModelPilotGateOpen(options = {}) {
  const channel = String(options.releaseChannel || process.env.AMADEUS_RELEASE_CHANNEL || PILOT_GATE.releaseChannelStable).toLowerCase();
  if (channel === PILOT_GATE.releaseChannelStable || options.forceStable === true) {
    // Stable channel: never enable automatic local-model routing.
    if (options.allowStableOverride === true && options.friendPilotPassed === true && options.experimentalEnabled === true) {
      // Even with override knobs, stable product policy keeps gate closed.
      return false;
    }
    return false;
  }
  const experimentalEnabled = options.experimentalEnabled === true
    || String(process.env[PILOT_GATE.experimentalFlag] || "").toLowerCase() === "true";
  const friendPilotPassed = options.friendPilotPassed === true
    || String(process.env[PILOT_GATE.friendPilotEvidenceEnv] || "").toLowerCase() === "true";
  if (!experimentalEnabled) return false;
  if (PILOT_GATE.requiresFriendPilotEvidence && !friendPilotPassed) return false;
  return true;
}

export function createIsolatedWorkerConfig(input = {}) {
  const endpoint = assertLoopbackOnly(input.endpoint || "http://127.0.0.1:11434/v1");
  const allowlist = Array.isArray(input.toolAllowlist) ? [...input.toolAllowlist] : [...DEFAULT_TOOL_ALLOWLIST];
  return {
    schemaVersion: LOCAL_WORKER_SCHEMA,
    networkPolicy: "loopback-only",
    endpoint: endpoint.href,
    host: endpoint.host,
    port: endpoint.port,
    toolAllowlist: allowlist,
    credentials: null,
    telemetry: false,
    uploadHardware: false,
    uploadModelData: false,
    uploadPromptData: false,
    uploadSourcePaths: false,
    uploadExecutionData: false,
    isolation: {
      loopbackOnly: true,
      denyLan: true,
      denyWan: true,
      readCredentials: false,
      inspectUnrelatedDocuments: false,
    },
  };
}

export function assertToolAllowed(toolName, allowlist = DEFAULT_TOOL_ALLOWLIST) {
  const name = String(toolName || "").trim();
  if (!allowlist.includes(name)) {
    const error = new Error(`Tool '${name}' is not on the local-model worker allowlist.`);
    error.code = "TOOL_DENIED";
    throw error;
  }
  return name;
}

export function assertWorkerNetwork(url, config) {
  assertLoopbackOnly(url);
  if (config?.networkPolicy && config.networkPolicy !== "loopback-only") {
    const error = new Error(`Unsupported network policy '${config.networkPolicy}'.`);
    error.code = "NETWORK_POLICY";
    throw error;
  }
  return true;
}

/**
 * Execute one isolated chat-completions style call via injected transport.
 * Never reads credentials; never sends beyond loopback.
 */
export async function runIsolatedLocalCompletion(input = {}) {
  const gateOpen = isLocalModelPilotGateOpen(input.pilotGate || {});
  if (!gateOpen && input.requireGate !== false) {
    return {
      ok: false,
      status: "pilot-gate-closed",
      reason: "Local-model worker path is experimental and closed on the stable channel until the friend-machine pilot passes.",
      fallbackSuggested: true,
    };
  }

  const config = input.config ?? createIsolatedWorkerConfig({ endpoint: input.endpoint, toolAllowlist: input.toolAllowlist });
  assertWorkerNetwork(config.endpoint, config);
  const privacyFlow = assertPrivacyFlow({
    flowId: "local-openai-compatible",
    consent: input.providerApproved === true,
    endpoint: config.endpoint,
    dataCategories: ["task-instructions", "approved-project-content"],
  });

  if (Array.isArray(input.requestedTools)) {
    for (const tool of input.requestedTools) assertToolAllowed(tool, config.toolAllowlist);
  }

  const transport = input.transport;
  if (typeof transport !== "function") {
    return {
      ok: false,
      status: "unavailable",
      reason: "No local-model transport configured.",
      fallbackSuggested: true,
    };
  }

  try {
    const result = await transport({
      endpoint: config.endpoint,
      model: input.model,
      messages: input.messages || [],
      // Explicit privacy envelope — transport implementations must honor.
      privacy: {
        flowId: privacyFlow.flowId,
        recipient: privacyFlow.recipient,
        loopbackOnly: true,
        noTelemetry: true,
        noCredentialRead: true,
        noPathUpload: true,
      },
    });
    if (!result || result.ok !== true) {
      return {
        ok: false,
        status: "failed",
        reason: result?.reason || "Local model call failed.",
        fallbackSuggested: true,
        isolation: config.isolation,
      };
    }
    return {
      ok: true,
      status: "completed",
      output: result.output,
      model: input.model,
      isolation: config.isolation,
      toolAllowlist: config.toolAllowlist,
      fallbackSuggested: false,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      fallbackSuggested: true,
      isolation: config.isolation,
    };
  }
}

export function describeWorkAllocation(report = {}) {
  return {
    schemaVersion: 1,
    ordinarySoftwareFirst: true,
    qualifiedLocalModelsSecond: Boolean(report.localModelsConsidered),
    subscriptionFallbacks: ["cursor-browser-login", "codex-chatgpt-signin"],
    localRoutingEnabled: Boolean(report.localRoutingEnabled),
    pilotGateOpen: Boolean(report.pilotGateOpen),
    selected: report.selected || null,
    fallbackReason: report.fallbackReason || null,
    privacy: {
      lanScan: false,
      telemetry: false,
      credentialsRead: false,
    },
  };
}
