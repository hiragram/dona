# Scheduler ローカル運用runbook

`/health/live` はprocessの生存だけを示す。`/health/ready` はDB read/write、worker、scheduler loopに加え、期限切れauthorization、stale claim、retention遅延がないことを確認する。`/metrics/scheduler` と `dona-dispatcher scheduler health` は本文・target・tokenを含まない件数、lag、operation counterだけを返す。

## 診断

1. `health/live`、`health/ready`、`health/version`の順に確認する。
2. `scheduler health`でdue lag、outbox backlog、stale claim、`needs_review`、authorization expiry、retention overdueを確認する。
3. `scheduler outbox --status needs_review`でredacted metadataだけを確認する。曖昧なSlack writeは自動retryしない。
4. Macのsleep復帰後はclock/timezone DB更新を確認し、60秒を超えるlagを調査する。timezone/tzdb変更後はpreviewと再承認なしにresumeしない。

## 復旧とretention

- pause/cancel/resumeはversioned schedule APIを使う。cancel、resume、receipt reconcileは対象revisionと権限を再確認し、曖昧な結果をblind retryしない。
- retentionは先に`dona-dispatcher scheduler retention`でdry-runし、対象件数を記録する。適用は`--apply --force`の両方が必要で、active data、unresolved `needs_review`、high-watermark、必要なauditは保持される。
- SQLite backupはservice停止またはSQLite Online Backupで取得し、WAL fileの単純copyをbackupとしない。復元前に現DBを退避し、`PRAGMA integrity_check`とforeign key検査後にreadyを確認する。checkpointはbackup開始前に行い、失敗時は元DBを上書きしない。
- launchd restart後はprocess起動だけで成功とせず、ready、version、scheduler healthを再確認する。

## multi-instance readiness

各instanceは一意なowner tokenを持ち、claimは期限と単調増加fenceへ束縛される。stale ownerのfenceでmaterializeしてはならない。SQLite単体のlocal resident構成ではこの契約を検証するが、cloud HAや分散DBを提供するものではない。
