# 旧Dispatcherからoperator回復CLIへ到達するための停止下bootstrap

## 適用境界

旧Dispatcherが`job recover-operator-assertion`を持たず、`needs_review` jobを`update-safety`の危険状態に数える場合、通常self-updateと`--upgrade-control`はいずれも先へ進めない。後者も旧Dispatcherの`drain-status`が`unsafe_states`空を要求するためである。この手順は同一schema v3のreleaseへ停止下で切り替え、既存の回復CLIを使えるようにする。自動の安全判定を偽装せず、operatorによる停止申告とjob単位の副作用・通知確認を監査記録に残す。

この文書は操作の承認ではない。service停止、pointer、DB、Result、Updater、Herdrの変更は明示承認されたmaintenance windowでのみ実行する。停止済みという人間の申告はoperator判断として扱い、機械的な全worker停止receiptへ変換しない。申告後に生成されたjobは別途判定する。

## 事前固定

1. `runtime/current/release-manifest.json`のSHA、`runtime/previous`、stable Updaterの`/health/version`、`updater.sqlite3`のnonterminal requestを再読する。対象はCIが成功した最新のcanonical `main` exact SHAとする。schema v3→v3、protocol/configの互換性とrollback可能性をrelease manifestで確認する。
2. `awaiting_approval`を含む既存planは、対象`request_id`と元のreply targetを確認し、依頼者がこのmaintenanceで取消を承認した場合だけ`cancel_self_update`で取消す。`status`とcontrol DBを再読し、全requestがterminalであることを確認する。曖昧な返答では再送しない。
3. 既存の`running`、`dispatching`、`preparing`、`blocked`、steer受理不明を列挙する。現在実行中のjobはこの手順自身も含めterminalになるまで待つ。申告より後のworkerを過去の停止申告で覆わない。
4. 一つの保存済みSlack eventが各対象jobのowner actor、workspace、channelに一致し、各`updated_at`以後に、対象workerの手動停止判断と残余リスクの受容を明示していることを確認する。自由文中のIDだけで対象を広げない。各jobのResult、外部副作用、既存通知・group状態を個別に確認し、その証跡のSHA-256を用意する。適合しないjobは回復しない。

## releaseの準備

非rootのmacOS GUI userで、cleanなcanonical `main` checkoutから実行する。`--stage-recovery`は既存installerと同じexact `origin/main`、GitHub Actionsの3 check、`npm ci`/test/typecheck/build、manifest、既存releaseとの内容比較を使い、immutable releaseを配置して終了する。Updater、pointer、service、DB、Resultは変更しない。

```sh
./scripts/install-self-update.sh --stage-recovery
```

実行直後に`runtime/releases/<target-sha>/release-manifest.json`のSHAと互換性、`dispatcher/dist/cli.js`、`sources/slack/dist/index.js`を再読する。stageだけではbootstrap成功としない。

## 停止、backup、単発CLI

操作前にSlack ingressを止め、次にDispatcherを止める。`launchctl bootout gui/$UID/dev.dona.slack-adapter`と`launchctl bootout gui/$UID/dev.dona.dispatcher`の応答だけを停止証明にせず、両labelがunregistered、両socketがunused、該当PIDが消失したことを再読する。stable Updaterはこの段階で止めない。Codex/Herdr worker停止は別のoperator判断であり、この観測から推論しない。

停止後にowner-only directoryへSQLite Online Backup APIで`dona.sqlite3`を保存する。WAL中のDB本体だけを`cp`しない。`job-results`とlegacy `results`、current/previous pointerの実体、両LaunchAgent plist、現行release manifest、control-plane receiptを同じ世代のbackup inventoryへ記録する。backupは0600、directoryは0700とし、DBの`integrity_check=ok`、`foreign_key_check`が空、`user_version=3`、主要table件数を照合する。backup pathとdigestを記録してから先へ進む。backup/Resultを公開場所へ置かない。

次はoperatorが固定した値を代入した後に実行するコマンドの形である。`backup_dir`は新規のowner-only directoryとし、既存backupを上書きしない。

```sh
dona_base="$HOME/Library/Application Support/Dona"
launchctl bootout "gui/$UID/dev.dona.slack-adapter"
launchctl bootout "gui/$UID/dev.dona.dispatcher"
launchctl print "gui/$UID/dev.dona.slack-adapter" # 未登録であることを確認
launchctl print "gui/$UID/dev.dona.dispatcher"   # 未登録であることを確認
node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_base/run/dispatcher.sock"
node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_base/run/slack-adapter.sock"
python3 - "$dona_base/dona.sqlite3" "$backup_dir/dona.sqlite3" <<'PY'
import os, sqlite3, sys
source = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close(); source.close()
os.chmod(sys.argv[2], 0o600)
check = sqlite3.connect('file:' + sys.argv[2] + '?mode=ro', uri=True)
assert check.execute('pragma integrity_check').fetchone()[0] == 'ok'
assert check.execute('pragma foreign_key_check').fetchone() is None
assert check.execute('pragma user_version').fetchone()[0] == 3
check.close()
PY
ditto "$dona_base/job-results" "$backup_dir/job-results"
ditto "$dona_base/results" "$backup_dir/results"
```

`bootout`が非0やtimeoutでもblind retryしない。`launchctl print`、socket、PIDを照合し、停止が一意に確認できなければDB writeへ進まない。上記の`print`は未登録時に非0となることが期待値である。

対象releaseのCLIを、`DOTENV_CONFIG_PATH`で既存Dispatcher設定、`DONA_RELEASE_MANIFEST_PATH`で**対象release自身のmanifest**へ固定して実行する。`DispatcherDatabase`のconstructorはschema/補助tableのmigrationを行うため、`inspect`もproduction DBへのwriteとして扱い、停止とbackupより前に実行しない。まずDBコピーで全対象の`inspect-operator-recovery`をdry runし、live DBでは各jobをwrite直前に再読する。

```sh
env DOTENV_CONFIG_PATH="$HOME/Library/Application Support/Dona/config/dispatcher.env" \
  DONA_RELEASE_MANIFEST_PATH="$HOME/Library/Application Support/Dona/runtime/releases/<target-sha>/release-manifest.json" \
  node "$HOME/Library/Application Support/Dona/runtime/releases/<target-sha>/dispatcher/dist/cli.js" \
  job inspect-operator-recovery <job_id>
```

`recover-operator-assertion`には、直前の`inspect`から得た`updated_at`、`cause`、`result_class`、`result_sha256`または`missing`、`notification_evidence_sha256`と、別途レビューした副作用証跡SHA-256、保存済み申告event IDを渡す。CLIのflagは[旧job回復手順](legacy-job-recovery-gate.md)のexact順序に従う。1件ごとに`job show`、`operator-recovery-record`、Resultと通知状態を再読する。応答喪失時はこれらを照合し、blind retryしない。無効・欠落Resultは成功に変換されず`failed`となる。全件を機械的に一括承認しない。

## runtime bootstrapとrollback

回復後、全対象のterminal statusと監査記録を確認する。残る危険状態の原因が一意に説明できなければ停止を維持する。`runtime/current`を対象releaseへの同一filesystem上の一時symlinkからrenameで切り替える。`runtime/previous`は旧SHAのまま保持する。Dispatcherだけを`launchctl bootstrap`し、versioned healthと`/v1/admin/update-safety`が対象SHA・`safe: true`・`unsafe_states: []`を示すまでSlack Adapterを起動しない。安全判定がclearでなければ停止下の個別確認へ戻る。Slack起動後に両serviceのhealth、DB schema 3、socket/PIDの新世代、通知重複なしを再読する。`dona-main`のcwd/sessionが旧releaseなら**完全なruntime更新とは報告しない**。この手順はHerdr agentの再作成権限を含まない。

```sh
runtime_root="$HOME/Library/Application Support/Dona/runtime"
target_sha='<承認済みのexact SHA>'
test "$(readlink "$runtime_root/current")" = "releases/<事前記録した旧SHA>"
test -f "$runtime_root/releases/$target_sha/release-manifest.json"
ln -s "releases/$target_sha" "$runtime_root/.current.recovery.tmp"
mv -f "$runtime_root/.current.recovery.tmp" "$runtime_root/current"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/dev.dona.dispatcher.plist"
node scripts/self-update-install-preflight.mjs wait-dispatcher-sha "$HOME/Library/Application Support/Dona/run/dispatcher.sock" "$target_sha" 30000
curl --fail --silent --show-error --unix-socket "$HOME/Library/Application Support/Dona/run/dispatcher.sock" \
  http://localhost/v1/admin/update-safety | jq -e '.safe == true and .unsafe_states == []'
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/dev.dona.slack-adapter.plist"
```

`bootstrap`応答が曖昧なら再送せず、登録状態とversioned healthを照合する。対象releaseの読み取り・CLI準備が失敗した場合に古いpointerのままserviceを戻す手順と、pointer切替後のrollback手順を同じmaintenance記録に残す。

新Dispatcherがhealthを満たさない場合はSlack/Dispatcherを停止し、両labelとsocketの停止を確認してから旧pointerへ戻す。DBを旧releaseが開けることをDBコピーとschemaで確認する。回復CLIがDBへ書いた後のbackup restoreは監査記録と通知状態を巻き戻すため、機械的には行わない。restoreが必要なら全service停止下でbackup integrity、失われる回復・通知・job変更を個別照合し、別のoperator判断を得る。pointer rollbackとDB restoreを同一操作と見なさない。

対象releaseでDispatcherが起動し、危険状態が空になった後だけ、terminalでない更新planがないことを再確認して`--upgrade-control`を使う。これはstable Updater/policyを更新する別操作で、installer内のbackupとrollback・exact SHA healthを確認する。新しい通常self-update plan/applyはさらに別のexact plan承認を要する。対象SHAへpointerを先に切り替えた場合、同じSHAへのplan/applyで`dona-main`が再起動すると推測しない。main agentのrelease identityを揃える手段は別に確認する。
