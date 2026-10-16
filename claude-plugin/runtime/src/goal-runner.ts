import { prepareGoalExecutionStage, refreshRepeatGoalPackage, type PreparedGoalStage } from "./goal-execution-package.ts";
import { Coordinator } from "./coordinator.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The same stage loop is used by the host supervisor and deterministic acceptance. */
export async function runGoalStages(input: {
  coordinator: Coordinator;
  goalId: string;
  packagePath: string;
  writablePaths: string[];
  runStage: (stage: PreparedGoalStage, writablePaths: string[]) => Promise<Record<string, unknown> | null>;
}): Promise<Record<string, unknown> | null> {
  const { coordinator, goalId, packagePath } = input;
  let lastJob: Record<string, unknown> | null = null;
  while (coordinator.getGoal(goalId).status === "active") {
    const goal = coordinator.getGoal(goalId);
    if (!goal.current_job_id) break;
    const current = coordinator.getJob(String(goal.current_job_id));
    const iteration = Number(current.package_stage_iteration ?? current.goal_iteration);
    const previous = iteration > 1 ? coordinator.getGoalPackageStageJob(goalId, iteration - 1) : null;
    const patches = previous ? coordinator.patchReceipts(String(previous.id)).records as Record<string, unknown>[] : [];
    const stage = prepareGoalExecutionStage({ packagePath, goalId, iteration,
      previousResultArtifactPath: previous?.result_artifact_path as string | undefined,
      previousPatchArtifactPath: patches.at(-1)?.patch_path as string | undefined });
    const writablePaths = stage.stage.allowedWritableWorkspacePaths === "caller-bounded"
      ? input.writablePaths : stage.stage.allowedWritableWorkspacePaths;
    lastJob = await input.runStage(stage, [...writablePaths]);
    if (!lastJob) break;
    const state = coordinator.getGoal(goalId).status;
    const descriptor = JSON.parse(readFileSync(packagePath, "utf8"));
    if (lastJob.status === "completed" && ["active", "paused", "blocked"].includes(String(state)) && stage.stage.role === "development" && descriptor.mode === "repeat") {
      const refreshed = refreshRepeatGoalPackage({ packagePath, goalId, writableWorkspacePaths: writablePaths });
      if (state === "blocked") {
        const manifest = JSON.parse(readFileSync(refreshed.manifestPath, "utf8"));
        const fingerprint = createHash("sha256").update(JSON.stringify(manifest.files.map((file: { path: string; sha256: string }) => [file.path, file.sha256]).sort())).digest("hex");
        coordinator.queueTechnicalRecovery(goalId, fingerprint);
      }
    }
  }
  return lastJob;
}
