# SchedulerのSQLite保存契約

対象はIssue #7。ADR 0001とPR #81（`15ddcd6c9e13adf3a185e7f6157cb42cce1e630e`）の保存契約に基づく。recurrence計算・codecは#6、起動時／24時間ごとの呼出し・due scanは#9/#13、権限実照会・送信は#10/#12、job routingは#11が所有する。このPRはrepository primitiveを供給し、schedulerの実行を有効化しない。

## Migration versionと互換性

integration `feature/durable-scheduler@87c8e18c9a20ad6c2a88f2355e309cccc0d27e59` とmainのcore DBは`PRAGMA user_version = 2`。独立integration `feature/multi-job-fanout` がv3を使用しているため、schedulerでv3を再定義したりv3を飛ばしてv4と表示したりしない。

新schemaの識別子は **core v2 + scheduler v1**。`scheduler_schema(singleton=1, version=1)`を同じDBへ追加し、既存core migrationの直後にextension migrationを実行する。新規DBはcore v1→v2を既存コードで実行してからscheduler v1へ、既存v2 DBはそのデータと`user_version`を保持したままscheduler v1へ進む。extensionの全DDLとversion記録は1つの`BEGIN IMMEDIATE` transactionで、失敗時はextension全体をrollbackする。再openは同じschemaを再利用し、未知extension versionは拒否する。WAL、foreign_keys、busy_timeoutは既存Dispatcher connectionを共有する。

core v3 migrationをコピー／省略／置換しない。fan-out統合後はそのcore migrationを先に実行し、同じextension migrationを続ける。scheduler側の`job_id`は履歴参照で、`setRunState`が同じtransaction内でjobの存在とsource eventの一致を検証する。**jobsへのSQL FKやtriggerは設けない**。既存v2→v3はjobsをDROP/再構築するため、参照元FKやtriggerがあるとmigrationが失敗することを実DBで確認した。schedule/revision/run/event/outbox間にはFKを持ち、job本体の将来のretentionから履歴参照を独立させる。

`dispatcherSchemaCompatibility`やself-update policyを変更しない。このbranchのcore readerはv2までであり、v3化したDBをこの旧coreで開くと従来どおり拒否する。extension versionは既存updaterの互換性判定に含まれないため、**この文書とテストだけでscheduler有効化後の旧releaseへのlive rollbackを安全と判定してはならない**。release gateへのscheduler capability反映、停止・backup・旧readerの組合せ検証はschedulerを有効化する前のintegration/運用gateで行う。

## 保存する正本

- `schedules`: tenant/owner、state、concurrency revision、next_due、high-watermark、terminal時刻。
- `schedule_revisions`: immutableなrecurrence/policy canonical bytes・hash、timezone/tzdb、authorization IDと承認revision・本人・期限、固定action/target/content scope、本文hash。本文消去期限と本文の消去のみ変更できる。
- `schedule_runs`: schedule/revision参照、UTC occurrence key、時刻、statusと列挙したskip理由、event/job参照。`(schedule_id, scheduled_for)`と`(schedule_id, occurrence_key)`はrevisionを跨いで一意。
- `connector_outbox`: `slack.reminder.post` / `slack.work_result.post`のみ。固定target、本文hash、idempotency、attempt、claim token/lease、request-started fence、receipt、needs_review。
- `schedule_audit`: sequence順、actor/tenant/source event、操作、revision、allowlistで生成したredacted before/after、hash、policy/tzdb、時刻。呼出し側の自由なbefore/after JSON、本文、target、error messageを受け取らない。

pause/resume/cancelもrevisionを増加させ、並行更新をCASで拒否する。これらは既存承認を複製して参照するだけで期限・actionを変更しない。`authorization_revision`は元の承認revisionを保持する。内容更新はpause後（またはexpired/needs_reviewから）、別authorization ID・新revisionで本人が再承認した入力だけを受理する。所有者変更はAPIに存在しない。tenant/owner quotaは未終了stateを数えて作成transactionで確認する。

## #6 codecとの接続

保存層はcodecを複製しない。`database.scheduler`で既存データを読み取れるが、作成／内容更新には実codecの注入が必須。未接続では`domain_codecs_required`となる。

```ts
const repository = database.scheduler.withCodecs({
  recurrence: text => encodeRecurrence(decodeRecurrence(text)),
  policy: text => encodePolicy(decodePolicy(text)),
});
```

4関数は#6の`recurrence.ts` / `policy.ts`から取得する。#6のdomain validation・creation validation・previewを行った値を渡し、canonical bytesをそのまま保存する。未知version、重複key、policy変更の解釈は#6に従う。targetは#6と同じ`thread` / `channel` / `owner_dm`、workの通知なしは`none`。recurrence自体の計算、preview、作成日の検証はrepositoryへ複製しない。

PR #82のexact head `56eeec85d271813e33984fd2c5eae9753a607190`を一時checkoutで利用し、実codecの接続を確認した。依存PRをmerge/cherry-pickせず、このPRのcommitには#6の実装を含めない。両PRがintegrationへ入った後も同じportを使用できる。API/loop側の呼出し配線は後続Issueで行う。

## Transactionと外部write

create/状態更新/新revisionとaudit、run物化とevent/outbox・high-watermark・auditはそれぞれ同じconnectionのtransaction。workは本文を持たない`source: scheduler`の内部eventへrun/revision参照を保存し、reminderはtyped outboxを作る。source型の追加だけでは外部HTTP ingressを許可しない。既存Slack専用createJobをscheduler対応に変更せず、`setRunState`が後続#11から渡されるjob参照とrun transitionを検証する。work結果本文のoutbox追加とrun完了もatomicなprimitiveを供給する。

duplicate wakeは既存runを返し、event/outboxを増やさない。run削除後はhigh-watermarkにより過去occurrenceの再作成を拒否する。900秒境界・未決着run/outboxのoverlapは保存直前にも確認するが、直近候補の選択・calendar計算・長期停止のcompact skipは#9の責任。

claimは`BEGIN IMMEDIATE`で排他的に取得する。送信前のlease切れは新tokenで再claimでき、旧tokenは拒否する。`requestStarted`を外部requestより先にcommitする。timeout/切断は`finishWrite(..., 'ambiguous')`、crash後のrequest-started lease切れは`recover`でneeds_reviewを永続化し、scheduleを止める。回復しても再送状態へ戻さない。未受理の確証を呼出し側が得た場合だけ`not_accepted`を渡し、最大3 attempts、1秒/5秒・Retry-Afterの下限を保存する。

cancel/pauseは未開始run/outboxを抑止する。開始済みrequestは結果不明のまま消さず、sent receiptまたはneeds_reviewと取消時刻を両方保持する。`reconcile`は確認済みreceiptでsent/failedへ進めるだけで、再送やresumeをしない。Actorのroleと本人承認は外部authorityで検証済みの値を渡す内部APIであり、この層がSlack権限を照会するわけではない。run開始・各write直前のcurrent access照会、redaction完了の確認、queued eventの取消確認、running workへのcancel要求は#9〜#12の呼出し側が必要。

## Retentionとrollback不能点

`purge(now)`は明示的なtransaction primitive。置換／取消revisionとterminal/needs_review outbox本文は7日以内に消去し、authorization失効から7日が経過したrevision本文も消去する。outboxの読取りでも消去期限を過ぎた本文を返さない。未決着fenceは本文なしで保持する。terminal metadataは30日、auditは90日で消去し、runの削除とは独立してactive scheduleのhigh-watermarkを維持する。purgeの起動時／24時間ごとの呼出し、期限遅延healthは#13の配線が必要。

`redactedBackup()`は一貫したread transactionで本文・target・任意JSONを含まないmetadata/hash/fenceを出力する。SQLiteファイルをそのままコピーする方式はこのredacted backupではない。backupから本文を復元したりscheduleを自動再開するAPIは供給しない。

消去済み本文、送信済み外部write、失われた未決着fenceはrollback不能。旧policyへ戻す場合も旧recordの黙示resumeではなく、新revision・preview・本人再承認が必要。down migrationや`user_version`の巻戻しは提供しない。schedulerを利用済みのDBからtableを削除して旧releaseへ戻すことも禁止する。

## 実行した検証

- `npm --prefix dispatcher test`、`typecheck`、`build`: repository追加14件を含めて検証。
- `node --import ./dispatcher/node_modules/tsx/dist/loader.mjs dispatcher/test/scheduler-codec-integration.ts <#6 checkout>/dispatcher/src/scheduler`: 上記#82 headの実codecでcanonical bytes、未知version、重複key、policy改変、owner_dm、物化一意性を確認。
- `node --import ./dispatcher/node_modules/tsx/dist/loader.mjs dispatcher/test/scheduler-core-migration-integration.ts <fan-out checkout>/dispatcher/src/database.ts`: `feature/multi-job-fanout@e241fb41087a9b4a6aa5329cf1aaf60148e4c0d0`の実migrationでv2+scheduler→v3、3つの中間phaseでのrollback、v3新規→scheduler、旧v2 readerの拒否を確認。
- repository testsは新規/v2/reopen/WAL/FK、DDL失敗、重複wake、revision競合、invalid transition、tenant境界、transaction失敗、2 connection claim、lease expiry、needs_review永続化、cancel race、retention、audit redaction/order、必要indexのquery planを検証する。

Slack HTTP、実権限照会、Herdr実行、scheduler loop、production DB、self-update、deploymentの成功は主張しない。
