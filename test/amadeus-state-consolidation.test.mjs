import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Coordinator } from "../src/coordinator.ts";
import { planConsolidation, applyConsolidation, recoverConsolidation, databaseFingerprint, canonicalCreateSql } from "../plugins/amadeus/scripts/state-consolidation.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Restricted Windows sandboxes deny rename() under the host AC\Temp redirect.
// Keep fixtures inside the writable workspace so atomic journal publication works.
function fixtureTempRoot() {
  const preferred = join(repoRoot, ".tmp", "consolidation-fixtures");
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return tmpdir();
  }
}

function fixture(t) {
  const root=mkdtempSync(join(fixtureTempRoot(),"amadeus-consolidation-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const roots=[join(root,"one"),join(root,"two")],target=join(root,"canonical");
  for(const source of roots) { mkdirSync(source); const c=new Coordinator(join(source,"coordinator.sqlite"));c.close(); }
  return {root,roots,target};
}
function seed(root,{id="g1",active=true,newer=true,detail="synthetic",jobStatus="queued"}={}) {
  const db=new DatabaseSync(join(root,"coordinator.sqlite"));
  const time=newer?"2026-01-02T00:00:00.000Z":"2026-01-01T00:00:00.000Z";
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO jobs(id,idempotency_key,objective,status,created_at,updated_at,goal_id) VALUES(?,?,?,?,?,?,?)").run(`job-${id}`,`job-key-${id}`,"synthetic",jobStatus,time,time,id);
  db.prepare("INSERT INTO goals(id,idempotency_key,objective,success_criteria,constraints_text,status,iteration_reserve_credit_micros,budget_credit_micros,current_job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,1,10,?,?,?)").run(id,`goal-key-${id}`,"synthetic","synthetic","synthetic",active?"active":"completed",`job-${id}`,time,time);
  db.prepare("INSERT INTO events(job_id,kind,detail,created_at) VALUES(?,?,?,?)").run(`job-${id}`,"synthetic",detail,time);
  db.prepare("INSERT INTO goal_events(goal_id,kind,detail,created_at) VALUES(?,?,?,?)").run(id,"synthetic",detail,time);
  db.prepare("INSERT INTO usage_records(job_id,attempt,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,estimated_credit_micros,reserved_credit_micros,rate_card_source,created_at) VALUES(?,1,'synthetic',1,0,0,1,0,1,1,'synthetic',?)").run(`job-${id}`,time);
  db.prepare("INSERT INTO patch_receipts(job_id,attempt,patch_path,patch_sha256,patch_bytes,changed_files,changed_lines,created_at) VALUES(?,1,'synthetic','synthetic',1,1,1,?)").run(`job-${id}`,time);
  db.prepare("INSERT INTO goal_git_approvals(id,goal_id,goal_revision,source_revision,action,decision,approval_reference,created_at) VALUES(?,?,1,'synthetic','commit','deny','synthetic',?)").run(`approval-${id}`,id,"2026-01-01T00:00:00.000Z");
  db.close();
  mkdirSync(join(root,"goal-packages",id),{recursive:true});writeFileSync(join(root,"goal-packages",id,"synthetic.json"),JSON.stringify({detail}));
}
function query(root,sql) { const db=new DatabaseSync(join(root,"coordinator.sqlite"),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();} }
async function apply(f,plan=planConsolidation({sourceRoots:f.roots,targetRoot:f.target}),extra={}) {return applyConsolidation(plan,{dryRun:false,quiescent:true,...extra});}

test("schema comparison ignores declaration order but retains real DDL differences", () => {
  const first = "CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT DEFAULT 'a,b')";
  const reordered = "CREATE TABLE jobs (note TEXT DEFAULT 'a,b', id TEXT PRIMARY KEY, status TEXT NOT NULL)";
  const changed = "CREATE TABLE jobs (note TEXT DEFAULT 'a,b', id TEXT PRIMARY KEY, status INTEGER NOT NULL)";
  assert.equal(canonicalCreateSql(first), canonicalCreateSql(reordered));
  assert.notEqual(canonicalCreateSql(first), canonicalCreateSql(changed));
});
test("disjoint histories preserve every table and allowlisted artifact; sources and backups verified",async t=>{
  const f=fixture(t);seed(f.roots[0],{id:"g1"});seed(f.roots[1],{id:"g2"});
  const before=f.roots.map(r=>databaseFingerprint(join(r,"coordinator.sqlite")));
  const plan=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});
  assert.equal(plan.ok,true);assert.equal(plan.counts.goals,2);assert.equal(existsSync(f.target),false);
  assert.equal((await applyConsolidation(plan)).applied,false);assert.equal(existsSync(f.target),false);
  const result=await apply(f,plan);assert.equal(result.ok,true);assert.equal(result.backupVerified,true);
  for(const table of ["goals","jobs","events","goal_events","usage_records","patch_receipts","goal_git_approvals"]) assert.equal(query(f.target,`SELECT count(*) AS n FROM ${table}`)[0].n,2);
  assert.deepEqual(f.roots.map(r=>databaseFingerprint(join(r,"coordinator.sqlite"))),before);
  const home=join(f.root,readdirSync(f.root).find(n=>n.startsWith(".amadeus-consolidation-")));
  assert.equal(readdirSync(join(home,"backups")).length,2);
  for(const id of ["g1","g2"]) assert.equal(existsSync(join(f.target,"goal-packages",id,"synthetic.json")),true);
  assert.equal(query(f.target,"PRAGMA foreign_key_check").length,0);
});

test("identical overlaps deduplicate, stable ordering ignores source order, rerun is idempotent",async t=>{
  const f=fixture(t);f.roots.forEach(r=>seed(r));
  const plan=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});
  assert.equal(plan.counts.goals,1);assert.equal(plan.counts.events,1);
  assert.deepEqual(plan,planConsolidation({sourceRoots:[...f.roots].reverse(),targetRoot:f.target}));
  assert.equal((await apply(f,plan)).ok,true);
  const before=readFileSync(join(f.target,"coordinator.sqlite"));
  const again=await apply(f);assert.equal(again.idempotent,true);assert.equal(again.applied,false);
  assert.deepEqual(readFileSync(join(f.target,"coordinator.sqlite")),before);
});

test("active goals and associated records win; newer records and losing variants remain recoverable",async t=>{
  const f=fixture(t);seed(f.roots[0],{active:false,newer:false,detail:"old",jobStatus:"completed"});seed(f.roots[1],{active:true,newer:true,detail:"new"});
  const plan=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});assert.equal(plan.ok,true);assert.ok(plan.preservedRecordVariants>=4);assert.equal(plan.preservedArtifactVariants,1);
  assert.equal((await apply(f,plan)).ok,true);
  assert.equal(query(f.target,"SELECT status FROM goals")[0].status,"active");assert.equal(query(f.target,"SELECT status FROM jobs")[0].status,"queued");
  assert.equal(query(f.target,"SELECT count(*) AS n FROM events")[0].n,2);
  assert.ok(query(f.target,"SELECT count(*) AS n FROM amadeus_consolidation_variants")[0].n>=4);
  assert.equal((await apply(f)).idempotent,true);
});

test("inactive newer records win deterministically while tied destructive and approval conflicts fail closed",async t=>{
  const f=fixture(t);seed(f.roots[0],{active:false,newer:false,jobStatus:"failed"});seed(f.roots[1],{active:false,newer:true});
  assert.equal((await apply(f)).ok,true);assert.equal(query(f.target,"SELECT status FROM jobs")[0].status,"queued");
  const db=new DatabaseSync(join(f.roots[1],"coordinator.sqlite"));db.exec("UPDATE goal_git_approvals SET decision='allow'");db.close();
  const blocked=planConsolidation({sourceRoots:f.roots,targetRoot:join(f.root,"blocked")});assert.equal(blocked.ok,false);assert.ok(blocked.conflicts.some(c=>c.table==="goal_git_approvals"&&c.reason==="ambiguous-authority"));
  assert.equal((await applyConsolidation(blocked,{dryRun:false,quiescent:true})).applied,false);
});

test("independent event sequences retain both records and usage uniqueness collisions fail closed",async t=>{
  const f=fixture(t);seed(f.roots[0],{detail:"a"});seed(f.roots[1],{detail:"b"});
  // Same goal package path is ambiguous at an equal revision; preserve roots and block.
  const blocked=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});assert.equal(blocked.ok,false);assert.ok(blocked.conflicts.some(c=>c.reason==="ambiguous-artifact"));
  writeFileSync(join(f.roots[1],"goal-packages","g1","synthetic.json"),readFileSync(join(f.roots[0],"goal-packages","g1","synthetic.json")));
  const db=new DatabaseSync(join(f.roots[1],"coordinator.sqlite"));db.exec("UPDATE usage_records SET input_tokens=9");db.close();
  const usage=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});assert.equal(usage.ok,false);assert.ok(usage.conflicts.some(c=>c.table==="usage_records"));
  assert.equal(JSON.stringify(usage).includes('"objective"'),false);assert.equal(JSON.stringify(usage).includes(f.root),false);
});

test("consistent snapshots include committed WAL rows without copying WAL or SHM",async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});
  const live=new DatabaseSync(join(f.roots[0],"coordinator.sqlite"));live.exec("PRAGMA journal_mode=WAL; UPDATE settings SET value='true' WHERE key='paused'");
  let result;try {result=await apply(f);}finally{live.close();}assert.equal(result.ok,true);
  const home=join(f.root,readdirSync(f.root).find(n=>n.startsWith(".amadeus-consolidation-")));
  for(const name of readdirSync(join(home,"backups"))) assert.deepEqual(readdirSync(join(home,"backups",name)).filter(n=>n.includes("sqlite")),["coordinator.sqlite"]);
});

test("rollback restores an existing canonical root exactly and preserves publication and sources",async t=>{
  const f=fixture(t);seed(f.roots[0],{id:"g1"});seed(f.roots[1],{id:"g2"});mkdirSync(f.target);const c=new Coordinator(join(f.target,"coordinator.sqlite"));c.close();seed(f.target,{id:"g3"});
  const before=readFileSync(join(f.target,"coordinator.sqlite"));assert.equal((await apply(f)).ok,true);assert.equal(query(f.target,"SELECT count(*) AS n FROM goals")[0].n,3);
  assert.equal(recoverConsolidation({targetRoot:f.target,rollback:true}).dryRun,true);
  assert.equal(recoverConsolidation({targetRoot:f.target,rollback:true,dryRun:false,quiescent:true}).ok,true);
  assert.deepEqual(readFileSync(join(f.target,"coordinator.sqlite")),before);
  assert.equal(recoverConsolidation({targetRoot:f.target,rollback:true,dryRun:false,quiescent:true}).idempotent,true);
});

for(const phase of ["locked","staged","target-preserved","published"]) test(`interruption at ${phase} recovers without losing the original target`,async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});mkdirSync(f.target);const c=new Coordinator(join(f.target,"coordinator.sqlite"));c.close();
  const before=readFileSync(join(f.target,"coordinator.sqlite"));
  const result=await apply(f,undefined,{onPhase:p=>{if(p===phase)throw new Error("synthetic interruption");}});assert.equal(result.ok,false);
  assert.equal(recoverConsolidation({targetRoot:f.target,dryRun:false,quiescent:true}).ok,true);
  assert.deepEqual(readFileSync(join(f.target,"coordinator.sqlite")),before);
  assert.equal((await apply(f)).ok,true);
});

test("an interrupted rollback before preserving a new canonical root resumes safely",async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});assert.equal((await apply(f)).ok,true);
  const home=join(f.root,readdirSync(f.root).find(n=>n.startsWith(".amadeus-consolidation-"))),path=join(home,"journal.json");
  const journal=JSON.parse(readFileSync(path,"utf8"));journal.status="rolling-back";writeFileSync(path,JSON.stringify(journal));
  assert.equal(recoverConsolidation({targetRoot:f.target,dryRun:false,quiescent:true}).ok,true);assert.equal(existsSync(f.target),false);assert.equal(existsSync(join(home,"preserved-publication","coordinator.sqlite")),true);
});

test("stale plans, incompatible schemas, occupied targets, and post-cutover writes are refused",async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});
  const plan=planConsolidation({sourceRoots:f.roots,targetRoot:f.target});writeFileSync(join(f.roots[0],"preferences.json"),"{}");
  assert.equal((await apply(f,plan)).ok,false);assert.equal(existsSync(f.target),false);
  assert.equal((await apply(f)).ok,true);writeFileSync(join(f.target,"post-cutover.txt"),"synthetic");
  assert.equal(recoverConsolidation({targetRoot:f.target,rollback:true,dryRun:false,quiescent:true}).ok,false);
  const db=new DatabaseSync(join(f.roots[1],"coordinator.sqlite"));db.exec("ALTER TABLE goals ADD COLUMN incompatible TEXT");db.close();
  assert.equal(planConsolidation({sourceRoots:f.roots,targetRoot:join(f.root,"other")}).conflicts[0].reason,"schema-mismatch");
});

test("an older active goal still wins and forged plans cannot bypass conflict review",async t=>{
  const f=fixture(t);seed(f.roots[0],{active:true,newer:false,jobStatus:"running",detail:"active"});seed(f.roots[1],{active:false,newer:true,jobStatus:"completed",detail:"inactive"});
  assert.equal((await apply(f)).ok,true);assert.equal(query(f.target,"SELECT status FROM goals")[0].status,"active");assert.equal(query(f.target,"SELECT status FROM jobs")[0].status,"running");
  const forged={ok:true,counts:{}};assert.equal((await applyConsolidation(forged,{dryRun:false,quiescent:true})).applied,false);
});

test("rollback of a new target preserves publication; tampered prior roots refuse recovery",async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});assert.equal((await apply(f)).ok,true);
  assert.equal(recoverConsolidation({targetRoot:f.target,dryRun:false,rollback:true,quiescent:true}).ok,true);assert.equal(existsSync(f.target),false);
  assert.equal((await apply(f)).ok,true);
  const existing=join(f.root,"existing");mkdirSync(existing);const c=new Coordinator(join(existing,"coordinator.sqlite"));c.close();
  const p=planConsolidation({sourceRoots:f.roots,targetRoot:existing});assert.equal((await applyConsolidation(p,{dryRun:false,quiescent:true})).ok,true);
  const transaction=readdirSync(f.root).filter(n=>n.startsWith(".amadeus-consolidation-")).map(n=>join(f.root,n)).find(n=>existsSync(join(n,"prior")));
  writeFileSync(join(transaction,"prior","tampered.txt"),"synthetic");
  assert.equal(recoverConsolidation({targetRoot:existing,dryRun:false,rollback:true,quiescent:true}).ok,false);assert.equal(query(existing,"SELECT count(*) AS n FROM goals")[0].n,2);
});

test("idempotency-key ambiguity and overlapping roots are explicit blocking conflicts",t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});const db=new DatabaseSync(join(f.roots[1],"coordinator.sqlite"));db.exec("UPDATE goals SET idempotency_key='goal-key-g1'");db.close();
  assert.ok(planConsolidation({sourceRoots:f.roots,targetRoot:f.target}).conflicts.some(c=>c.reason==="ambiguous-idempotency-key"));
  assert.equal(planConsolidation({sourceRoots:[f.roots[0]],targetRoot:join(f.roots[0],"nested")}).conflicts[0].reason,"overlapping-state-roots");
});

test("abrupt process exit during publication is recoverable and CLI dry-run emits aggregates only",async t=>{
  const f=fixture(t);seed(f.roots[0]);seed(f.roots[1],{id:"g2"});mkdirSync(f.target);const c=new Coordinator(join(f.target,"coordinator.sqlite"));c.close();
  const original=readFileSync(join(f.target,"coordinator.sqlite"));
  const module=new URL("../plugins/amadeus/scripts/state-consolidation.mjs",import.meta.url).href;
  const child=spawnSync(process.execPath,["--input-type=module","-e",`const {planConsolidation,applyConsolidation}=await import(process.argv[1]); const options=JSON.parse(process.argv[2]);await applyConsolidation(planConsolidation(options),{dryRun:false,quiescent:true,onPhase:phase=>{if(phase==='target-preserved')process.exit(78)}});`,module,JSON.stringify({sourceRoots:f.roots,targetRoot:f.target})],{encoding:"utf8"});
  assert.equal(child.status,78);assert.equal(existsSync(f.target),false);
  assert.equal(recoverConsolidation({targetRoot:f.target,dryRun:false,quiescent:true}).ok,true);assert.deepEqual(readFileSync(join(f.target,"coordinator.sqlite")),original);
  const cli=new URL("../plugins/amadeus/scripts/migrate-state.mjs",import.meta.url);
  const preview=spawnSync(process.execPath,["--input-type=module","-e",`const {fileURLToPath}=await import('node:url');const entry=process.argv[1];process.argv=[process.argv[0],fileURLToPath(entry),...process.argv.slice(2)];await import(entry);`,cli.href,"consolidate","--source-root",f.roots[0],"--source-root",f.roots[1],"--target-root",join(f.root,"preview")],{encoding:"utf8"});
  assert.equal(preview.status,0);const report=JSON.parse(preview.stdout);assert.equal(report.plan.ok,true);assert.equal(report.plan.sourceCount,2);assert.equal(report.result.applied,false);assert.equal(preview.stdout.includes(f.root),false);assert.equal(preview.stdout.includes('"objective"'),false);assert.equal(existsSync(join(f.root,"preview")),false);
});
