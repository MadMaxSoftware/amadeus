export type CodexUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type CreditRateCard = {
  model: string;
  inputCreditsPerMillion: number;
  cachedInputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  source: string;
};

export const lunaRateCard: CreditRateCard = {
  model: "gpt-5.6-luna",
  inputCreditsPerMillion: 5,
  cachedInputCreditsPerMillion: 0.5,
  outputCreditsPerMillion: 30,
  source: "https://learn.chatgpt.com/docs/pricing",
};

function tokenCount(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

export function validateUsage(input: Partial<CodexUsage>): CodexUsage {
  const usage = {
    input_tokens: tokenCount(input.input_tokens, "input_tokens"),
    cached_input_tokens: tokenCount(input.cached_input_tokens, "cached_input_tokens"),
    cache_write_input_tokens: tokenCount(input.cache_write_input_tokens ?? 0, "cache_write_input_tokens"),
    output_tokens: tokenCount(input.output_tokens, "output_tokens"),
    reasoning_output_tokens: tokenCount(input.reasoning_output_tokens ?? 0, "reasoning_output_tokens"),
  };
  if (usage.cached_input_tokens > usage.input_tokens) throw new Error("cached input cannot exceed total input");
  if (usage.reasoning_output_tokens > usage.output_tokens) throw new Error("reasoning output cannot exceed total output");
  return usage;
}

export function estimateCredits(usageInput: Partial<CodexUsage>, rateCard = lunaRateCard): number {
  const usage = validateUsage(usageInput);
  const nonCachedInput = usage.input_tokens - usage.cached_input_tokens;
  return (
    nonCachedInput * rateCard.inputCreditsPerMillion
    + usage.cached_input_tokens * rateCard.cachedInputCreditsPerMillion
    + usage.output_tokens * rateCard.outputCreditsPerMillion
  ) / 1_000_000;
}

export function estimateCreditMicros(usage: Partial<CodexUsage>, rateCard = lunaRateCard): number {
  return Math.round(estimateCredits(usage, rateCard) * 1_000_000);
}

export function parseCodexUsage(jsonl: string): CodexUsage {
  const completed: CodexUsage[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    const candidate = event as { type?: string; usage?: Partial<CodexUsage> };
    if (candidate.type === "turn.completed" && candidate.usage) completed.push(validateUsage(candidate.usage));
  }
  if (completed.length !== 1) throw new Error(`Expected exactly one turn.completed usage event; found ${completed.length}`);
  return completed[0];
}
