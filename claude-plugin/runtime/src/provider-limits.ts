/**
 * Recognise a subscription provider refusing work because its usage window is
 * exhausted, so an unattended goal can wait for the reset instead of spending
 * retries. Codex wording and error codes were confirmed against the installed
 * Codex CLI (0.162); the Claude and Cursor patterns are conservative and not
 * yet confirmed against a live limit.
 */
export type UsageLimit = { matched: string; resetsAt: string | null };

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  // Codex (verified): error codes and user-facing messages.
  /\busage_limit_reached\b/i,
  /\bworkspace_(?:owner|member)_usage_limit_reached\b/i,
  /\bworkspace_member_credits_depleted\b/i,
  /you(?:'|’)ve hit your usage limit/i,
  /usage limit reached/i,
  /workspace is out of credits/i,
  // Claude and Cursor (unverified): typical subscription limit wording.
  /claude (?:ai )?usage limit reached/i,
  /\b(?:5-hour|weekly|daily|monthly) (?:usage )?limit (?:reached|exceeded)/i,
  /you(?:'|’)ve (?:reached|exceeded) your (?:usage|request) limit/i,
  /out of fast requests/i,
];

/** Seconds since the epoch, or an ISO / clock time following "try again at" or "resets at". */
function parseResetTime(text: string, now: Date): string | null {
  const epoch = /\bresets?_at["':\s=]+(\d{10})\b/i.exec(text) ?? /usage limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = /(?:try again at|resets? at)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso && !Number.isNaN(Date.parse(iso[1]))) return new Date(iso[1]).toISOString();
  const clock = /(?:try again at|resets? at)\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i.exec(text);
  if (clock) {
    const meridiem = clock[3]?.[0].toLowerCase();
    const hours = meridiem ? Number(clock[1]) % 12 + (meridiem === "p" ? 12 : 0) : Number(clock[1]);
    const candidate = new Date(now);
    candidate.setHours(hours, Number(clock[2]), 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }
  return null;
}

export function detectUsageLimit(text: string, now = new Date()): UsageLimit | null {
  const pattern = USAGE_LIMIT_PATTERNS.find((candidate) => candidate.test(text));
  if (!pattern) return null;
  return { matched: pattern.exec(text)![0], resetsAt: parseResetTime(text, now) };
}

/** Without a stated reset time, check again after this long rather than retrying immediately. */
export const DEFAULT_USAGE_LIMIT_WAIT_MS = 30 * 60 * 1000;
