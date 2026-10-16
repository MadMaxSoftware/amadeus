import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildClaudeEnvironment,
  buildClaudeInvocation,
  inspectClaudeCli,
  parseClaudeResult,
  assertClaudeImplementationDispatchAllowed,
  CLAUDE_WORKER_SAFETY_ARGUMENTS,
} from '../src/claude-adapter.ts';
import { parseClaudeProgressLine } from '../src/claude-worker-driver.ts';
import {
  hasCompletedProviderResult,
  planWorkRoute,
  selectWorkRoute,
  providerToAvoidAfterAuthorizedRetry,
  providersToAvoidForRetryChain,
} from '../src/work-routing.ts';
import { parseGoalDecision } from '../src/goal-protocol.ts';
import { runClaudeLiveWorkerCanary, CANARY_RESULT, normalizeCanaryResult } from '../scripts/claude-live-worker-canary.mjs';

test('live canary normalizes harmless result wrapping without accepting extra text', () => {
  assert.equal(normalizeCanaryResult(`  "${CANARY_RESULT}"\r\n`), CANARY_RESULT);
  assert.equal(normalizeCanaryResult(`\`${CANARY_RESULT}\``), CANARY_RESULT);
  assert.notEqual(normalizeCanaryResult(`${CANARY_RESULT} more`), CANARY_RESULT);
});

test('live worker canary records only sanitized authoritative result facts', async () => {
  const temporary = tempRoot('claude-live-canary-');
  try {
    const configPath = join(temporary, 'config.json');
    const evidenceDir = join(temporary, 'evidence');
    writeFileSync(configPath, JSON.stringify({ runtimeConfigurationRoot: join(temporary, 'runtime') }));
    const evidence = await runClaudeLiveWorkerCanary({
      configPath, workspace: temporary, evidenceDir,
      runImplementation: async () => ({
        exitCode: 0, timedOut: false, aborted: false,
        stdout: JSON.stringify({ type: 'result', subtype: 'success', session_id: 'private-session',
          result: CANARY_RESULT, usage: { input_tokens: 1, output_tokens: 2 } }),
        stderr: 'private-secret',
      }),
    });
    assert.equal(evidence.success, true);
    assert.equal(evidence.provider, 'claude-subscription-signin');
    const saved = readFileSync(evidence.evidencePath, 'utf8');
    assert.doesNotMatch(saved, /private-secret|private-session/);
    assert.equal(JSON.parse(saved).usagePresent, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

const catalog = {
  fetchedAt: 'test',
  models: [
    { slug: 'gpt-frontier', priority: 0, supportedEfforts: ['low', 'medium', 'high'] },
    { slug: 'gpt-workhorse', priority: 1, supportedEfforts: ['low', 'medium', 'high'] },
    { slug: 'gpt-efficient', priority: 2, supportedEfforts: ['low', 'medium', 'high'] },
  ],
};

function tempRoot(label) {
  const root = join(process.cwd(), 'verification', 'tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, label));
}

function baseConfig(root) {
  const shim = join(root, 'shim.cjs');
  writeFileSync(shim, 'module.exports = {};\n');
  writeFileSync(join(root, 'claude.exe'), '');
  writeFileSync(join(root, 'mxc.exe'), '');
  mkdirSync(join(root, 'appdata'), { recursive: true });
  mkdirSync(join(root, 'profile'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'appdata', 'runtime'), { recursive: true });
  mkdirSync(join(root, 'denied-repo'), { recursive: true });
  return {
    schemaVersion: 1,
    enabled: true,
    dispatchAuthorized: true,
    automaticStartup: false,
    executable: join(root, 'claude.exe'),
    containmentExecutable: join(root, 'mxc.exe'),
    containmentProfile: 'claude_contained',
    containmentWindowsSandbox: 'mxc',
    containedAppData: join(root, 'appdata'),
    containedUsername: 'worker',
    containedUserProfile: join(root, 'profile'),
    userInfoShim: shim,
    pathVerifierShim: shim,
    authentication: 'subscription-signin',
    apiKeyAuthenticationAllowed: false,
    spendingRouteReviewed: true,
    readOnlyOnly: true,
    outputFormat: 'stream-json',
    model: null,
    deniedSourceRoot: join(root, 'denied-repo'),
    configurationDirectory: join(root, 'config'),
    runtimeConfigurationRoot: join(root, 'appdata', 'runtime'),
    maximumRuntimeSeconds: 60,
    writableWorkspacePaths: [],
    developmentMode: true,
    implementationPrepared: true,
    implementationDispatchAuthorized: true,
  };
}

test('Claude adapter strips API keys and refuses billing or unprepared dispatch', () => {
  const temporary = tempRoot('claude-adapter-');
  try {
    const config = baseConfig(temporary);
    const env = buildClaudeEnvironment({
      ...config,
      // Inject secrets into process-like env via config path only; adapter must strip them.
    }, config.configurationDirectory, join(temporary, 'workspace'));
    // Force-check deletion semantics against a polluted environment copy.
    const polluted = buildClaudeEnvironment(config, config.configurationDirectory, undefined, {
      PATH: 'C:\\Tools',
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CUSTOM_WORK_CREDENTIAL: 'secret',
      NODE_OPTIONS: '--require=untrusted.cjs',
      HTTPS_PROXY: 'http://name:secret@example.invalid',
    });
    assert.equal(polluted.AMADEUS_WORKER, '1');
    assert.equal(polluted.PATH, 'C:\\Tools');
    assert.equal(polluted.USERPROFILE, config.containedUserProfile);
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY', 'CUSTOM_WORK_CREDENTIAL', 'HTTPS_PROXY']) {
      assert.equal(polluted[key], undefined, `${key} must not enter the worker`);
    }
    assert.equal(polluted.NODE_OPTIONS, undefined);
    assert.equal(env.AMADEUS_WORKER, '1');
    assert.deepEqual([...CLAUDE_WORKER_SAFETY_ARGUMENTS], [
      '--safe-mode', '--restricted', '--strict-mcp-config',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--no-session-persistence', '--verbose',
    ]);

    assert.throws(() => buildClaudeInvocation({
      ...config,
      authentication: 'api-key',
      apiKeyAuthenticationAllowed: true,
    }, join(temporary, 'workspace'), 'probe'), /subscription sign-in only|API-key/i);

    assert.throws(() => assertClaudeImplementationDispatchAllowed({
      ...config,
      enabled: false,
    }, join(temporary, 'workspace')), /dispatch is disabled/i);

    assert.throws(() => assertClaudeImplementationDispatchAllowed({
      ...config,
      automaticStartup: true,
    }, join(temporary, 'workspace')), /automatic startup/i);

    assert.throws(() => assertClaudeImplementationDispatchAllowed({
      ...config,
      spendingRouteReviewed: false,
    }, join(temporary, 'workspace')), /spending route/i);

    const badAuth = inspectClaudeCli({
      enabled: true,
      executable: config.executable,
      apiKeyAuthenticationAllowed: true,
    });
    assert.equal(badAuth.installed, false);
    assert.match(String(badAuth.reason), /API-key/i);

    const disabled = inspectClaudeCli({ enabled: false, executable: config.executable });
    assert.equal(disabled.installed, false);
    assert.equal(disabled.supportClaim, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Claude result parsing, progress attribution, and completion detection stay deterministic', () => {
  const jsonl = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"status":"continue","summary":"ok","evidence":["e"],"nextObjective":"n","remainingCriterion":"gap","question":null,"caseId":null,"stageRole":null,"recovery":null,"nextRoute":null}',
      session_id: 's1',
      duration_ms: 12,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  ].join('\n');
  const receipt = parseClaudeResult(jsonl);
  assert.equal(receipt.sessionId, 's1');
  assert.equal(receipt.usage.inputTokens, 3);
  assert.equal(hasCompletedProviderResult(jsonl, 'claude-subscription-signin'), true);
  const progress = parseClaudeProgressLine(jsonl.split('\n')[1], process.cwd());
  assert.equal(progress?.phase, 'edit');
  assert.equal(progress?.provider, 'claude-subscription-signin');
  const decision = parseGoalDecision(receipt.result);
  assert.equal(decision.status, 'continue');
  const withRoute = parseGoalDecision(JSON.stringify({
    status: 'continue',
    summary: 'handoff',
    evidence: ['e'],
    nextObjective: 'next',
    remainingCriterion: 'gap',
    question: null,
    nextRoute: { provider: 'claude-subscription-signin', model: 'auto', reasoningEffort: 'low' },
  }));
  assert.equal(withRoute.nextRoute.provider, 'claude-subscription-signin');
});

test('Claude signed-in routing is opt-in/fallback only and preserves Codex defaults', () => {
  const routine = selectWorkRoute({
    objective: 'Implement the helper function',
    cursorInstalled: true,
    claudeInstalled: true,
    catalog,
  });
  assert.equal(routine.provider, 'cursor-browser-login');

  const withoutCursor = selectWorkRoute({
    objective: 'Implement the helper function',
    cursorInstalled: false,
    claudeInstalled: true,
    catalog,
  });
  assert.equal(withoutCursor.provider, 'codex-chatgpt-signin');
  assert.equal(withoutCursor.model, 'gpt-efficient');

  const pinned = selectWorkRoute({
    objective: 'Implement the helper function',
    pinned: { provider: 'claude-subscription-signin', model: 'auto' },
    cursorInstalled: true,
    claudeInstalled: true,
    catalog,
  });
  assert.equal(pinned.provider, 'claude-subscription-signin');
  assert.equal(pinned.taskClass, 'explicit');

  assert.throws(() => selectWorkRoute({
    objective: 'Implement the helper function',
    pinned: { provider: 'claude-subscription-signin', model: 'auto' },
    cursorInstalled: true,
    claudeInstalled: false,
    catalog,
  }), /available signed-in Claude/);

  const fallback = selectWorkRoute({
    objective: 'Implement the helper function',
    avoidProviders: ['codex-chatgpt-signin', 'cursor-browser-login'],
    cursorInstalled: true,
    claudeInstalled: true,
    catalog,
  });
  assert.equal(fallback.provider, 'claude-subscription-signin');
  assert.equal(fallback.taskClass, 'provider-fallback');

  const bothFailedNoClaude = selectWorkRoute({
    objective: 'Implement the helper function',
    avoidProviders: ['codex-chatgpt-signin', 'cursor-browser-login'],
    cursorInstalled: true,
    claudeInstalled: false,
    catalog,
  });
  assert.equal(bothFailedNoClaude.provider, 'codex-chatgpt-signin');
  assert.equal(bothFailedNoClaude.model, 'gpt-workhorse');

  assert.equal(providerToAvoidAfterAuthorizedRetry({
    jobStatus: 'failed',
    retryAuthorized: true,
    provider: 'claude-subscription-signin',
  }), 'claude-subscription-signin');

  assert.deepEqual(providersToAvoidForRetryChain([
    { jobStatus: 'completed', retryAuthorized: false, provider: 'codex-chatgpt-signin', failureDetail: 'Implemented the fallback' },
    { jobStatus: 'failed', retryAuthorized: false, provider: 'cursor-browser-login', failureDetail: 'cursor isolation acceptance harness is unavailable' },
  ]), ['cursor-browser-login']);

  const plan = planWorkRoute({
    objective: 'Implement the helper function',
    pinned: { provider: 'claude-subscription-signin', model: 'auto' },
    cursorInstalled: false,
    claudeInstalled: true,
    catalog,
  });
  assert.equal(plan.primary.provider, 'claude-subscription-signin');
  assert.equal(plan.steps[0].provider, 'software');
  assert.equal(plan.steps.at(-1).provider, 'software');
});
