/** Local-only consolidation. Public results contain counts and opaque digests only. */
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync as fsRenameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TABLES = ["settings", "jobs", "goals", "events", "goal_events", "usage_records", "patch_receipts", "goal_git_approvals"];
const TREES = ["goal-packages", "goal-runs", "active-goal-runs", "patches", "project-checkpoints", "retired-goal-run-locks", "reconciliation-backups", "providers", "updates", "preferences.json", "worker-source-manifest.json", "runtime-config"];
const SERIAL = { events: "sequence", goal_events: "sequence", usage_records: "id", patch_receipts: "id" };
const plans = new WeakMap();
// Windows briefly locks a just-written directory (antivirus, indexer, SQLite handle release),
// so a directory rename can fail with EPERM/EBUSY/EACCES for a moment. Retry with backoff.
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameSync(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fsRenameSync(from, to); }
    catch (error) { if (!TRANSIENT_RENAME.has(error?.code) || attempt >= 8) throw error; pause(25 * 2 ** attempt); }
  }
}
const q = value => `"${String(value).replaceAll('"', '""')}"`;
const encode = value => JSON.stringify(value, (_, v) => typeof v === "bigint" ? { integer: v.toString() } : v instanceof Uint8Array ? { blob: Buffer.from(v).toString("base64") } : v);
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : encode(value)).digest("hex");
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const fail = code => { throw new Error(code); };
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(rel).startsWith(`${sep}${sep}`) && !/^[A-Za-z]:/.test(rel)); };

function normalizeSqlFragment(value) {
  return String(value ?? "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
    .replace(/`([A-Za-z_][A-Za-z0-9_]*)`/g, "$1")
    .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

/** Normalize harmless column/constraint declaration order without hiding DDL changes. */
export function canonicalCreateSql(sql) {
  const text = String(sql ?? "").trim();
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close <= open) return normalizeSqlFragment(text);
  const body = text.slice(open + 1, close);
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (quote === "]" ? char === "]" : char === quote) {
        if (body[index + 1] === char && quote !== "]") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "[") { quote = "]"; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(normalizeSqlFragment(body.slice(start, index)));
      start = index + 1;
    }
  }
  parts.push(normalizeSqlFragment(body.slice(start)));
  return `${normalizeSqlFragment(text.slice(0, open))}(${parts.sort(compare).join(",")})${normalizeSqlFragment(text.slice(close + 1))}`;
}

function schemaSignature(database) {
  return {
    version: database.version,
    objects: database.schema.map(object => ({
      type: object.type,
      name: object.name,
      table: object.tbl_name,
      sql: object.type === "table" ? canonicalCreateSql(object.sql) : normalizeSqlFragment(object.sql),
    })).sort((a, b) => compare(encode(a), encode(b))),
  };
}

function openReader(path) {
  for(const file of [path,`${path}-wal`,`${path}-shm`]) if(existsSync(file) && lstatSync(file).isSymbolicLink()) fail("database-unsafe-link");
  // An offline WAL-mode database can otherwise acquire new sidecars merely
  // from opening a reader. Immutable mode is safe only with no WAL, and the
  // complete file fingerprint is checked around that read to reject changes.
  const offline = !existsSync(`${path}-wal`);
  if(!offline && !existsSync(`${path}-shm`)) fail("database-readonly-wal-needs-existing-shm");
  const before = offline ? hash(readFileSync(path)) : null;
  const db = new DatabaseSync(offline ? `${pathToFileURL(path).href}?immutable=1&mode=ro` : path,{readOnly:true});
  return {db,check:()=> { if(offline && (existsSync(`${path}-wal`) || hash(readFileSync(path))!==before)) fail("database-changed-during-read"); }};
}

function files(root) {
  const result = new Map();
  if (!existsSync(root)) return result;
  const visit = path => {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !inside(root, resolve(path))) fail("unsafe-artifact-link");
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (st.isFile()) result.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path));
    else fail("unsupported-artifact-type");
  };
  for (const name of [...TREES,"migration/artifact-variants"]) if (existsSync(join(root, name))) visit(join(root, name));
  return result;
}

function readDatabase(path) {
  let db;
  try {
    const reader=openReader(path); db=reader.db;
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("database-integrity");
    if (db.prepare("PRAGMA foreign_key_check").all().length) fail("database-foreign-keys");
    const allSchema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const archive = "amadeus_consolidation_variants";
    const schema = allSchema.filter(s => s.tbl_name !== archive);
    const variants = allSchema.some(s => s.name === archive) ? db.prepare(`SELECT * FROM ${archive} ORDER BY digest`).all() : [];
    if (schema.some(s => s.type !== "table" && s.type !== "index")) fail("unsupported-schema-object");
    const tables = schema.filter(s => s.type === "table");
    if (tables.some(s => !TABLES.includes(s.name))) fail("unsupported-state-table");
    const rows = {}, columns = {};
    for (const table of tables) {
      columns[table.name] = db.prepare(`PRAGMA table_info(${q(table.name)})`).all();
      const stmt = db.prepare(`SELECT * FROM ${q(table.name)}`);
      stmt.setReadBigInts(true);
      rows[table.name] = stmt.all().sort((a,b) => compare(encode(a),encode(b)));
    }
    const version = db.prepare("PRAGMA user_version").get().user_version;
    db.exec("ROLLBACK");
    reader.check();
    return { schema, columns, rows, version, variants, digest: hash({ schema, rows, version, variants }) };
  } catch (error) {
    if (/^(database-|unsupported-)/.test(error.message)) throw error;
    fail("database-snapshot-unavailable");
  } finally { db?.close(); }
}

function readRoot(root) {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || lstatSync(join(root,"coordinator.sqlite")).isSymbolicLink()) fail("unsafe-source-link");
  const database = readDatabase(join(root, "coordinator.sqlite"));
  const artifacts = files(root);
  return { root, database, artifacts, digest: hash([database.digest, [...artifacts].map(([p,b]) => [p,hash(b)])]) };
}

function timestamp(row) {
  const value = row.updated_at ?? row.created_at;
  const millis = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

function merge(sources) {
  const schema = sources[0].database;
  const expectedSchema = hash(schemaSignature(schema));
  if (sources.some(source => hash(schemaSignature(source.database)) !== expectedSchema)) fail("schema-mismatch");
  const rows = {}, variants = [], priorVariants = sources.flatMap(s => s.database.variants), conflicts = [], active = new Map();
  const block = (table, key, reason) => conflicts.push({ table, keyDigest: hash(key), reason });
  const isActive = (source, row, table) => {
    if (table === "goals") return row.status === "active";
    const goal = row.goal_id ?? sources[source].database.rows.jobs?.find(j => j.id === row.job_id)?.goal_id;
    return Boolean(goal && active.get(`${source}:${goal}`));
  };
  sources.forEach((s,i) => s.database.rows.goals?.forEach(g => active.set(`${i}:${g.id}`, g.status === "active")));
  for (const table of ["goals", "jobs", "settings", "events", "goal_events", "usage_records", "patch_receipts", "goal_git_approvals"]) {
    if (!schema.rows[table]) continue;
    const selected = new Map();
    sources.forEach((source, sourceIndex) => {
      for (const original of source.database.rows[table]) {
        const row = { ...original };
        if (SERIAL[table]) delete row[SERIAL[table]];
        const key = table === "settings" ? row.key : ["events","goal_events"].includes(table) ? hash(row) : ["usage_records","patch_receipts"].includes(table) ? encode([row.job_id,row.attempt]) : row.id;
        const prev = selected.get(key);
        if (!prev) { selected.set(key, { row, source: sourceIndex }); continue; }
        if (encode(prev.row) === encode(row)) continue;
        const a = isActive(sourceIndex,row,table), b = isActive(prev.source,prev.row,table);
        const ta = timestamp(row), tb = timestamp(prev.row);
        // Approval and setting differences never grant new authority implicitly.
        if (["settings","goal_git_approvals"].includes(table)) { block(table,key,"ambiguous-authority"); continue; }
        let wins;
        if (a !== b) wins = a;
        else if (ta !== null && tb !== null && ta !== tb) wins = ta > tb;
        else { block(table,key,"ambiguous-record"); continue; }
        const losing = wins ? prev : { row, source: sourceIndex };
        variants.push({ table, key: hash(key), source: sources[losing.source].digest, row: losing.row });
        if (wins) selected.set(key, { row, source: sourceIndex });
      }
    });
    rows[table] = [...selected.values()].map(v => v.row).sort((a,b) => {
      if (["events","goal_events"].includes(table) && a.created_at !== b.created_at) return compare(String(a.created_at),String(b.created_at));
      return compare(encode(a),encode(b));
    }).map((r,i) => SERIAL[table] ? { ...r,[SERIAL[table]]: i+1 } : r);
    if(["jobs","goals"].includes(table)) {
      const keys=new Set();
      for(const row of rows[table]) if(row.idempotency_key!==undefined) {
        if(keys.has(row.idempotency_key)) block(table,row.idempotency_key,"ambiguous-idempotency-key");
        keys.add(row.idempotency_key);
      }
    }
  }
  const artifacts = new Map(), artifactVariants = new Map();
  for (const source of sources) for (const [path,bytes] of source.artifacts) {
    const prev = artifacts.get(path);
    if (!prev || hash(prev.bytes) === hash(bytes)) { if (!prev) artifacts.set(path,{bytes,source}); continue; }
    const goalId = path.split("/")[1];
    const g = source.database.rows.goals?.find(g => g.id === goalId);
    const p = prev.source.database.rows.goals?.find(g => g.id === goalId);
    const goalArtifact = ["goal-packages","goal-runs","active-goal-runs"].includes(path.split("/")[0]);
    let wins;
    if (goalArtifact && g && p && (g.status === "active") !== (p.status === "active")) wins = g.status === "active";
    else if (goalArtifact && g && p && timestamp(g) !== null && timestamp(p) !== null && timestamp(g) !== timestamp(p)) wins = timestamp(g) > timestamp(p);
    else { block("artifacts",path,"ambiguous-artifact"); continue; }
    const loser = wins ? prev.bytes : bytes;
    artifactVariants.set(hash([path,hash(loser)]),loser);
    if (wins) artifacts.set(path,{bytes,source});
  }
  return { schema, rows, variants, priorVariants, artifacts, artifactVariants, conflicts };
}

/** Explicit roots only. No discovery, configuration writes, cutover or source writes. */
export function planConsolidation({ sourceRoots, targetRoot } = {}) {
  try {
    if (!Array.isArray(sourceRoots) || !sourceRoots.length || !targetRoot) fail("explicit-roots-required");
    const target = resolve(targetRoot), roots = [];
    for (const value of sourceRoots) {
      const root = resolve(value);
      if (!roots.some(r => samePath(r,root))) roots.push(root);
    }
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) fail("unsafe-target-link");
      if (existsSync(join(target,"coordinator.sqlite"))) {
        const root = target;
        if (!roots.some(r => samePath(r,root))) roots.push(root);
      } else if (readdirSync(target).length) fail("nonempty-target-without-database");
    }
    if (roots.some(r => !samePath(r,target) && (inside(r,target) || inside(target,r)))) fail("overlapping-state-roots");
    const sources = roots.map(readRoot).sort((a,b) => compare(a.digest,b.digest));
    const merged = merge(sources);
    if(!merged.conflicts.length) {
      try { writeDatabase(":memory:",merged); }
      catch { merged.conflicts.push({table:"database",reason:"merged-contract-conflict"}); }
    }
    const result = { ok: merged.conflicts.length === 0, dryRun: true, sourceCount: sources.length,
      inputDigest: hash(sources.map(s => s.digest)), counts: Object.fromEntries(Object.entries(merged.rows).map(([t,r]) => [t,r.length])),
      preservedRecordVariants: merged.variants.length, artifactCount: merged.artifacts.size, preservedArtifactVariants: merged.artifactVariants.size,
      conflicts: merged.conflicts };
    plans.set(result,{ sources, target, merged });
    return result;
  } catch (error) { return { ok:false, dryRun:true, error:"consolidation-inspection-failed", conflicts:[{reason:/^(schema-mismatch|database-|unsupported-|unsafe-|overlapping-|explicit-|nonempty-)/.test(error.message) ? error.message : "snapshot-or-root-unavailable"}] }; }
}

export function databaseFingerprint(path) { return readDatabase(path).digest; }

/** Synchronous consistent snapshot for the older single-root API; never copies WAL. */
export function snapshotDatabase(source, destination) {
  const reader=openReader(source),db=reader.db;
  try { db.prepare("VACUUM INTO ?").run(destination); }
  catch { fail("database-snapshot-unavailable"); }
  finally { db.close(); }
  reader.check();
  if(databaseFingerprint(source)!==databaseFingerprint(destination)) fail("source-changed-during-snapshot");
}

function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp,"wx");
  try { writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp,path); // Never weaken atomic publication to a replace-in-place write.
}
function control(target) { return join(dirname(target),`.amadeus-consolidation-${hash(target).slice(0,16)}`); }
function writeBytes(path, bytes) { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,bytes,{flag:"wx"}); }
function digestTree(root) {
  const entries = [];
  const walk = dir => { for (const name of readdirSync(dir).sort()) { const path=join(dir,name),st=lstatSync(path); if(st.isSymbolicLink()) fail("unsafe-published-link"); if(st.isDirectory()) walk(path); else entries.push([relative(root,path).replaceAll("\\","/"),hash(readFileSync(path))]); } };
  walk(root); return hash(entries);
}
function writeDatabase(path, merged) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    for(const s of merged.schema.schema.filter(s=>s.type==="table")) db.exec(s.sql);
    for(const [table,rows] of Object.entries(merged.rows)) for(const row of rows) {
      const names=Object.keys(row); db.prepare(`INSERT INTO ${q(table)} (${names.map(q).join(",")}) VALUES (${names.map(()=>"?").join(",")})`).run(...names.map(n=>row[n]));
    }
    for(const s of merged.schema.schema.filter(s=>s.type==="index" && s.sql)) db.exec(s.sql);
    db.exec("CREATE TABLE amadeus_consolidation_variants (digest TEXT PRIMARY KEY, table_name TEXT NOT NULL, record_json TEXT NOT NULL)");
    const insert=db.prepare("INSERT OR IGNORE INTO amadeus_consolidation_variants VALUES (?,?,?)");
    for(const variant of merged.priorVariants) insert.run(variant.digest,variant.table_name,variant.record_json);
    for(const variant of merged.variants) insert.run(hash(variant),variant.table,encode(variant));
    db.exec(`PRAGMA user_version=${merged.schema.version}; COMMIT;`);
    if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok" || db.prepare("PRAGMA foreign_key_check").all().length) fail("merged-database-invalid");
  } finally { db.close(); }
}

/** Execution is opt-in and requires all coordinators using the target to be stopped. */
export async function applyConsolidation(plan, options = {}) {
  if(options.dryRun !== false) return { ...plan, applied:false };
  const privatePlan=plans.get(plan);
  if(!plan.ok || !privatePlan || privatePlan.merged.conflicts.length) return {ok:false,applied:false,error:"reviewed-plan-required"};
  if(options.quiescent !== true) return {ok:false,applied:false,error:"quiescent-target-required"};
  const { sources,target,merged }=privatePlan, home=control(target);
  if(samePath(dirname(target),target) || (existsSync(dirname(target)) && lstatSync(dirname(target)).isSymbolicLink()) || (existsSync(home) && lstatSync(home).isSymbolicLink())) return {ok:false,applied:false,error:"unsafe-transaction-root"};
  try { if(sources.some(s=>readRoot(s.root).digest!==s.digest)) return {ok:false,applied:false,error:"stale-plan"}; }
  catch { return {ok:false,applied:false,error:"source-snapshot-unavailable"}; }
  const current=sources.find(s=>samePath(s.root,target));
  const normalizedRows = rows => Object.fromEntries(Object.entries(rows).sort(([a],[b])=>compare(a,b)).map(([t,rs])=>[t,rs.map(r=>{const row={...r};if(SERIAL[t])delete row[SERIAL[t]];return encode(row);}).sort()]));
  if(current && hash(normalizedRows(current.database.rows))===hash(normalizedRows(merged.rows)) &&
    merged.variants.every(v=>current.database.variants.some(old=>old.digest===hash(v))) &&
    [...merged.artifactVariants].every(([id,b])=>current.artifacts.has(`migration/artifact-variants/${id}`)&&hash(b)===hash(current.artifacts.get(`migration/artifact-variants/${id}`))) &&
    merged.artifacts.size===current.artifacts.size && [...merged.artifacts].every(([p,v])=>current.artifacts.has(p)&&hash(v.bytes)===hash(current.artifacts.get(p)))) {
    return {ok:true,applied:false,idempotent:true,counts:plan.counts};
  }
  mkdirSync(home,{recursive:true});
  const journalPath=join(home,"journal.json");
  if(existsSync(journalPath)) {
    let prior;
    try { prior=JSON.parse(readFileSync(journalPath,"utf8")); } catch { return {ok:false,applied:false,error:"invalid-journal"}; }
    if(prior.status!=="rolled-back") return {ok:false,applied:false,error:"recover-existing-transaction-first"};
    renameSync(home,`${home}-preserved-${randomUUID()}`); mkdirSync(home);
  }
  let lock;
  try { lock=openSync(join(home,"lock"),"wx"); } catch { return {ok:false,applied:false,error:"transaction-locked"}; }
  const journal={version:1,status:"preparing",inputDigest:plan.inputDigest,hadTarget:existsSync(target),publishedDigest:null,priorDigest:null,backups:[]};
  try {
    options.onPhase?.("locked");
    journal.priorDigest=journal.hadTarget?digestTree(target):null;
    atomicJson(journalPath,journal);
    if(sources.some(s=>readRoot(s.root).digest!==s.digest)) fail("stale-plan");
    if(existsSync(join(target,"coordinator.sqlite-wal")) || existsSync(join(target,"coordinator.sqlite-shm"))) fail("target-not-offline");
    const stage=join(home,"stage"); mkdirSync(stage);
    for(let i=0;i<sources.length;i++) {
      const source=sources[i],dest=join(home,"backups",`source-${i}`); mkdirSync(dest,{recursive:true});
      const reader=openReader(join(source.root,"coordinator.sqlite")),db=reader.db;
      try { await backup(db,join(dest,"coordinator.sqlite")); } finally { db.close(); }
      reader.check();
      const snapshot=new DatabaseSync(join(dest,"coordinator.sqlite"));
      try { snapshot.exec("PRAGMA journal_mode=DELETE;"); } finally { snapshot.close(); }
      if(readDatabase(join(dest,"coordinator.sqlite")).digest!==source.database.digest) fail("source-changed-during-snapshot");
      for(const [p,b] of source.artifacts) writeBytes(join(dest,p),b);
      if(readRoot(source.root).digest!==source.digest) fail("source-changed-during-backup");
      if(readRoot(dest).digest!==source.digest) fail("backup-verification-failed");
      journal.backups.push({sourceIndex:i,logicalDigest:source.digest,treeDigest:digestTree(dest),verified:true});
      atomicJson(journalPath,journal);
    }
    writeDatabase(join(stage,"coordinator.sqlite"),merged);
    for(const [p,v] of merged.artifacts) writeBytes(join(stage,p),v.bytes);
    for(const [id,b] of merged.artifactVariants) writeBytes(join(stage,"migration","artifact-variants",id),b);
    journal.publishedDigest=digestTree(stage);
    journal.status="staged"; atomicJson(journalPath,journal); options.onPhase?.("staged");
    journal.status="publishing"; atomicJson(journalPath,journal);
    if(journal.hadTarget && digestTree(target)!==journal.priorDigest) fail("target-changed-before-publication");
    if(journal.hadTarget) renameSync(target,join(home,"prior"));
    options.onPhase?.("target-preserved");
    renameSync(stage,target); options.onPhase?.("published");
    journal.status="complete"; atomicJson(journalPath,journal);
    return {ok:true,applied:true,backupVerified:true,counts:plan.counts};
  } catch (error) { return {ok:false,applied:false,error:"consolidation-interrupted-recover-before-retry",cause:error?.code ?? null}; }
  finally { if(lock!==undefined) closeSync(lock); }
}

/** Preserves the published root and all verified source snapshots; never deletes state. */
export function recoverConsolidation({ targetRoot, dryRun=true, rollback=false, quiescent=false }={}) {
  try {
    const target=resolve(targetRoot),home=control(target),path=join(home,"journal.json");
    if(existsSync(home) && lstatSync(home).isSymbolicLink()) fail("unsafe-transaction-root");
    if(existsSync(home) && !existsSync(path)) {
      if(readdirSync(home).some(name=>name!=="lock" && !/^journal\.json\.[A-Za-z0-9-]+\.tmp$/.test(name))) fail("ambiguous-orphan-transaction");
      if(dryRun) return {ok:true,dryRun:true,status:"uninitialized"};
      if(!quiescent) fail("quiescent-target-required");
      renameSync(home,`${home}-preserved-${randomUUID()}`);
      return {ok:true,status:"rolled-back",backupsPreserved:true};
    }
    const journal=JSON.parse(readFileSync(path,"utf8"));
    if(journal.version!==1 || !["preparing","staged","publishing","complete","rolling-back","rolled-back"].includes(journal.status)) fail("invalid-journal");
    if(dryRun) return {ok:true,dryRun:true,status:journal.status};
    if(!quiescent) fail("quiescent-target-required");
    // A persistent lock intentionally survives a process exit. Explicit recovery
    // requires the operator to establish that the original process has stopped.
    if(journal.status==="rolled-back") return {ok:true,status:journal.status,idempotent:true};
    const prior=join(home,"prior");
    if(existsSync(prior) && digestTree(prior)!==journal.priorDigest) fail("prior-root-changed-refuse-recovery");
    for(const item of journal.backups ?? []) {
      if(!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex<0 || !item.verified || digestTree(join(home,"backups",`source-${item.sourceIndex}`))!==item.treeDigest) fail("backup-changed-refuse-recovery");
    }
    if(journal.hadTarget && !existsSync(prior) && journal.status!=="complete") {
      if(!existsSync(target) || digestTree(target)!==journal.priorDigest) fail("prior-root-unavailable");
    }
    if(journal.status==="complete" && !rollback) return {ok:true,status:"complete",idempotent:true};
    const published=journal.status==="complete" || (journal.status==="publishing" && !existsSync(join(home,"stage")));
    if(existsSync(target) && published) {
      if(digestTree(target)!==journal.publishedDigest) fail("target-changed-refuse-rollback");
      journal.status="rolling-back"; atomicJson(path,journal);
      renameSync(target,join(home,"preserved-publication"));
    }
    if(journal.status==="rolling-back" && existsSync(target)) {
      const preserved=join(home,"preserved-publication"),digest=digestTree(target);
      if(!existsSync(preserved) && digest===journal.publishedDigest) renameSync(target,preserved);
      else if(!journal.hadTarget || digest!==journal.priorDigest || existsSync(prior)) fail("ambiguous-recovery");
    }
    if(existsSync(prior)) {
      if(existsSync(target)) fail("target-occupied-refuse-recovery");
      renameSync(prior,target);
    }
    journal.status="rolled-back"; atomicJson(path,journal);
    return {ok:true,status:"rolled-back",backupsPreserved:true};
  } catch { return {ok:false,error:"recovery-refused"}; }
}
