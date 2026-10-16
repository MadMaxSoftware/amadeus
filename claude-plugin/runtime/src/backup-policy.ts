import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** The computer's own timezone, so "daily" means the owner's day wherever they are. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export type BackupReceipt = {
  id: string;
  completedAt: string;
  successful: boolean;
};

function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function isoWeekKey(date: Date, timeZone: string): string {
  const day = localDay(date, timeZone);
  const noon = new Date(`${day}T12:00:00Z`);
  const weekday = (noon.getUTCDay() + 6) % 7;
  noon.setUTCDate(noon.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(noon.getUTCFullYear(), 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((noon.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${noon.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function isDailyBackupDue(input: {
  now: Date;
  lastSuccessfulAt?: Date;
  timeZone?: string;
  scheduledHour?: number;
}): boolean {
  const timeZone = input.timeZone ?? systemTimeZone();
  const hour = input.scheduledHour ?? 2;
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(input.now);
  const currentHour = Number(parts.find((part) => part.type === "hour")?.value);
  if (currentHour < hour) return false;
  if (!input.lastSuccessfulAt) return true;
  return localDay(input.lastSuccessfulAt, timeZone) !== localDay(input.now, timeZone);
}

export function retainedSuccessfulBackups(
  receipts: BackupReceipt[],
  options: { daily?: number; weekly?: number; timeZone?: string } = {},
): Set<string> {
  const daily = options.daily ?? 14;
  const weekly = options.weekly ?? 8;
  const timeZone = options.timeZone ?? systemTimeZone();
  const successes = receipts.filter((item) => item.successful)
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
  const keep = new Set<string>();
  const dayKeys = new Set<string>();
  const weekKeys = new Set<string>();
  for (const item of successes) {
    const date = new Date(item.completedAt);
    const day = localDay(date, timeZone);
    if (dayKeys.size < daily && !dayKeys.has(day)) {
      dayKeys.add(day);
      keep.add(item.id);
    }
    const week = isoWeekKey(date, timeZone);
    if (weekKeys.size < weekly && !weekKeys.has(week)) {
      weekKeys.add(week);
      keep.add(item.id);
    }
  }
  return keep;
}

const BACKUP_FILE = /^coordinator-(\d{8}T\d{6}Z)\.sqlite$/;

function backupTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseBackupTimestamp(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

/**
 * Keep rolling copies of the durable state database: at most one per local
 * day, retaining the newest daily and weekly copies. SQLite VACUUM INTO makes
 * a consistent copy while the coordinator stays in use.
 */
export function runStateBackupIfDue(input: {
  databasePath: string;
  backupRoot: string;
  now?: Date;
  timeZone?: string;
  daily?: number;
  weekly?: number;
}): { created: string | null; removed: string[] } {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? systemTimeZone();
  const backupRoot = resolve(input.backupRoot);
  if (!existsSync(input.databasePath)) return { created: null, removed: [] };
  mkdirSync(backupRoot, { recursive: true });
  const receipts = (): BackupReceipt[] => readdirSync(backupRoot).flatMap((name) => {
    const match = BACKUP_FILE.exec(name);
    return match ? [{ id: name, completedAt: parseBackupTimestamp(match[1]), successful: true }] : [];
  });
  const latest = receipts().map((receipt) => receipt.completedAt).sort().at(-1);
  let created: string | null = null;
  if (isDailyBackupDue({ now, lastSuccessfulAt: latest ? new Date(latest) : undefined, timeZone, scheduledHour: 0 })) {
    const name = `coordinator-${backupTimestamp(now)}.sqlite`;
    const temporary = join(backupRoot, `${name}.partial`);
    rmSync(temporary, { force: true });
    const database = new DatabaseSync(input.databasePath);
    try { database.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`); }
    finally { database.close(); }
    renameSync(temporary, join(backupRoot, name));
    created = join(backupRoot, name);
  }
  const keep = retainedSuccessfulBackups(receipts(), { daily: input.daily ?? 7, weekly: input.weekly ?? 4, timeZone });
  const removed = receipts().filter((receipt) => !keep.has(receipt.id)).map((receipt) => receipt.id);
  for (const name of removed) rmSync(join(backupRoot, name), { force: true });
  return { created, removed };
}
