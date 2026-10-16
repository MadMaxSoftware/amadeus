/** Command-line access to the coordinator database (`node src/coordinator.ts <command>`). */
import { parseArgs } from "node:util";
import { Coordinator } from "./coordinator.ts";
import { parseNonnegativeInteger } from "./coordinator-types.ts";

function optionString(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

export function main(): void {
  const command = process.argv[2] ?? "status";
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      db: { type: "string" }, id: { type: "string" }, objective: { type: "string" },
      "idempotency-key": { type: "string" }, "reserve-cents": { type: "string" },
      "limit-cents": { type: "string" }, worker: { type: "string" }, text: { type: "string" },
      observed: { type: "string" }, "reserve-credits": { type: "string" },
      "budget-credits": { type: "string" }, "success-criteria": { type: "string" }, constraints: { type: "string" },
      "per-job-credits": { type: "string" }, "daily-credits": { type: "string" },
      "weekly-credits": { type: "string" }, "lease-seconds": { type: "string" },
      "failure-limit": { type: "string" }, "idle-limit": { type: "string" }, "daily-ai-calls": { type: "string" }
    },
    strict: true
  });
  const coordinator = new Coordinator(values.db as string | undefined);
  try {
    let result: unknown = { ok: true };
    if (command === "init") {
      if (values["limit-cents"] !== undefined) coordinator.configureSpendingLimit(parseNonnegativeInteger(values["limit-cents"], "limit"));
      result = coordinator.status();
    } else if (command === "submit") {
      result = coordinator.submit({
        objective: optionString(values, "objective"),
        idempotencyKey: optionString(values, "idempotency-key"),
        reserveCents: parseNonnegativeInteger(values["reserve-cents"] ?? 0, "reservation"),
        reserveCredits: Number(values["reserve-credits"] ?? 0),
      });
    } else if (command === "status") result = coordinator.status(values.id as string | undefined);
    else if (command === "goal-create") result = coordinator.createGoal({
      objective: optionString(values, "objective"),
      successCriteria: optionString(values, "success-criteria"),
      constraints: optionString(values, "constraints"),
      idempotencyKey: optionString(values, "idempotency-key"),
      reserveCredits: Number(optionString(values, "reserve-credits")),
      budgetCredits: Number(optionString(values, "budget-credits")),
    });
    else if (command === "goals") result = coordinator.goals(values.id as string | undefined);
    else if (command === "goal-events") result = coordinator.goalEvents(optionString(values, "id"));
    else if (command === "goal-pause") result = coordinator.pauseGoal(optionString(values, "id"));
    else if (command === "goal-resume") result = coordinator.resumeGoal(optionString(values, "id"));
    else if (command === "goal-retry") result = coordinator.retryFailedGoal(optionString(values, "id"), optionString(values, "text"));
    else if (command === "goal-answer") result = coordinator.answerGoal(optionString(values, "id"), optionString(values, "text"));
    else if (command === "goal-stop") result = coordinator.stopGoal(optionString(values, "id"), optionString(values, "text"));
    else if (command === "goal-recover-stalled") result = coordinator.requestStalledIterationRecovery(optionString(values, "id"), optionString(values, "text"));
    else if (command === "usage") result = coordinator.usage(values.id as string | undefined);
    else if (command === "patches") result = coordinator.patchReceipts(values.id as string | undefined);
    else if (command === "pause") coordinator.pause();
    else if (command === "resume") coordinator.resume();
    else if (command === "claim") result = coordinator.claim(optionString(values, "worker"), parseNonnegativeInteger(values["lease-seconds"] ?? 600, "lease"));
    else if (command === "heartbeat") result = coordinator.heartbeat(optionString(values, "id"), optionString(values, "worker"), parseNonnegativeInteger(values["lease-seconds"] ?? 600, "lease"));
    else if (command === "expire-stale") result = { expired: coordinator.expireStale() };
    else if (command === "stop-now") result = { stopping: coordinator.stopNow(optionString(values, "text")) };
    else if (command === "acknowledge-stopped") coordinator.acknowledgeStopped(optionString(values, "id"), optionString(values, "text"));
    else if (command === "ask") coordinator.ask(optionString(values, "id"), optionString(values, "text"));
    else if (command === "answer") coordinator.answer(optionString(values, "id"), optionString(values, "text"));
    else if (command === "uncertain") coordinator.uncertain(optionString(values, "id"), optionString(values, "text"));
    else if (command === "reconcile") {
      const observed = optionString(values, "observed");
      if (!["completed", "blocked", "failed", "queued"].includes(observed)) throw new Error("--observed must be completed, blocked, failed, or queued");
      coordinator.reconcile(optionString(values, "id"), observed as "completed" | "blocked" | "failed" | "queued", optionString(values, "text"));
    } else if (command === "complete" || command === "fail") {
      coordinator.finish(optionString(values, "id"), command === "complete" ? "completed" : "failed", optionString(values, "text"));
    } else if (command === "limit") {
      coordinator.configureSpendingLimit(parseNonnegativeInteger(optionString(values, "limit-cents"), "limit"));
      result = coordinator.status();
    } else if (command === "progress-limits") {
      result = coordinator.configureProgressLimits({
        consecutiveFailures: values["failure-limit"] === undefined ? undefined : Number(values["failure-limit"]),
        consecutiveWithoutChange: values["idle-limit"] === undefined ? undefined : Number(values["idle-limit"]),
        aiCallsPer24h: values["daily-ai-calls"] === undefined ? undefined : Number(values["daily-ai-calls"]),
      });
    } else if (command === "credit-limits") {
      coordinator.configureCreditLimits({
        perJob: Number(optionString(values, "per-job-credits")),
        daily: Number(optionString(values, "daily-credits")),
        weekly: Number(optionString(values, "weekly-credits")),
      });
      result = coordinator.status();
    } else throw new Error(`Unknown command: ${command}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    coordinator.close();
  }
}
