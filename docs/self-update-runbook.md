# Self-update運用runbook

## 導入前確認

1. macOS GUI userで、`node`、`npm`、`git`、`gh`、`herdr`がabsolute pathへ解決できることを確認します。
2. GitHub Actionsの3 checkがmain commitで成功していること、`gh auth status`が成功することを確認します。
3. `sources/slack/.env`の既存設定を確認します。tokenはKeychainに残し、env fileへ書きません。
4. templateだけを検証します。これはproduction pathやlaunchctlを変更しません。

```sh
./scripts/install-self-update.sh --check
```

## 初回installとlegacy移行

cleanなcanonical main checkoutで明示的に実行します。installerはfetch後の`origin/main`とのSHA一致と、GitHub Actions由来の固定3 check成功を再検証します。

```sh
./scripts/install-self-update.sh --install
```

この段階ではimmutable initial release、stable updater copy、0600 policy/token/config/plistだけを配置し、processやlaunchctlは変更しません。既存`install-launchd.sh`はdeveloper checkoutを直接起動するlegacy方式です。新構成へ切り替えるmaintenance windowで、内容を確認してから次を別途実行します。

```sh
./scripts/install-self-update.sh --bootstrap
```

`--bootstrap`だけが、既存Slack Adapter→Dispatcherの順にbootoutし、stable updater→Dispatcher→Slack Adapterの順にbootstrapします。commandの結果が曖昧なら反復せず、`launchctl print gui/$UID/<label>`とhealthを確認します。実行中stable updaterはinstallerもbootoutしません。

## 通常update

1. Donaは`plan_self_update(source_event_id)`を呼びます。
2. 利用者はcurrent/target exact SHA、plan hash、policy、CI、互換性、rollback可否を確認します。
3. 明示承認後だけ、Donaは`apply_self_update(source_event_id, plan_id, plan_hash, approval_id)`を呼びます。
4. acceptedは「approval受付eventとexact planをDBへcommitした」意味です。その受付Event Resultが`completed`になるまでactivationは始まりません。
5. `get_self_update_status`でstate/health/outboxを確認します。terminal通知は元Slack threadへ別eventとして戻ります。

Codex hostのwrite approvalは、停止時間・target・migrationを理解したbusiness approvalの代替ではありません。

## Reconcile

crash、sleep/reboot、launchctl/HTTP response喪失後は同じcommandを繰り返しません。

```sh
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" status upd_...
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" reconcile upd_...
```

reconcileはpointer、receipt、DB fence/checkpoint、両serviceのversioned healthを読みます。観測がtarget successかprevious rollbackを一意に証明できない場合は`needs_review`のままです。

## Emergency rollback

automatic rollbackはwrong target SHAというcandidate regressionを確認でき、previous互換で、1回のcircuit内だけです。Slack network outage、partial workspace ready、irreversible schema/config、unknown healthでは行いません。

`needs_review`後にoperator rollbackする場合、statusでcurrent=target、previous=planned current、互換性を確認し、exact plan hashを指定します。

```sh
node "$HOME/Library/Application Support/Dona/update-control/updater/dist/cli.js" \
  rollback upd_... --confirm-plan-hash <64-hex-plan-hash>
```

previous Dispatcherと全Slack workspaceのprevious SHA healthまで確認できた場合だけ`rolled_back`です。pointerだけ戻った状態を成功扱いしません。

## Circuit open / manual recovery

- `*_acceptance_unknown`: 同じlaunchctl/POSTを再実行せず、PID、`launchctl print`、pointer、receipt、health、external event lookupを確認します。
- `pointer_observation_mismatch`: current/previousを手で書き換えず、symlinkの実体、owner、mode、release manifestを確認します。
- `staged_compatibility_metadata_differs_from_approved_plan`: new SHAで再planします。既存planを流用しません。
- `retention_cleanup_failed`: current、previous、active attemptを削除しません。`doctor`のdry-run候補を確認します。
- outbox `needs_review`: update自体は維持します。元threadの通知有無を人間が確認します。

## Backupとschema

初期版はapp DB schema v2を変更しません。将来migrationする場合はN-1/N双方のread rangeを先に広げるexpand/contract release、quiesce後のSQLite Online Backup、restore open/integrity testを別途必須にします。WAL稼働中の`.sqlite3`単体copyは禁止です。irreversible migrationやsecret format変更はrollback不可としてactivation前に拒否します。

## Retention

current、previous、active attemptを常に保護し、それ以外の直近2 successful releaseも残します。disk floor 2 GiB未満ではstageを開始しません。`doctor`はcleanup候補をdry-run表示し、success後cleanupはSHA形式・realpath containment・owner/modeを再検証したreleaseだけを対象にします。
