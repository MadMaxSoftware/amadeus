/**
 * Capability qualification for local providers/models.
 * Unqualified, inadequate, malformed, slow, or disappearing models are excluded
 * from routing. Proven capability is required before any routing authority.
 */
export const QUALIFICATION_SCHEMA = 1;

export const DEFAULT_LIMITS = Object.freeze({
  maxLatencyMs: 30_000,
  minModels: 1,
  requireOpenAiCompatibleShape: true,
});

/**
 * Qualify a single model probe result.
 * `probeModel` injects: async ({ endpoint, modelId }) =>
 *   ({ ok, latencyMs, malformed, disappeared, output })
 */
export async function qualifyModel(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits || {}) };
  const modelId = String(input.modelId || "").trim();
  if (!modelId) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId: null,
      status: "malformed",
      reason: "Model id missing.",
      routable: false,
    };
  }
  if (typeof input.probeModel !== "function") {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "unavailable",
      reason: "No model probe configured.",
      routable: false,
    };
  }

  let result;
  try {
    result = await input.probeModel({
      endpoint: input.endpoint,
      modelId,
      providerId: input.providerId,
    });
  } catch (error) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      routable: false,
    };
  }

  if (!result || result.disappeared === true) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "disappeared",
      reason: "Model disappeared during qualification.",
      routable: false,
    };
  }
  if (result.malformed === true || (limits.requireOpenAiCompatibleShape && result.ok === true && !isOpenAiCompatibleShape(result.output))) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "malformed",
      reason: "Model response was malformed or not OpenAI-compatible.",
      routable: false,
      latencyMs: result.latencyMs ?? null,
    };
  }
  if (result.ok !== true) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "inadequate",
      reason: result.reason || "Model failed capability probe.",
      routable: false,
      latencyMs: result.latencyMs ?? null,
    };
  }
  const latencyMs = Number(result.latencyMs);
  if (!Number.isFinite(latencyMs) || latencyMs > limits.maxLatencyMs) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      modelId,
      status: "slow",
      reason: `Model latency ${latencyMs}ms exceeds limit ${limits.maxLatencyMs}ms.`,
      routable: false,
      latencyMs,
    };
  }
  return {
    schemaVersion: QUALIFICATION_SCHEMA,
    modelId,
    status: "qualified",
    reason: "Model passed capability probe within latency limits.",
    routable: true,
    latencyMs,
    provenCapabilities: Array.isArray(result.capabilities) ? result.capabilities : ["openai-compatible-chat"],
  };
}

export function isOpenAiCompatibleShape(output) {
  if (!output || typeof output !== "object") return false;
  // Chat completion-like or models list-like
  if (Array.isArray(output.choices)) return output.choices.length > 0;
  if (typeof output.message === "string" && output.message.trim()) return true;
  if (typeof output.content === "string" && output.content.trim()) return true;
  if (Array.isArray(output.data)) return true;
  return false;
}

/**
 * Qualify all models for a provider entry. Provider-level status is qualified
 * only when at least one model qualifies.
 */
export async function qualifyProvider(input = {}) {
  const provider = input.provider;
  if (!provider?.id) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      providerId: null,
      status: "malformed",
      reason: "Provider entry missing id.",
      routable: false,
      models: [],
    };
  }
  if (provider.approved !== true || provider.enabled !== true) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      providerId: provider.id,
      status: "not-enabled",
      reason: "Provider must be approved and enabled before qualification grants routing.",
      routable: false,
      models: [],
    };
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (models.length < (input.limits?.minModels ?? DEFAULT_LIMITS.minModels)) {
    return {
      schemaVersion: QUALIFICATION_SCHEMA,
      providerId: provider.id,
      status: "inadequate",
      reason: "Provider exposes no models to qualify.",
      routable: false,
      models: [],
    };
  }

  const qualifiedModels = [];
  for (const model of models) {
    const modelId = typeof model === "string" ? model : model.id;
    qualifiedModels.push(await qualifyModel({
      modelId,
      endpoint: provider.openaiEndpoint || provider.endpoint,
      providerId: provider.id,
      probeModel: input.probeModel,
      limits: input.limits,
    }));
  }

  const pass = qualifiedModels.filter((m) => m.status === "qualified");
  const status = pass.length > 0 ? "qualified" : aggregateFailureStatus(qualifiedModels);
  return {
    schemaVersion: QUALIFICATION_SCHEMA,
    providerId: provider.id,
    status,
    reason: pass.length > 0
      ? `${pass.length} model(s) qualified.`
      : "No models qualified; provider excluded from routing.",
    routable: pass.length > 0,
    models: qualifiedModels,
    qualifiedModelIds: pass.map((m) => m.modelId),
    qualifiedAt: (input.now ?? new Date()).toISOString(),
  };
}

function aggregateFailureStatus(models) {
  const statuses = models.map((m) => m.status);
  if (statuses.includes("disappeared")) return "disappeared";
  if (statuses.includes("malformed")) return "malformed";
  if (statuses.includes("slow")) return "slow";
  if (statuses.includes("inadequate")) return "inadequate";
  return "inadequate";
}

/**
 * Routing predicate: only approved + enabled + qualified models.
 */
export function isRoutableQualification(qualification) {
  return Boolean(qualification && qualification.status === "qualified" && qualification.routable === true);
}

export function excludeUnqualifiedFromRouting(candidates) {
  return (candidates || []).filter((entry) => {
    if (entry.approved !== true || entry.enabled !== true) return false;
    return isRoutableQualification(entry.qualification);
  });
}
