// 全writer停止・backup後だけ、独立CLIが呼ぶ。旧requestを再実行しない。
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function retireUpdates(db, runId, targetSha, at = new Date().toISOString()) {
  db.transaction(() => {
    const rows = db.prepare("SELECT request_id,state,fence,last_error_code FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','cancelled')").all();
    for (const row of rows) {
      // 再開は同じjournalに束縛する。以前の失敗理由はappend-only auditへ保持。
      if (row.last_error_code === 'offline_update_superseded') continue;
      db.prepare(`UPDATE update_requests SET state='needs_review', completed_at=?, updated_at=?,
        lease_owner=NULL, lease_expires_at=NULL, fence=fence+1, reconcile_after=NULL, reconcile_deadline=NULL,
        last_error_code='offline_update_superseded', last_error_message='独立CLIの停止更新により旧更新の自動再開を停止しました'
        WHERE request_id=?`).run(at, at, row.request_id);
      db.prepare(`INSERT INTO update_audit(request_id,from_state,to_state,fence,code,details_json,occurred_at)
        VALUES (?,?,'needs_review',?,'offline_update_superseded',?,?)`).run(row.request_id, row.state, row.fence+1,
          JSON.stringify({run_id:runId,target_sha:targetSha,previous_error_code:row.last_error_code}),at);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='updater_writer_lease'").get()) {
      db.prepare('DELETE FROM updater_writer_lease').run();
    }
    db.prepare('UPDATE controller_state SET active_request_id=NULL,updated_at=? WHERE singleton=1').run(at);
    // 古いactivationの通知を新しい更新成功として配信しない。既配信の履歴は保持。
    db.prepare(`UPDATE update_outbox SET status='needs_review',last_error='offline_update_superseded',updated_at=?
      WHERE status IN ('pending','delivering')`).run(at);
  })();
}

export async function migrate(request) {
  if (!request.retire_only) {
    const load = (component, module) => import(pathToFileURL(path.join(request.release, component, 'dist', module+'.js')));
    const classes = [await load('dispatcher','database'), await load('dispatcher','update-notification'),
      await load('dispatcher','job-progress'), await load('updater','database')];
    const constructors = [classes[0].DispatcherDatabase, classes[1].UpdateNotificationDatabase, classes[2].JobProgressStore, classes[3].UpdateDatabase];
    for (let index=0; index<constructors.length; index++) new constructors[index](request.databases[index]).close();
  }
  const {default:Database} = await import(pathToFileURL(path.join(request.release,'updater/node_modules/better-sqlite3/lib/index.js')));
  const db = new Database(request.databases[3]);
  try { retireUpdates(db,request.run_id,request.target_sha); } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await migrate(JSON.parse(fs.readFileSync(0,'utf8'))); }
  catch { console.error('offline_state_migration_failed'); process.exitCode=1; }
}
