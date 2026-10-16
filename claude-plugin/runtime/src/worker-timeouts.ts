export type WorkerTimeoutConfig = {
  maximumIdleSeconds?: unknown;
  /** Legacy public-template name retained for upgrade compatibility. */
  idleProgressTimeoutSeconds?: unknown;
};

/** Resolve the canonical provider-output idle timeout without silently disabling legacy installs. */
export function resolveMaximumIdleSeconds(config: WorkerTimeoutConfig, fallback = 0): number {
  const candidate = config.maximumIdleSeconds ?? config.idleProgressTimeoutSeconds ?? fallback;
  const seconds = Number(candidate);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("maximumIdleSeconds must be a non-negative integer");
  }
  return seconds;
}
