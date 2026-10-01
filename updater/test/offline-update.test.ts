import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {UpdateDatabase} from '../src/database.js';
import {tempPolicy,currentSha,targetSha} from './helpers.js';

// 動的importによりCLIのJSをそのまま検証する。
const {retireUpdates} = await import(pathToFileURL(path.resolve('../scripts/maintenance/offline_state.mjs')).href);
test('停止更新は旧requestと監査履歴を残して自動再開・古い通知だけを止める', async () => {
  const {root,policy}=await tempPolicy();
  const file=path.join(policy.control_root,'updater.sqlite3');
  try {
    const store=new UpdateDatabase(file);
    const target={kind:'slack_thread' as const,workspace_id:'T_TEST',channel_id:'C_TEST',thread_ts:'1756722030.123456'};
    const material={current_sha:currentSha,target_sha:targetSha,previous_sha:null,policy_version:policy.policy_version,
      compatibility:policy.compatibility,rollback_compatible:true};
    const first=store.createPlan({source_event_id:'evt_01M1ES03XY5CF8D9PM5CWX4SRV',reply_target:target},material).row;
    store.requestCancellation(first.request_id,'evt_01M1ES03XY5CF8D9PM5CWX4SRX',target,'test');
    const setup=new Database(file);
    setup.prepare("UPDATE update_outbox SET status='delivered',slack_reported_at='2026-10-01T00:00:00Z'").run();
    setup.close();
    const second=store.createPlan({source_event_id:'evt_01M1ES03XY5CF8D9PM5CWX4SRW',reply_target:target},material).row;
    store.close();
    const db=new Database(file);
    try {
      db.prepare("UPDATE update_requests SET state='activating',last_error_code='stop_dispatcher_observation_timeout' WHERE request_id=?").run(second.request_id);
      db.prepare("UPDATE update_outbox SET status='pending',slack_reported_at=NULL").run();
      retireUpdates(db,'offline-test',targetSha);
      const row=db.prepare('SELECT * FROM update_requests WHERE request_id=?').get(second.request_id) as Record<string,unknown>;
      assert.equal(row.state,'needs_review');assert.equal(row.last_error_code,'offline_update_superseded');
      assert.equal(row.fence,second.fence+1);
      assert.equal((db.prepare('SELECT state FROM update_requests WHERE request_id=?').get(first.request_id) as {state:string}).state,'cancelled');
      assert.equal((db.prepare('SELECT status FROM update_outbox').get() as {status:string}).status,'needs_review');
      const audit=db.prepare("SELECT details_json FROM update_audit WHERE code='offline_update_superseded'").all() as Array<{details_json:string}>;
      assert.equal(audit.length,1);
      assert.equal(JSON.parse(audit[0]!.details_json).previous_error_code,'stop_dispatcher_observation_timeout');
      retireUpdates(db,'offline-test',targetSha);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM update_audit WHERE code='offline_update_superseded'").get() as {n:number}).n,1);
      assert.equal((db.prepare('SELECT active_request_id FROM controller_state').get() as {active_request_id:null}).active_request_id,null);
    } finally {db.close();}
    const reopened=new UpdateDatabase(file);
    try {assert.equal(reopened.nonTerminalCount(),0);assert.equal(reopened.reconcilableNeedsReview().length,0);}
    finally {reopened.close();}
  } finally {await fs.rm(root,{recursive:true,force:true});}
});


test('v1への復旧ではschemaを変更せず旧requestをretireする', () => {
  const db=new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE update_requests(request_id TEXT PRIMARY KEY,state TEXT,fence INTEGER,
        last_error_code TEXT,last_error_message TEXT,completed_at TEXT,updated_at TEXT,
        lease_owner TEXT,lease_expires_at TEXT);
      CREATE TABLE update_audit(request_id TEXT,from_state TEXT,to_state TEXT,fence INTEGER,
        code TEXT,details_json TEXT,occurred_at TEXT);
      CREATE TABLE controller_state(singleton INTEGER,active_request_id TEXT,updated_at TEXT);
      CREATE TABLE update_outbox(status TEXT,last_error TEXT,updated_at TEXT);
      INSERT INTO update_requests VALUES('old','activating',5,'old_error',NULL,NULL,NULL,'owner','later');
      INSERT INTO controller_state VALUES(1,'old',NULL);
      INSERT INTO update_outbox VALUES('pending',NULL,NULL);
      PRAGMA user_version=1;
    `);
    const schema=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    retireUpdates(db,'rollback-v1',targetSha);
    retireUpdates(db,'rollback-v1',targetSha);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schema);
    assert.equal(db.pragma('user_version',{simple:true}),1);
    const row=db.prepare('SELECT * FROM update_requests').get() as Record<string,unknown>;
    assert.equal(row.state,'needs_review');assert.equal(row.fence,6);assert.equal(row.lease_owner,null);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM update_audit').get() as {n:number}).n,1);
    assert.equal((db.prepare('SELECT active_request_id FROM controller_state').get() as {active_request_id:null}).active_request_id,null);
    assert.equal((db.prepare('SELECT status FROM update_outbox').get() as {status:string}).status,'needs_review');
  } finally {db.close();}
});
