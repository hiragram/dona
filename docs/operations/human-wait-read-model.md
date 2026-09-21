# owner-wide human wait read model 運用契約

この文書はIssue #244で追加した内部read modelの永続化、復旧、retention境界を定める。外部API/MCPの認可・pagination・projectionは#245、Slackでのintent routingと表示は#246が所有する。このread modelを直接外部へ返してはならない。

## 正本と同期境界

`human_wait_items`はjob、job group、schedule run、notificationの既存正本から導出する。各正本のstatus更新と同じSQLite transactionでtriggerがopen、reopen、resolved、staleを反映する。独立した権限正本ではない。上位queryは毎回verified principal、current grant、current access、resource revisionを再評価する。

対象は次に限定する。

- jobの`blocked`と`needs_review`
- job groupの最初の`attention`から`all_terminal`まで
- schedule runとnotification/outboxの`needs_review`
- 上記のopen causeに結び付く、Slack Adapterが確認した`suspended` session settlement

単なる`running`、一般的なfailure、receiptのないAgent Session statusは追加しない。session settlementは別itemを増やさず、同じ根因のitemへ`session_settlement_verified=1`を記録する。

## owner、reason、origin

通常jobは`job_authorization_bindings`の`human_verified`だけをverified ownerとして使う。scheduleは永続`tenant_id` / `owner_id` / run revisionを使う。legacy actor、job/thread/channel ID、通知先、自由文からownerを推測しない。証拠がないrowは`owner_kind=unknown`、principal NULLのまま保持し、owner queryの候補にしない。

reasonとdecisionはallowlistへ縮退する。`last_error_message`、objective、Result、message本文、private destination、raw URLは複写しない。外部導線用にはランダムな`origin_ref`だけを保持し、#245の`resolve_origin_ref`でcurrent accessを再認可する。item IDもランダムであり、resource IDの所持を認可証拠にしない。

group `attention`をopenしたtransactionでは、同じsource eventの個別job waitをresolvedにする。notificationとwork resultの判断が独立している場合だけ別itemを保つ。schedule revisionが差し替わった旧run/notificationはstaleにする。

## repairと競合

`HumanWaitRepository.repair`は1回1〜500 job、opaqueなjob ID cursor、callerが固定したUTC `snapshotRevision`で実行する。最初に`dryRun=true`で`scanned`、`repaired`、`quarantined`、`next_cursor`、digestだけを確認する。報告へresource本文やID一覧を出さない。

write対象の正本rowは`source_revision <= snapshotRevision`で絞り、UPDATE時に同じ条件を再確認する。triggerはrepairが読んだ古い値を渡さず、その時点の正本stateを再投影するため、snapshotより新しいlive transitionを古いsnapshotで上書きしない。wall clock逆行時もtimestampの大小だけでlive transitionを拒否しない。同じbatchの応答を失った場合はblind retryせず、cursor、snapshot、digestと現在rowをread-backしてから再開する。corrupt/未知projectionはownerへ昇格せずquarantineする。

schema追加は既存core migration transactionの後にexpand-onlyで行う。core v2→v3 rebuild時はread-model triggerを一時dropし、成功後に再作成する。migration failureはSQLite transactionと既存migration testで旧schemaへrollbackする。既存rowのbackfillはstartupで無制限走査せず、上記bounded repairで行う。

## audit、retention、purge

`human_wait_audit`へ保存するのはitem ID、reason class、source revision、transition、actor class、timestampだけである。objective、Result、error本文、secret、destinationは保存しない。

通常itemはopen中にpurgeしない。resolved/stale itemは既定30日、schedule notificationは既存`content_delete_at`まで保持する。`purge(before, limit)`は1〜500件のbounded batchで、削除前にredactedな`purged` auditを残す。法務・監査holdが必要な環境ではpurgeを呼ばず、hold解除後に明示実行する。read model自体にhold権限やproduction activationはない。

## 検証境界

fake/isolated SQLite testで、verified ownerとlegacy unknown、reason redaction、dedupe、group集約、schedule run/notification、session settlement、restart、migration repair、snapshot fence、retention APIを検証する。live Slack session、production migration、実credential、provider writeはこのIssueでは未検証である。
