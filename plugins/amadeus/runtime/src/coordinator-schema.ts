/** Creates and upgrades the coordinator's SQLite schema. */
import type { DatabaseSync } from "node:sqlite";

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dropColumnIfPresent(db: DatabaseSync, table: string, column: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

export function migrateCoordinatorSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      reserved_cents INTEGER NOT NULL DEFAULT 0,
      worker TEXT,
      question TEXT,
      answer TEXT,
      outcome TEXT,
      result_artifact_path TEXT,
      reserved_credit_micros INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      stop_requested INTEGER NOT NULL DEFAULT 0,
      reservation_released_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (reserved_cents >= 0)
    );
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      estimated_credit_micros INTEGER NOT NULL,
      reserved_credit_micros INTEGER NOT NULL,
      actual_provider_credit_micros INTEGER,
      rate_card_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, attempt),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS patch_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      patch_path TEXT NOT NULL,
      patch_sha256 TEXT NOT NULL,
      patch_bytes INTEGER NOT NULL,
      changed_files INTEGER NOT NULL,
      changed_lines INTEGER NOT NULL,
      checkpoint_receipt TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, attempt),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      objective TEXT NOT NULL,
      success_criteria TEXT NOT NULL,
      constraints_text TEXT NOT NULL,
      status TEXT NOT NULL,
      iteration_reserve_credit_micros INTEGER NOT NULL,
      budget_credit_micros INTEGER NOT NULL,
      current_iteration INTEGER NOT NULL DEFAULT 0,
      current_job_id TEXT,
      question TEXT,
      answer TEXT,
      last_summary TEXT,
      last_evidence TEXT,
      next_objective TEXT,
      continuous_development INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (current_job_id) REFERENCES jobs(id),
      CHECK (iteration_reserve_credit_micros > 0),
      CHECK (budget_credit_micros >= iteration_reserve_credit_micros)
    );
    CREATE TABLE IF NOT EXISTS goal_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES goals(id)
    );
    CREATE TABLE IF NOT EXISTS goal_git_approvals (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      goal_revision INTEGER NOT NULL,
      source_revision TEXT NOT NULL,
      action TEXT NOT NULL,
      decision TEXT NOT NULL,
      target_branch TEXT,
      target_remote TEXT,
      target_remote_url TEXT,
      patch_digest TEXT,
      changed_paths_digest TEXT,
      authority_event_id TEXT,
      authority_actor_id TEXT,
      authority_channel TEXT,
      provenance_verified INTEGER NOT NULL DEFAULT 0,
      grant_scope TEXT NOT NULL DEFAULT 'single_use',
      consumption TEXT NOT NULL DEFAULT 'available',
      approval_reference TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES goals(id),
      CHECK (goal_revision > 0),
      CHECK (action IN ('commit', 'push')),
      CHECK (decision IN ('allow', 'deny'))
    );
    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('paused', 'true'),
      ('spending_limit_cents', '0'),
      ('credit_limit_per_job_micros', '0'),
      ('credit_limit_daily_micros', '0'),
      ('credit_limit_weekly_micros', '0'),
      ('progress_failure_limit', '3'),
      ('progress_idle_limit', '6'),
      ('daily_ai_call_limit', '60'),
      ('schema_version', '1');
  `);
  addColumnIfMissing(db, "jobs", "reserved_credit_micros", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "jobs", "heartbeat_at", "TEXT");
  addColumnIfMissing(db, "jobs", "lease_expires_at", "TEXT");
  addColumnIfMissing(db, "jobs", "stop_requested", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "jobs", "reservation_released_at", "TEXT");
  addColumnIfMissing(db, "jobs", "result_artifact_path", "TEXT");
  addColumnIfMissing(db, "jobs", "goal_id", "TEXT");
  addColumnIfMissing(db, "jobs", "goal_iteration", "INTEGER");
  addColumnIfMissing(db, "jobs", "package_stage_iteration", "INTEGER");
  addColumnIfMissing(db, "jobs", "iteration_objective", "TEXT");
  addColumnIfMissing(db, "goals", "project_root", "TEXT");
  addColumnIfMissing(db, "goals", "continuous_development", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "goals", "goal_revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "goal_git_approvals", "target_remote_url", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "patch_digest", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "changed_paths_digest", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "authority_event_id", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "authority_actor_id", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "authority_channel", "TEXT");
  addColumnIfMissing(db, "goal_git_approvals", "provenance_verified", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "goal_git_approvals", "grant_scope", "TEXT NOT NULL DEFAULT 'single_use'");
  addColumnIfMissing(db, "goal_git_approvals", "consumption", "TEXT NOT NULL DEFAULT 'available'");
  db.exec("UPDATE jobs SET package_stage_iteration=goal_iteration WHERE goal_id IS NOT NULL AND package_stage_iteration IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS jobs_goal_id ON jobs(goal_id); CREATE INDEX IF NOT EXISTS goal_events_goal_id ON goal_events(goal_id);");
  db.exec("CREATE INDEX IF NOT EXISTS goal_git_approvals_binding ON goal_git_approvals(goal_id, goal_revision, source_revision);");
  // Schema 3 drops the removed evaluation profile's case column.
  dropColumnIfPresent(db, "goals", "expected_case_id");
  db.prepare("UPDATE settings SET value='3' WHERE key='schema_version'").run();
  db.prepare(`
    UPDATE jobs SET reservation_released_at=updated_at
    WHERE status IN ('completed', 'failed', 'blocked_budget') AND reservation_released_at IS NULL
  `).run();
  // A queued iteration belonging to a paused goal is prepared work, not an
  // active reservation. Claiming it later re-opens the reservation.
  db.prepare(`
    UPDATE jobs SET reservation_released_at=updated_at
    WHERE status='queued' AND reservation_released_at IS NULL
      AND goal_id IN (SELECT id FROM goals WHERE status='paused')
  `).run();
}
