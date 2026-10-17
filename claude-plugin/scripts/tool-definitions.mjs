/** MCP tool schemas. */

import { onboardingToolDefinitions } from "./privacy-onboarding.mjs";

export function toolDefinitions() {
  const goalId = { type: "string", description: "Coordinator goal UUID." };
  const projectOptions = {
    projectRoot: { type: "string", description: "Absolute folder of the project selected by the user/current chat. Required for new ordinary development; never assume a default private project." },
    provider: { type: "string", enum: ["codex-chatgpt-signin", "cursor-browser-login"] },
    model: { type: "string", description: "Available subscription model; no artificial Luna-only restriction." },
    reasoningEffort: { type: "string" },
    pinRoute: { type: "boolean", default: false, description: "Set true only when the owner explicitly requested this provider/model route. Omit it for automatic routing." },
  };
  return [
    ...onboardingToolDefinitions(),
    ...["preview", "run", "view", "delete"].map(action => ({
      name: "amadeus_discovery_" + action,
      description: ({ preview: "Preview optional inventory sources without collection.", run: "Run only on a separate explicit user scan request and current scoped consent.", view: "Read locally saved capability results.", delete: "Delete locally saved discovery results." })[action],
      annotations: { readOnlyHint: ["preview", "view"].includes(action) },
      inputSchema: { type: "object", additionalProperties: false, properties: {
        ...(action === "preview" || action === "run" ? { categories: { type: "array", items: { enum: ["hardware", "development-tools", "local-providers"] } }, locations: { type: "array", items: { type: "string" }, maxItems: 20 } } : {}),
        ...(action === "run" ? { requested: { type: "boolean", const: true } } : {}),
      }, ...(action === "run" ? { required: ["requested"] } : {}) },
    })),
    { name: "work_status", description: "Show project work in plain language: what is finished, what remains, whether anything needs the owner, and recorded usage. Technical coordinator details are hidden unless explicitly requested.", inputSchema: { type: "object", additionalProperties: false, properties: { goalId, includeTechnical: { type: "boolean", default: false } } } },
    { name: "completion_audit", description: "Generate the durable task-end report and diagnostic audit. Terminal work_status and wait_for_work_update results include this report automatically; include ownerReport in the user-facing task-end report. Separately reports product completion, routing/accounting integrity, duplicate model spend, verification depth, receipt integrity, and whether coordinator repair is needed.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "wait_for_work_update", description: "Keep the current Codex turn active while local coordinator work advances. Returns on the next stage change, after gathering worker checkpoints for about 20 seconds, or after a short timeout; lease heartbeats are liveness only and never count as progress. While a worker runs, results are compact (compact:true): only the new checkpoints and current action, not the whole goal record. Active results identify the current action, last meaningful checkpoint, liveness time, and possible-stall state. Terminal results include the generated ownerReport and diagnostic audit; include that report in the user-facing task-end report. If the result says keepOriginatingTurnOpen=true or doNotFinalize=true, the goal is still active: immediately call this tool again with the returned progressCursor and do not send a final response.",
      inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "afterCursor"], properties: {
        goalId,
        afterCursor: { type: "integer", minimum: 0, description: "The progressCursor returned by start_work, work_status, or the previous wait." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 45, default: 45 },
        detail: { type: "string", enum: ["compact", "full"], default: "compact", description: "compact (default) returns only what changed while a worker is running; full always returns the whole goal record." },
      } },
      _meta: { "openai/toolInvocation/invoking": "Waiting for work to advance…", "openai/toolInvocation/invoked": "Progress checked." } },
    {
      name: "delegate_work",
      description: "Prepare durable work for any selected project. Use start_work immediately when the user requested execution; no separate spending approval is needed.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["task", "doneWhen", "boundaries"],
        properties: {
          ...projectOptions,
          task: { type: "string", minLength: 1 },
          doneWhen: { type: "string", minLength: 1 },
          boundaries: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 160 },
          executionProfile: { type: "string", enum: ["approved-public-project"], default: "approved-public-project" }
        }
      }
    },
    { name: "start_work", description: "Run authorized work independently of the chat until finished or genuinely blocked. Keep the originating assistant turn open and immediately call wait_for_work_update with the returned progressCursor; do not end the turn after launch. Ordinary development defaults to project-wide writes, not read-only.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId, writableWorkspacePaths: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } } } } },
    { name: "status", description: "Read coordinator health, limits, jobs, goals, and outstanding estimated reservations. This never starts work.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    {
      name: "amadeus_lifecycle_status",
      description: "Show consent-gated update status, provider-discovery consent, registry summary, and stable-channel local-model pilot gate (disabled until friend-machine pilot).",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "amadeus_update_consent",
      description: "Grant or decline consent for update checks against MadMaxSoftware/amadeus only. No silent activation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["consent"],
        properties: { consent: { type: "boolean", description: "true grants update-check consent; false declines" } },
      },
    },
    {
      name: "amadeus_check_updates",
      description: "Check MadMaxSoftware/amadeus for newer releases when consent is granted (startup/24h policy). Never hot-replaces; activation needs separate approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { force: { type: "boolean", default: false } },
      },
    },
    {
      name: "amadeus_provider_discovery_consent",
      description: "Record an explicit choice for optional hardware, relevant software and local-provider inventory after showing the current disclosure. Known dependency checks are separate. Does not start discovery.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["consent"],
        properties: { consent: { type: "boolean" }, scopes: { type: "array", items: { enum: ["hardware", "development-tools", "local-providers"] } }, disclosureVersion: { type: "integer", description: "Required when granting; use the version displayed by amadeus_onboarding_status." } },
      },
    },
    {
      name: "amadeus_discover_providers",
      description: "Alias of amadeus_discovery_run for the local-providers category only. Same consented discovery path; detection grants no routing authority.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ['requested'],
        properties: {
          requested: { type: 'boolean', const: true, description: 'A separate explicit user scan request is required.' },
          locations: { type: "array", items: { type: "string" }, maxItems: 20 },
        },
      },
    },
    {
      name: "amadeus_approve_provider",
      description: "Explicitly approve or revoke approval for one discovered provider. Separate from enable and from routing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "approval"],
        properties: {
          providerId: { type: "string", minLength: 1, maxLength: 200 },
          approval: { type: "boolean" },
          enable: { type: "boolean", description: "When true with approval, also enable the provider (still requires qualification before routing)." },
        },
      },
    },
    { name: "list_goals", description: "List all durable coordinator goals or inspect one goal and its current job.", inputSchema: { type: "object", additionalProperties: false, properties: { goalId } } },
    { name: "goal_events", description: "Read the durable event history for one coordinator goal.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    {
      name: "create_goal",
      description: "Prepare a persistent goal for the selected project without launching a worker.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["objective", "successCriteria", "constraints"],
        properties: {
          ...projectOptions,
          objective: { type: "string", minLength: 1 },
          successCriteria: { type: "string", minLength: 1 },
          constraints: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 160 },
          executionProfile: {
            type: "string",
            enum: ["approved-public-project"],
            default: "approved-public-project",
            description: "Hash-bound source profile. Only approved-public-project is supported."
          }
        }
      }
    },
    { name: "pause_goal", description: "Drain-pause an active goal. A running bounded iteration may finish, but no successor is dispatched.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "resume_goal", description: "Resume a paused goal without launching a worker. For a blocked continuous goal with a saved origin-host handoff and no worker objective, returns that handoff without queuing a rediscovery worker; execute the host step from the originating turn, then continue the same goal.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    { name: "retry_failed_goal", description: "After an explicitly acknowledged failed iteration and a verified correction, queue one paused replacement under the same unfinished goal. This never launches a worker.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "reason"], properties: { goalId, reason: { type: "string", minLength: 1 } } } },
    { name: "answer_goal", description: "Answer the durable approval question for a goal and queue its next bounded iteration without launching it.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "answer"], properties: { goalId, answer: { type: "string", minLength: 1 } } } },
    { name: "stop_goal", description: "Stop a goal. A queued job is cancelled; a running job receives the existing stop request and uncertain-outcome protections.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId", "reason"], properties: { goalId, reason: { type: "string", minLength: 1 } } } },
    {
      name: "verify_job_receipt",
      description: "Read and verify the fixed result artifact and isolated workspace for one dispatched job. Reports recovered usage and strict goal-receipt validity but never reconciles or launches work.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["jobId"],
        properties: { jobId: { type: "string", description: "Coordinator job UUID." } }
      }
    },
    {
      name: "reconcile_job",
      description: "Resolve one uncertain job only from externally verified evidence. Completed closes a goal only when the job's worker receipt verifies and records a complete decision (use complete_external_verification for host-verified work), failed blocks it for review, and queued makes the same job eligible again without launching it.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["jobId", "observed", "detail"],
        properties: {
          jobId: { type: "string", description: "Coordinator job UUID." },
          observed: { type: "string", enum: ["completed", "blocked", "failed", "queued"] },
          detail: { type: "string", minLength: 1 },
          recoverVerifiedUsage: { type: "boolean", default: true, description: "Record parsed usage from the fixed completed-turn artifact when no usage record exists." }
        }
      }
    },
    {
      name: "complete_external_verification",
      description: "Close a blocked or uncertain goal after ordinary software has externally verified its preserved completed workspace. This never launches a worker.",
      inputSchema: { type: "object", additionalProperties: false, required: ["jobId", "detail"], properties: {
        jobId: { type: "string", description: "Coordinator job UUID." },
        detail: { type: "string", minLength: 1, description: "Specific verification evidence." }
      }}
    },
    { name: "preflight_goal", description: "Read the exact dispatch, goal-loop, worker, coordinator, and goal gates before an execution request. This never changes a gate.", inputSchema: { type: "object", additionalProperties: false, required: ["goalId"], properties: { goalId } } },
    {
      name: "run_goal",
      description: "Execute an explicitly approved persistent goal through the proven Codex supervisor. It uses ephemeral per-run activation, keeps persistent dispatch disabled, and always returns the coordinator to paused. Exact writable paths are optional; omission is read-only.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["goalId"],
        properties: {
          goalId,
          writableWorkspacePaths: {
            type: "array",
            description: "Exact project-relative paths the isolated worker may edit and the host may apply after a verified checkpoint. Empty means read-only.",
            items: { type: "string", minLength: 1, maxLength: 500 }
          }
        }
      }
    },
  ];
}
