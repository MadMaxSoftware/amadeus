/**
 * The AI providers Amadeus can route worker steps to (plan item 2.9). What
 * genuinely differs between providers is described here once: which driver runs
 * it, where its sign-in lives, which variables would switch it to paid API
 * billing, how it names model tiers and how it words a usage limit. Routing,
 * reporting, usage limits, the privacy check and the worker sandbox read this
 * list instead of naming providers, so a fix to any of them applies to every
 * provider, and adding a provider is one entry here plus its CLI arguments.
 */

export type CapabilityTierName = "efficient" | "workhorse" | "frontier";

/** Model name per capability tier for one provider. */
export type TierModels = Partial<Record<CapabilityTierName, string>>;

export type SubscriptionModelProvider = "codex-chatgpt-signin" | "claude-subscription-signin" | "grok-subscription-signin";

export type WorkerProviderDescriptor = {
  id: SubscriptionModelProvider;
  /** Owner-facing name. */
  label: string;
  /** The worker driver that runs it: Codex's own, or the shared Claude-style CLI driver. */
  driver: "codex" | "claude-style";
  /** Command-line flavour for the Claude-style driver. */
  cli?: "claude" | "grok";
  /** Folder (relative to the home folder) holding the signed-in session; only this provider's workers may read it. */
  signInFolder: string;
  /** File inside signInFolder that shows a subscription sign-in exists, or null when the CLI is trusted to say so. */
  signInFile: string | null;
  /** Variables that would make the CLI bill a paid API key instead of the subscription. Never passed to workers. */
  apiKeyVariables: string[];
  /**
   * Default model per tier when the provider has no live model list. Family
   * aliases only (they always mean the newest model of that family), never
   * version numbers. Empty means "use the CLI's own default model".
   */
  defaultTierModels: TierModels;
  /** The provider publishes a live, ranked model catalog that Amadeus reads. */
  liveCatalog: boolean;
  /** Provider-specific usage-limit wording, in addition to the shared patterns. */
  usageLimitPatterns: RegExp[];
  /** Verified end to end on a signed-in machine. Unverified providers run only after an owner opt-in. */
  verifiedLive: boolean;
};

export const WORKER_PROVIDERS: readonly WorkerProviderDescriptor[] = [
  {
    id: "codex-chatgpt-signin", label: "Codex", driver: "codex",
    signInFolder: ".codex", signInFile: null, apiKeyVariables: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    defaultTierModels: {}, liveCatalog: true, usageLimitPatterns: [], verifiedLive: true,
  },
  {
    id: "claude-subscription-signin", label: "Claude", driver: "claude-style", cli: "claude",
    signInFolder: ".claude", signInFile: null, apiKeyVariables: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    defaultTierModels: { efficient: "sonnet", workhorse: "opus", frontier: "opus" },
    liveCatalog: false, usageLimitPatterns: [], verifiedLive: true,
  },
  {
    // Grok Build (xAI's `grok` CLI): SuperGrok / X Premium+ sign-in via `grok login`,
    // stored in ~/.grok/auth.json. Headless `grok -p` with Claude-compatible
    // streaming output. Not yet run on a signed-in machine, so it needs an opt-in.
    id: "grok-subscription-signin", label: "Grok", driver: "claude-style", cli: "grok",
    signInFolder: ".grok", signInFile: "auth.json", apiKeyVariables: ["XAI_API_KEY"],
    defaultTierModels: {}, liveCatalog: false,
    usageLimitPatterns: [/\bgrok\b[^\n]{0,80}\b(?:usage|rate) limit\b/i, /\bsupergrok\b[^\n]{0,80}\blimit\b/i],
    verifiedLive: false,
  },
];

export function workerProvider(id: unknown): WorkerProviderDescriptor | undefined {
  return WORKER_PROVIDERS.find((provider) => provider.id === id);
}

export function isSubscriptionModelProvider(value: unknown): value is SubscriptionModelProvider {
  return workerProvider(value) !== undefined;
}

/** Owner-facing provider name; non-model routes keep their own wording. */
export function providerLabel(id: unknown): string {
  if (id === "cursor-browser-login") return "Cursor";
  if (id === "software") return "ordinary software";
  return workerProvider(id)?.label ?? (typeof id === "string" && id ? id : "unidentified provider");
}

/** Default tier names per provider (see WorkerProviderDescriptor.defaultTierModels). */
export const DEFAULT_TIER_MODELS: Readonly<Partial<Record<string, TierModels>>> = Object.fromEntries(
  WORKER_PROVIDERS.filter((provider) => Object.keys(provider.defaultTierModels).length > 0)
    .map((provider) => [provider.id, provider.defaultTierModels]));

/** Every provider's sign-in folder name; a worker may read only its own. */
export const PROVIDER_SIGN_IN_FOLDERS: readonly string[] = WORKER_PROVIDERS.map((provider) => provider.signInFolder);

/** Variables that would switch any provider to paid API billing. */
export const PROVIDER_API_KEY_VARIABLES: readonly string[] = WORKER_PROVIDERS.flatMap((provider) => provider.apiKeyVariables);

/** An unverified provider may be routed to only when the owner listed it in `enabledProviders`. */
export function providerAllowed(id: SubscriptionModelProvider, enabledProviders: unknown): boolean {
  const provider = workerProvider(id);
  if (!provider) return false;
  return provider.verifiedLive || (Array.isArray(enabledProviders) && enabledProviders.includes(id));
}
