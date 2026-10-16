import type { GoalDecision } from "./goal-protocol.ts";

export const POST_DRIFT_HOUSEKEEPING_GUIDANCE = [
  "Post-drift housekeeping is part of the same milestone whenever work replaces, migrates, supersedes, consolidates, or repairs a workflow, deployment path, coordinator mechanism, or other implementation direction.",
  "Inspect active source, configuration, workflows, scripts, tests, documentation, environment inputs, and integration assumptions for redundant or obsolete remnants; remove or quarantine only remnants made obsolete by this milestone, preserve historical evidence and unrelated dirty paths, and run focused validation after cleanup.",
  "For every such milestone, include one evidence item in exactly this form: Housekeeping: examined=<comma-separated active surfaces>; removed_or_quarantined=<comma-separated paths/items or none>; preserved=<historical evidence/unrelated paths or none>.",
  "Do not report completion or continuation for post-drift work without that evidence item.",
].join(" ");

export function requiresPostDriftHousekeeping(objective: string, changedPaths: string[] = []): boolean {
  const driftIntent = /\b(?:drift|redundan\w*|obsolete|supersed\w*|deprecat\w*|replac\w*|migrat\w*|consolidat\w*|clean(?:up|\s+up)|change\w*\s+(?:the\s+)?(?:deployment|workflow|architecture|implementation)\s+(?:path|direction)|repair\w*[^.\n]{0,80}\b(?:workflow|deployment|coordinator))\b/i;
  if (!driftIntent.test(objective)) return false;
  return changedPaths.some((path) => {
    const normalized = path.replaceAll("\\", "/");
    if (/(^|\/)docs\/project-state\/evidence\//i.test(normalized)) return false;
    return /(^|\/)(?:\.github\/workflows|apps?|coordinator|infra|integrations|mcp|platforms|scripts|shared|skills|src|tests?)(?:\/|$)/i.test(normalized)
      || /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*|Dockerfile|[^/]+\.(?:ya?ml|toml|json|ps1|py|[cm]?[jt]s|tsx?))$/i.test(normalized);
  });
}

export function hasPostDriftHousekeepingEvidence(decision: GoalDecision | null | undefined): boolean {
  return Boolean(decision?.evidence.some((item) => /^Housekeeping:\s*/i.test(item)
    && /\bexamined\s*=\s*[^;]+/i.test(item)
    && /\bremoved_or_quarantined\s*=\s*[^;]+/i.test(item)
    && /\bpreserved\s*=\s*[^;]+/i.test(item)));
}
