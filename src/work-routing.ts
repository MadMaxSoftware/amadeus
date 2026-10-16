export type ModelRoute = {
  provider: "codex-chatgpt-signin" | "cursor-browser-login" | "claude-subscription-signin";
  model: string | null;
  reasoningEffort?: string;
};
import type { ModelCatalog, ListedModel } from "./model-catalog.ts";
import { parseWindowsUiObjective, type WindowsUiCommand } from "./windows-ui-automation.ts";
export type DeterministicCommand = "npm-test" | "node-test" | "npm-build" | "npm-lint" | "npm-check" | "npm-typecheck" | WindowsUiCommand;
/** Local OpenAI-compatible route — only selected when pilot gate + qualification allow it. */
export type LocalModelRoute = {
  provider: "local-openai-compatible";
  model: string;
  reasoningEffort: string;
  endpoint?: string;
  providerId?: string;
};
export type WorkRoute = {
  provider: ModelRoute["provider"] | "software" | LocalModelRoute["provider"];
  model: string | null;
  reasoningEffort: string;
  reason: string;
  command?: DeterministicCommand;
  financialBasis: "no-model" | "subscription-suitability-not-price-comparison" | "no-subscription-local";
  routingPolicy: "balanced-quality";
  taskClass: "deterministic" | "routine-implementation" | "lightweight-reasoning" | "complex-reasoning" | "frontier-reasoning" | "provider-fallback" | "explicit";
  capabilityTier: "software" | "cursor-auto" | "efficient" | "workhorse" | "frontier" | "explicit" | "local-qualified";
  capabilitySignals: string[];
  localModelCandidate: boolean;
  endpoint?: string;
  providerId?: string;
};
export type RoutePlanStep = {
  step: "inspect" | "execute" | "verify";
  provider: WorkRoute["provider"];
  model: string | null;
  reasoningEffort: string;
  financialBasis: WorkRoute["financialBasis"];
  reason: string;
};
export type WorkRoutePlan = { schemaVersion: 1; primary: WorkRoute; steps: RoutePlanStep[] };

/**
 * `inherit` is a UI/configuration sentinel, not a provider model name.  It
 * must never reach a worker adapter.  Automatic routing represents that
 * choice by omitting the model and selecting a concrete route below.
 */
export function normalizeRouteModel(value: unknown, context: "automatic" | "pinned" = "automatic"): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const model = String(value).trim();
  if (model.toLowerCase() === "inherit") {
    if (context === "pinned") throw new Error("Invalid pinned model 'inherit'; specify a concrete model or leave routing automatic");
    return null;
  }
  return model;
}

export type WorkProfile = Pick<WorkRoute, "taskClass" | "capabilitySignals" | "localModelCandidate">;

export function providerToAvoidAfterAuthorizedRetry(input: {
  jobStatus: string;
  retryAuthorized: boolean;
  provider: unknown;
}): ModelRoute["provider"] | null {
  if (input.jobStatus !== "failed" || !input.retryAuthorized) return null;
  return input.provider === "codex-chatgpt-signin"
    || input.provider === "cursor-browser-login"
    || input.provider === "claude-subscription-signin"
    ? input.provider
    : null;
}

export function providersToAvoidForRetryChain(attemptsNewestFirst: Array<{
  jobStatus: string;
  retryAuthorized: boolean;
  provider: unknown;
  failureDetail?: unknown;
}>): ModelRoute["provider"][] {
  const avoided = new Set<ModelRoute["provider"]>();
  let insideRetryChain = true;
  for (const attempt of attemptsNewestFirst) {
    const provider = attempt.provider === "codex-chatgpt-signin"
      || attempt.provider === "cursor-browser-login"
      || attempt.provider === "claude-subscription-signin"
      ? attempt.provider
      : null;
    const hardEnvironmentFailure = attempt.jobStatus === "failed"
      && /\bisolation acceptance harness is unavailable\b/i.test(String(attempt.failureDetail ?? ""));
    if (provider && hardEnvironmentFailure) avoided.add(provider);
    if (insideRetryChain && attempt.jobStatus === "failed") {
      const retriedProvider = providerToAvoidAfterAuthorizedRetry(attempt);
      if (retriedProvider) avoided.add(retriedProvider);
    } else {
      insideRetryChain = false;
    }
  }
  return [...avoided];
}

/**
 * Classify the immediate work requested, not broad project-management wording.
 * Words such as "dependency-safe", "authoritative", "reconcile" and
 * "coherent milestone" describe normal operating discipline; they are not
 * evidence that a frontier or workhorse model is required.
 */
export function classifyWork(objective: string): WorkProfile {
  const signals: string[] = [];
  if (/\b(hardest|highest.capability|strongest|frontier|ambiguous|deep analysis|end.to.end|multi.system|novel architecture|repeated failures?)\b/i.test(objective)) {
    signals.push("explicit exceptional-complexity or repeated-failure requirement");
    return { taskClass: "frontier-reasoning", capabilitySignals: signals, localModelCandidate: false };
  }
  if (/\b(architecture|architectural|race condition|deadlock|concurrency|root cause|complex|security vulnerability|migration design)\b/i.test(objective)) {
    signals.push("explicit complex design, diagnosis, concurrency, migration, or security requirement");
    return { taskClass: "complex-reasoning", capabilitySignals: signals, localModelCandidate: false };
  }
  if (/\b(implement|build|fix|repair|refactor|add|create|develop|change|edit|update)\b/i.test(objective)) {
    signals.push("bounded repository implementation requested");
    return { taskClass: "routine-implementation", capabilitySignals: signals, localModelCandidate: false };
  }
  signals.push("no explicit complex-risk or repository-edit requirement");
  return { taskClass: "lightweight-reasoning", capabilitySignals: signals, localModelCandidate: true };
}

// Entire-step match, not arbitrary shell text or a word found in a larger goal.
export function deterministicCommand(objective: string): WorkRoute["command"] {
  const text = objective.trim().replace(/[.!]$/, "");
  const windowsUi = parseWindowsUiObjective(objective);
  if (windowsUi) return windowsUi;
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?(?:npm\s+)?tests?(?:\s+suite)?$/i.test(text)
    || /^(?:run|execute)\s+`?npm test`?$/i.test(text)) return "npm-test";
  if (/^(?:run|execute)\s+`?node --test`?$/i.test(text)) return "node-test";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?build$/i.test(text)
    || /^(?:run|execute)\s+`?npm run build`?$/i.test(text)) return "npm-build";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?lint(?:er| checks?)?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run lint`?$/i.test(text)) return "npm-lint";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?checks?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run check`?$/i.test(text)) return "npm-check";
  if (/^(?:run|execute)\s+(?:the\s+)?(?:local\s+)?type[ -]?checks?$/i.test(text)
    || /^(?:run|execute)\s+`?npm run typecheck`?$/i.test(text)) return "npm-typecheck";
  return undefined;
}

export type QualifiedLocalModelCandidate = {
  providerId: string;
  model: string;
  endpoint?: string;
  /** Must be true only after approval + enable + capability qualification. */
  routable: boolean;
};

export function selectWorkRoute(input: {
  objective: string;
  pinned?: ModelRoute | null;
  suggested?: ModelRoute | null;
  avoidProvider?: ModelRoute["provider"] | null;
  /** Providers that already failed in this goal's retry chain. */
  avoidProviders?: ModelRoute["provider"][];
  cursorInstalled: boolean;
  /** Optional Claude signed-in route; never changes default Cursor/Codex selection when absent. */
  claudeInstalled?: boolean;
  catalog: ModelCatalog;
  /**
   * Experimental 0.4 local-model path. Stable channel must pass
   * localModelPilotGateOpen=false (default) so candidates are ignored.
   */
  localModelPilotGateOpen?: boolean;
  qualifiedLocalModels?: QualifiedLocalModelCandidate[];
  /**
   * Windows UI plans act on the host desktop, outside every worker sandbox.
   * Only an objective the owner wrote may route to them; a worker-proposed
   * continuation is ordinary sandboxed model work. Defaults to false.
   */
  desktopAutomationAllowed?: boolean;
}): WorkRoute {
  const avoided = new Set<ModelRoute["provider"]>([
    ...(input.avoidProvider ? [input.avoidProvider] : []),
    ...(input.avoidProviders ?? []),
  ]);
  const profile = classifyWork(input.objective);
  const defaultCapabilityTier = (provider: ModelRoute["provider"]): WorkRoute["capabilityTier"] => {
    if (provider === "cursor-browser-login") return "cursor-auto";
    if (provider === "claude-subscription-signin") return "workhorse";
    return "efficient";
  };
  const modelRoute = (route: ModelRoute, reason: string,
    overrides: Partial<Pick<WorkRoute, "taskClass" | "capabilityTier" | "capabilitySignals" | "localModelCandidate">> = {}): WorkRoute => ({ ...route,
    model: normalizeRouteModel(route.model, input.pinned ? "pinned" : "automatic"),
    reasoningEffort: route.reasoningEffort ?? "low", reason,
    financialBasis: "subscription-suitability-not-price-comparison", routingPolicy: "balanced-quality",
    taskClass: overrides.taskClass ?? profile.taskClass,
    capabilityTier: overrides.capabilityTier ?? defaultCapabilityTier(route.provider),
    capabilitySignals: overrides.capabilitySignals ?? profile.capabilitySignals,
    localModelCandidate: overrides.localModelCandidate ?? profile.localModelCandidate });
  if (input.pinned) {
    if (input.pinned.provider === "claude-subscription-signin" && input.claudeInstalled !== true) {
      throw new Error("Pinned Claude route requires an available signed-in Claude environment");
    }
    return modelRoute(input.pinned, "Preserved explicit provider/model selection.", {
      taskClass: "explicit", capabilityTier: "explicit", capabilitySignals: ["explicit provider/model selection"], localModelCandidate: false,
    });
  }
  const detected = deterministicCommand(input.objective);
  const command = detected?.startsWith("windows-ui-") && input.desktopAutomationAllowed !== true ? undefined : detected;
  if (command) return { provider: "software", model: null, reasoningEffort: "none", command,
    reason: command.startsWith("windows-ui-")
      ? "Exact allowlisted Windows UI plan: use deterministic host software without a model call."
      : "Exact supported test command: run ordinary software without a model call.", financialBasis: "no-model",
    routingPolicy: "balanced-quality", taskClass: "deterministic", capabilityTier: "software",
    capabilitySignals: ["exact supported deterministic command"], localModelCandidate: false };
  const suggestionAvailable = !avoided.has(input.suggested?.provider as ModelRoute["provider"])
    && input.suggested?.provider === "cursor-browser-login"
    ? input.cursorInstalled
    : input.suggested?.provider === "claude-subscription-signin"
      ? input.claudeInstalled === true
    : input.suggested?.provider === "codex-chatgpt-signin"
      ? !avoided.has("codex-chatgpt-signin") && input.catalog.models.some(model => model.slug === input.suggested?.model)
      : false;
  if (input.suggested && suggestionAvailable) {
    return modelRoute(input.suggested, "Worker requested a different route for this next step; retained within the approved task.", {
      taskClass: "explicit", capabilityTier: "explicit", capabilitySignals: ["worker-requested provider/model handoff"], localModelCandidate: false,
    });
  }
  // Qualified local models sit after ordinary software and before Cursor/Codex,
  // but only when the experimental pilot gate is open (never on stable 0.3.x).
  if (input.localModelPilotGateOpen === true && profile.localModelCandidate) {
    const local = (input.qualifiedLocalModels ?? []).find((candidate) => candidate.routable === true && candidate.model);
    if (local) {
      return {
        provider: "local-openai-compatible",
        model: local.model,
        reasoningEffort: "none",
        endpoint: local.endpoint,
        providerId: local.providerId,
        reason: "Qualified local OpenAI-compatible model selected behind open experimental pilot gate.",
        financialBasis: "no-subscription-local",
        routingPolicy: "balanced-quality",
        taskClass: profile.taskClass,
        capabilityTier: "local-qualified",
        capabilitySignals: [...profile.capabilitySignals, "local-model-pilot-gate-open", "capability-qualified"],
        localModelCandidate: true,
      };
    }
  }
  const ranked = input.catalog.models;
  const select = (position: number, desiredEffort: string, reason: string,
    capabilityTier: "efficient" | "workhorse" | "frontier", overrides: Parameters<typeof modelRoute>[2] = {}): WorkRoute => {
    const model: ListedModel = ranked[Math.min(position, ranked.length - 1)];
    const effort = model.supportedEfforts.includes(desiredEffort) ? desiredEffort
      : model.supportedEfforts.includes("medium") ? "medium"
      : model.supportedEfforts[0];
    if (!effort) throw new Error(`No supported reasoning effort for ${model.slug}`);
    return modelRoute({ provider: "codex-chatgpt-signin", model: model.slug, reasoningEffort: effort }, reason,
      { ...overrides, capabilityTier });
  };
  if (avoided.has("cursor-browser-login") && !avoided.has("codex-chatgpt-signin")) {
    return select(2, "low", "The previous diagnosed Cursor attempt failed; switch to the efficient listed Codex model for the corrected replacement instead of repeating it.", "efficient", {
      taskClass: "provider-fallback", capabilitySignals: ["diagnosed Cursor provider failure requires one alternate-provider replacement"], localModelCandidate: false,
    });
  }
  if (avoided.has("codex-chatgpt-signin") && !avoided.has("cursor-browser-login") && input.cursorInstalled) {
    return modelRoute({ provider: "cursor-browser-login", model: "auto" },
      "The previous diagnosed Codex attempt failed; switch provider for the corrected replacement instead of repeating it.", {
        taskClass: "provider-fallback", capabilityTier: "cursor-auto",
        capabilitySignals: ["diagnosed Codex provider failure requires one alternate-provider replacement"], localModelCandidate: false,
      });
  }
  if (avoided.has("codex-chatgpt-signin") && avoided.has("cursor-browser-login")
    && !avoided.has("claude-subscription-signin") && input.claudeInstalled === true) {
    return modelRoute({ provider: "claude-subscription-signin", model: "auto" },
      "Codex and Cursor already failed in this corrected retry chain; use the separately authorized signed-in Claude route when available.", {
        taskClass: "provider-fallback", capabilityTier: "workhorse",
        capabilitySignals: ["diagnosed Codex and Cursor failures permit one authorized Claude replacement"], localModelCandidate: false,
      });
  }
  if (avoided.has("codex-chatgpt-signin") && avoided.has("cursor-browser-login")) {
    return select(1, "medium",
      "Both subscription providers failed in this corrected retry chain; resume with a different, stronger listed Codex route instead of dead-ending the approved goal.",
      "workhorse", {
        taskClass: "provider-fallback",
        capabilitySignals: ["all alternate subscription providers were exercised; a verified correction permits a distinct stronger Codex retry"],
        localModelCandidate: false,
      });
  }
  if (profile.taskClass === "frontier-reasoning") {
    return select(0, "high", "Exceptional complexity is explicit: use the highest-ranked listed Codex model at routing time.", "frontier");
  }
  if (profile.taskClass === "complex-reasoning") {
    return select(1, "medium", "Complex design or diagnosis is explicit: use the workhorse Codex route.", "workhorse");
  }
  if (profile.taskClass === "routine-implementation" && input.cursorInstalled) {
    return modelRoute({ provider: "cursor-browser-login", model: "auto" },
      "Routine implementation: use installed Cursor Auto as an opaque server-selected subscription route; independent local verification protects quality.", {
        capabilityTier: "cursor-auto",
      });
  }
  return select(2, "low", profile.taskClass === "routine-implementation"
    ? "Cursor is unavailable; use the efficient listed Codex model for the bounded implementation."
    : "Lightweight reasoning: use the efficient listed Codex model.", "efficient");
}

/** A visible step plan: deterministic preparation and verification surround the one model/tool step that needs judgment or editing. */
export function planWorkRoute(input: Parameters<typeof selectWorkRoute>[0]): WorkRoutePlan {
  const primary = selectWorkRoute(input);
  const software = (step: "inspect" | "verify", reason: string): RoutePlanStep => ({
    step, provider: "software", model: null, reasoningEffort: "none", financialBasis: "no-model", reason,
  });
  const steps: RoutePlanStep[] = [software("inspect", "Refresh and validate project files and execution boundaries without a model call")];
  steps.push({ step: "execute", provider: primary.provider, model: primary.model,
    reasoningEffort: primary.reasoningEffort, financialBasis: primary.financialBasis, reason: primary.reason });
  if (primary.provider !== "software") {
    steps.push(software("verify", "Run universal patch-integrity and explicitly declared project checks in isolation before applying changes"));
  }
  return { schemaVersion: 1, primary, steps };
}

export function hasCompletedProviderResult(jsonl: string, provider: string): boolean {
  try {
    const rows = jsonl.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (provider === "cursor-browser-login") {
      const results = rows.filter(row => row.type === "result");
      return results.length === 1 && results[0].subtype === "success" && results[0].is_error === false;
    }
    if (provider === "codex-chatgpt-signin") {
      return rows.filter(row => row.type === "turn.completed").length === 1
        && !rows.some(row => row.type === "turn.failed" || row.type === "error");
    }
    if (provider === "claude-subscription-signin") {
      const results = rows.filter(row => row.type === "result");
      return results.length === 1 && results[0].is_error !== true && results[0].subtype !== "error";
    }
    return false;
  } catch { return false; }
}
