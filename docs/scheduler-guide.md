# Scheduler 利用・release gateガイド

## 利用者向け操作

作成前に`preview_schedule`でtimezone、次回時刻、固定target、authorization expiryを確認する。確認した同じSlack event/threadから`create_schedule`を実行し、返された`revision`を以後の更新へ使う。`pause_schedule`は新規物化を止めるが既存runを取り消さない。`cancel_schedule`、`resume_schedule`はrevision競合時に現状を再取得し、blind retryしない。`get_schedule_history`では`scheduled`、`started`、`skipped`、`misfired`、`completed`、`failed`、`needs_review`を区別する。

対応actionはone-shot/recurringの`slack.reminder.post`とread-only workである。自由なprovider writeや別workspace targetは許可しない。Slackのtimeout等で受理が不明なrunは`needs_review`となり、自動再投稿されない。

## Security model

owner、workspace、target、authorization snapshotはsource eventからserver-sideでbindingする。schedule IDやrequest本文だけを権限証明にせず、実行直前にもcurrent access、expiry、revisionを再検証する。fixture、log、metric、CLI、test artifactへtoken、private URL、private destination、Slack本文全文を残さない。integration testはfake Slackとfake job runtimeだけを使い、production workspaceへ投稿しない。

## Release gate

Phase 0はADR/codec/DB migration、Phase 1はAPI/materializer/reminder、Phase 2はwork routing、Phase 3はrecurring policy、Phase 4はoperationsとintegration/chaos suiteである。各Phaseを進める前に該当test、migration、health、runbookを確認する。

release候補はroot `npm run verify`に加え、CIのscheduler contract testが4 vertical slice、restart/duplicate、timeout、transaction partial failure、ADR fixture全件を実行したことを確認する。test count gateの失敗やfixture ID欠落を成功扱いしない。clean DBとmigration済みDB、large time jump、multi-instance claim/fenceはDispatcher suiteの必須証拠である。

rollbackでは新規schedule作成を止め、pending/`needs_review`を保持したままserviceを停止する。SQLite Online Backupとintegrity/foreign-key検査を用い、WALの単純copyやschema downgradeを行わない。曖昧な外部writeを再送せず、operatorがrun/outbox/auditとprovider receiptを照合する。詳細は[運用runbook](operations/scheduler-runbook.md)を参照する。
