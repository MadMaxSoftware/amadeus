/**
 * Local-model routing policy helpers (pilot-gated for 0.4.x).
 * Priority: ordinary software → qualified local models → Cursor/Codex fallbacks.
 * Stable channel keeps local automatic routing disabled.
 */
import { excludeUnqualifiedFromRouting } from "./capability-qualification.mjs";
import { describeWorkAllocation, isLocalModelPilotGateOpen } from "./local-model-worker.mjs";
import { listRoutableProviders } from "./provider-registry.mjs";

export const LOCAL_ROUTE_PROVIDER = "local-openai-compatible";

/**
 * Select a local route when the pilot gate is open and a qualified provider exists.
 * Returns null when stable / gate closed / nothing qualified — callers fall back.
 */
export function selectQualifiedLocalRoute(input = {}) {
  const pilotGateOpen = isLocalModelPilotGateOpen(input.pilotGate || {});
  const allocationBase = {
    localModelsConsidered: true,
    localRoutingEnabled: false,
    pilotGateOpen,
    selected: null,
    fallbackReason: null,
  };

  if (!pilotGateOpen) {
    return {
      route: null,
      allocation: describeWorkAllocation({
        ...allocationBase,
        fallbackReason: "Pilot gate closed; stable channel does not auto-route to local models.",
      }),
    };
  }

  const registry = input.registry;
  let candidates = [];
  if (registry) {
    candidates = listRoutableProviders(registry, { requirePilotGate: true, pilotGateOpen: true });
  } else if (Array.isArray(input.candidates)) {
    candidates = excludeUnqualifiedFromRouting(input.candidates);
  }

  if (!candidates.length) {
    return {
      route: null,
      allocation: describeWorkAllocation({
        ...allocationBase,
        localRoutingEnabled: true,
        fallbackReason: "No approved, enabled, and qualified local providers.",
      }),
    };
  }

  // Prefer lowest latency qualified model when available.
  const ranked = [...candidates].sort((a, b) => {
    const la = Number(a.qualification?.models?.find((m) => m.status === "qualified")?.latencyMs ?? Number.POSITIVE_INFINITY);
    const lb = Number(b.qualification?.models?.find((m) => m.status === "qualified")?.latencyMs ?? Number.POSITIVE_INFINITY);
    return la - lb;
  });
  const chosen = ranked[0];
  const modelId = chosen.qualification?.qualifiedModelIds?.[0]
    || chosen.models?.find((m) => (typeof m === "string" ? m : m.id))?.id
    || (typeof chosen.models?.[0] === "string" ? chosen.models[0] : chosen.models?.[0]?.id)
    || null;

  if (!modelId) {
    return {
      route: null,
      allocation: describeWorkAllocation({
        ...allocationBase,
        localRoutingEnabled: true,
        fallbackReason: "Qualified provider has no model id.",
      }),
    };
  }

  const route = {
    provider: LOCAL_ROUTE_PROVIDER,
    model: modelId,
    reasoningEffort: "none",
    endpoint: chosen.openaiEndpoint || chosen.endpoint,
    providerId: chosen.id,
    reason: "Qualified local OpenAI-compatible model selected behind open experimental pilot gate.",
    financialBasis: "no-subscription-local",
    routingPolicy: "balanced-quality",
    taskClass: input.taskClass || "lightweight-reasoning",
    capabilityTier: "local-qualified",
    capabilitySignals: ["approved", "enabled", "capability-qualified", "pilot-gate-open"],
    localModelCandidate: true,
  };

  return {
    route,
    allocation: describeWorkAllocation({
      localModelsConsidered: true,
      localRoutingEnabled: true,
      pilotGateOpen: true,
      selected: { provider: route.provider, model: route.model, providerId: route.providerId },
      fallbackReason: null,
    }),
  };
}

/**
 * Integrate with the existing tier order for a work profile.
 * Deterministic software always wins when applicable (handled by caller).
 */
export function planRouteWithLocalModels(input = {}) {
  const softwareRoute = input.softwareRoute || null;
  if (softwareRoute) {
    return {
      primary: softwareRoute,
      local: null,
      allocation: describeWorkAllocation({
        localModelsConsidered: false,
        localRoutingEnabled: false,
        pilotGateOpen: isLocalModelPilotGateOpen(input.pilotGate || {}),
        selected: { provider: "software" },
        fallbackReason: "Ordinary software handles deterministic work first.",
      }),
      fallbacks: input.subscriptionFallbacks || [],
    };
  }

  const { route: localRoute, allocation } = selectQualifiedLocalRoute(input);
  if (localRoute) {
    return {
      primary: localRoute,
      local: localRoute,
      allocation,
      fallbacks: input.subscriptionFallbacks || [],
    };
  }

  const fallback = Array.isArray(input.subscriptionFallbacks) && input.subscriptionFallbacks.length
    ? input.subscriptionFallbacks[0]
    : null;
  return {
    primary: fallback,
    local: null,
    allocation,
    fallbacks: input.subscriptionFallbacks || [],
  };
}

/** Stable-channel helper used by runtime startup reporting. */
export function stableChannelLocalRoutingStatus() {
  return {
    channel: "stable",
    localAutomaticRouting: false,
    experimentalCodePresent: true,
    pilotGateOpen: false,
    note: "0.4.x local-model routing code is present but disabled on the stable channel until the friend-machine pilot passes.",
  };
}
