import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator } from '../src/coordinator.ts';
import { runStateBackupIfDue } from '../src/backup-policy.ts';

test('state backups run at most once per local day and keep a bounded history', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'coordinator.sqlite');
  const coordinator = new Coordinator(databasePath);
  coordinator.createGoal({ objective: 'Back me up', successCriteria: 'Copied', constraints: 'None', idempotencyKey: 'backup', reserveCredits: 1 });
  const backupRoot = join(root, 'backups', 'state');
  const run = (iso) => runStateBackupIfDue({ databasePath, backupRoot, now: new Date(iso), timeZone: 'UTC', daily: 2, weekly: 1 });

  const first = run('2026-10-10T08:00:00Z');
  assert.ok(first.created);
  assert.equal(run('2026-10-10T20:00:00Z').created, null, 'second run on the same day is skipped');
  const copy = new DatabaseSync(first.created, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM goals').get().n, 1);
  copy.close();

  run('2026-10-11T08:00:00Z');
  run('2026-10-12T08:00:00Z');
  const kept = readdirSync(backupRoot).filter((name) => name.endsWith('.sqlite')).sort();
  assert.deepEqual(kept, ['coordinator-20261011T080000Z.sqlite', 'coordinator-20261012T080000Z.sqlite']);
  assert.ok(readdirSync(backupRoot).every((name) => !name.endsWith('.partial')));
  coordinator.close();
});

test('a missing database is not an error', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-backup-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(runStateBackupIfDue({ databasePath: join(root, 'none.sqlite'), backupRoot: join(root, 'b') }), { created: null, removed: [] });
});
