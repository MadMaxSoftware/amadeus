import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverUrl = pathToFileURL(join(repoRoot, "plugins", "amadeus", "scripts", "server.mjs")).href;
const { ownerFacingCompletionReport } = await import(serverUrl);

/**
 * Stream / continuous-style goals often end with partial verification depth and
 * mixed routing allocation. Closeout must still expose durable owner fields.
 */
test("Amadeus task-end report carries Long-Haul closeout fields for a continuous terminal audit", () => {
  const verificationDepth = {
    name: "verification_depth",
    status: "partial",
    summary: "Verification covered patch integrity only; no declared product test was recorded.",
  };
  const audit = {
    productResult: "incomplete",
    coordinatorVerdict: "partially_proven",
    summary: "Product did not finish; no coordinator defect was proven, but 2 route or verification area(s) remain only partially tested.",
    verifiedProgress: "Implemented the streaming checkpoint handler and wired continuous progress events.",
    whatRemains: "Run the end-to-end stream soak on a second machine and confirm reconnect behavior.",
    needsFromYou: null,
    workAllocation: {
      basis: "completed-routed-steps",
      disclaimer: "These percentages show routing activity, not code volume.",
      allocationPercentages: [
        { route: "ordinary software", model: null, percentage: 40, completedSteps: 2 },
        { route: "Codex", model: "gpt-5.6-luna", reasoningEffort: "medium", percentage: 35, completedSteps: 2 },
        { route: "Cursor", model: "auto", percentage: 25, completedSteps: 1 },
      ],
    },
    checks: [verificationDepth],
    usage: { inputTokens: 1200, cachedInputTokens: 400, outputTokens: 800 },
    completionScope: { completedEntity: "coordinator-goal", wholeProjectCompletionInferred: false },
  };

  const report = ownerFacingCompletionReport(audit);

  assert.equal(report.title, "Amadeus task-end report");
  assert.equal(report.productResult, "incomplete");
  assert.equal(report.coordinatorVerdict, "partially_proven");
  assert.equal(report.ownerBrief.whatIsStillOutstanding, audit.whatRemains);
  assert.equal(report.workAllocation.allocationPercentages.length, 3);
  assert.equal(report.workAllocation.allocationPercentages[0].percentage, 40);
  assert.equal(report.workAllocation.allocationPercentages[1].percentage, 35);
  assert.equal(report.workAllocation.allocationPercentages[2].percentage, 25);

  const depth = report.verification.find((item) => item.name === "verification_depth");
  assert.ok(depth);
  assert.equal(depth.status, "partial");
  assert.match(depth.summary, /patch integrity/i);
});
