// 構築済releaseの正規migrationを使い、未解決jobとResultを保持できるかを隔離DBで検証する。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {migrate} from '../scripts/maintenance/offline_state.mjs';

const release=process.argv[2];
if (!release || !path.isAbsolute(release)) throw Error('built release path required');
process.env.DONA_RELEASE_MANIFEST_PATH=path.join(release,'release-manifest.json');
const {default:Database}=await import(pathToFileURL(path.join(release,'updater/node_modules/better-sqlite3/lib/index.js')));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-offline-state-'));
try {
  const freshGeneration=process.argv.includes('--fresh-generation');
  const request={release,...(freshGeneration?{fresh_generation:true}:{}),databases:['dispatcher','notification','progress','updater'].map(name=>path.join(root,name+'.sqlite3')),
    run_id:'isolated-test',target_sha:'a'.repeat(40)};
  await migrate(request);
  if(freshGeneration){
    await migrate(request);
    const fresh=new Database(request.databases[0],{readonly:true});
    assert.equal(fresh.pragma('user_version',{simple:true}),4);fresh.close();
  }
  const db=new Database(request.databases[0]);
  const result=path.join(root,'result.json');
  await fs.writeFile(result,'{"status":"completed"}');
  try {
    db.prepare(`INSERT INTO events(event_id,schema_version,source,external_event_id,event_type,occurred_at,subject_json,payload_json,
      status,available_at,created_at,updated_at) VALUES ('evt_test',1,'slack','external_test','message',?, '{}','{}','completed',?,?,?)`).run(...Array(4).fill('2026-10-01T00:00:00Z'));
  } finally {db.close();}
  // Resultはfixture領域のみに置き、production pathへ触れない。
  const raw=new Database(request.databases[0]);
  try {
    raw.prepare(`INSERT INTO jobs(job_id,source_event_id,source,objective,workspace_json,status,available_at,workspace_path,result_path,
      agent_name,created_at,updated_at) VALUES ('job_test','evt_test','slack','保持対象','{}','needs_review',?,?,?,?,?,?)`)
      .run('2026-10-01T00:00:00Z',root,result,'dona-job-test','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
  } finally {raw.close();}
  if(freshGeneration)await assert.rejects(migrate(request),/fresh_database_not_empty/);
  else await migrate(request);
  const after=new Database(request.databases[0],{readonly:true});
  try {
    const job=after.prepare("SELECT status,result_path,objective FROM jobs WHERE job_id='job_test'").get();
    assert.deepEqual(job,{status:'needs_review',result_path:result,objective:'保持対象'});
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM events').get().n,1);
    assert.equal(after.pragma('integrity_check',{simple:true}),'ok');
  } finally {after.close();}
  assert.equal(await fs.readFile(result,'utf8'),'{"status":"completed"}');
  console.log(freshGeneration?'schema 4の空4DB、再開、既存仕事の拒否とResult保全を確認しました。':'未解決job・event・Resultを保持し、4DBのmigrationと再実行を確認しました。');
} finally {await fs.rm(root,{recursive:true,force:true});}
