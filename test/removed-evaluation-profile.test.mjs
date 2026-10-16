import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../src/coordinator.ts';
import { parseGoalDecision } from '../src/goal-protocol.ts';
import { inspectGoalExecutionPackage } from '../src/goal-execution-package.ts';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-removed-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(dir, descriptor) {
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify(descriptor));
  return path;
}

function stage(role) {
  return { iteration: 1, name: 'only', role, manifest: 'manifest.json', manifestSha256: 'A'.repeat(64), objectiveMode: 'coordinator',
    allowedWritableWorkspacePaths: 'caller-bounded', patchPolicy: 'apply', maximumChangedFiles: null, maximumChangedLines: null };
}

test('goal packages with evaluation roles or case sets are refused', (t) => {
  const dir = tempDir(t);
  const goalId = randomUUID();
  for (const role of ['participant', 'assessor']) {
    const path = writePackage(dir, { schemaVersion: 1, goalId, mode: 'explicit', stages: [stage(role)] });
    assert.throws(() => inspectGoalExecutionPackage(path, goalId, 1), /stage identity is invalid/);
  }
  const path = writePackage(dir, { schemaVersion: 1, goalId, mode: 'explicit', selectedOpaqueCase: 'a', allOpaqueCases: ['a'],
    stages: [stage('development')] });
  assert.throws(() => inspectGoalExecutionPackage(path, goalId, 1), /no longer supported/);
});

test('decisions accept the old caseId and stageRole fields only as null', () => {
  const base = { status: 'complete', summary: 's', evidence: ['e'], nextObjective: null, nextStreamObjective: null,
    remainingCriterion: null, question: null, recovery: null, nextRoute: null };
  const parsed = parseGoalDecision(JSON.stringify({ ...base, caseId: null, stageRole: null }));
  assert.equal('caseId' in parsed, false);
  assert.equal('stageRole' in parsed, false);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, caseId: 't-a' })), /caseId is no longer supported/);
  assert.throws(() => parseGoalDecision(JSON.stringify({ ...base, stageRole: 'assessor' })), /stageRole is no longer supported/);
  const schema = JSON.parse(readFileSync(new URL('../src/goal-decision.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.caseId, undefined);
  assert.equal(schema.required.includes('stageRole'), false);
});

test('opening an older database drops the evaluation case column and records schema 3', (t) => {
  const dir = tempDir(t);
  const database = join(dir, 'coordinator.sqlite');
  new Coordinator(database).close();
  const raw = new DatabaseSync(database);
  raw.exec("ALTER TABLE goals ADD COLUMN expected_case_id TEXT; UPDATE settings SET value='2' WHERE key='schema_version';");
  raw.close();

  const coordinator = new Coordinator(database);
  coordinator.close();
  const check = new DatabaseSync(database);
  const columns = check.prepare('PRAGMA table_info(goals)').all().map((column) => column.name);
  const version = check.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value;
  check.close();
  assert.equal(columns.includes('expected_case_id'), false);
  assert.equal(version, '3');
});
