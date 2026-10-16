/** Statuses, progress-limit types and project-root helpers shared by the coordinator. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_question"
  | "uncertain"
  | "completed"
  | "failed"
  | "blocked_budget";

export const terminalStatuses = new Set<JobStatus>(["completed", "failed"]);

export type GoalStatus = "active" | "paused" | "waiting_approval" | "uncertain" | "completed" | "blocked" | "budget_limited" | "stopped";

export type ProgressLimits = { consecutiveFailures: number; consecutiveWithoutChange: number; aiCallsPer24h: number };
export type ProgressGuard = {
  stop: boolean;
  reason: string | null;
  consecutiveFailures: number;
  consecutiveWithoutChange: number;
  aiCallsLast24h: number;
  limits: ProgressLimits;
};

export function normalizeProjectRoot(root: string): string {
  return resolve(root).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

export function projectRootsOverlap(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return true;
  const a = normalizeProjectRoot(left);
  const b = normalizeProjectRoot(right);
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

export function defaultDatabasePath(): string {
  const base = process.env.AMADEUS_HOME
    ?? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Amadeus");
  return join(base, "coordinator.sqlite");
}

export function parseNonnegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}
