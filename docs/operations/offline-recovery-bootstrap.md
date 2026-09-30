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
dona_base="$HOME/.dona/g/<事前確認した世代ID>" # 既定installなら "$HOME/Library/Application Support/Dona"
if [[ "$dona_base" == "$HOME/Library/Application Support/Dona" ]]; then
  ./scripts/install-self-update.sh --stage-recovery
else
  ./scripts/install-self-update.sh --stage-recovery "$dona_base"
fi
```

実行直後に`runtime/releases/<target-sha>/release-manifest.json`のSHAと互換性、`dispatcher/dist/cli.js`、`sources/slack/dist/index.js`を再読する。stageだけではbootstrap成功としない。

## 停止、backup、単発CLI

操作前にSlack ingressを止め、次にDispatcherを止める。両者のlabel、socket、PID停止を再読してから、Updaterの全requestがterminalであることを再確認し、stable Updaterも止める。Updater停止の応答だけを証明にせず、label、socket、PIDを再読する。これでbackup・回復CLI・手動pointer操作中にUpdater activationが並走しない。Codex/Herdr worker停止は別のoperator判断であり、この観測から推論しない。

停止後にowner-only directoryへSQLite Online Backup APIでDispatcher本体・通知・進捗DBとUpdater DBを保存する。WAL中のDB本体だけを`cp`しない。`job-results`とlegacy `results`、current/previous pointerの実体、3つのLaunchAgent plist、実際の両env file、現行release manifest、存在する場合はcontrol-plane receiptを同じ世代のbackup inventoryへ記録する。backupは0600、directoryは0700とし、全DBの`integrity_check=ok`と`foreign_key_check`空、各`user_version`、主要table件数を照合する。backup pathとdigestを記録してから先へ進む。backup/Resultを公開場所へ置かない。

次はoperatorが固定した値を代入し、同じmaintenance shellで続けて実行するコマンドの形である。`backup_dir`は毎回新規のowner-only directoryとし、既存backupを上書きしない。

```sh
set -euo pipefail
dona_base="$HOME/.dona/g/<事前確認した世代ID>" # 既定installなら "$HOME/Library/Application Support/Dona"
test -d "$dona_base" && test ! -L "$dona_base"
if [[ "$dona_base" == "$HOME/Library/Application Support/Dona" ]]; then
  control_root="$dona_base/update-control"
  expected_dispatcher_socket="$dona_base/run/dispatcher.sock"
  expected_slack_socket="$dona_base/run/slack-adapter.sock"
else
  control_root="$dona_base/control"
  expected_dispatcher_socket="$dona_base/run/d.sock"
  expected_slack_socket="$dona_base/run/s.sock"
fi
command -v python3 >/dev/null
python3 -c 'import sqlite3'
command -v ditto >/dev/null
command -v curl >/dev/null
target_release="$dona_base/runtime/releases/<承認済みのexact SHA>"
dispatcher_env="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:DOTENV_CONFIG_PATH' \
  "$HOME/Library/LaunchAgents/dev.dona.dispatcher.plist")"
slack_env="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:DOTENV_CONFIG_PATH' \
  "$HOME/Library/LaunchAgents/dev.dona.slack-adapter.plist")"
test -f "$dispatcher_env" && test -f "$slack_env"
resolved_paths="$(node - "$target_release" "$dispatcher_env" "$slack_env" "$dona_base" <<'JS'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const release = process.argv[2];
const environmentFile = process.argv[3];
const slackEnvironmentFile = process.argv[4];
const base = process.argv[5];
const generation = base !== path.join(os.homedir(), "Library/Application Support/Dona");
const dotenv = require(path.join(release, 'dispatcher/node_modules/dotenv'));
const environment = {...dotenv.parse(fs.readFileSync(environmentFile))};
const slackEnvironment = {...dotenv.parse(fs.readFileSync(slackEnvironmentFile))};
for(const name of ['DONA_DATABASE_PATH','DONA_RESULTS_DIR','DONA_JOB_RESULTS_DIR',
  'DONA_UPDATE_NOTIFICATION_DATABASE_PATH','DONA_JOB_PROGRESS_DATABASE_PATH',
  'DONA_SOCKET_PATH','SLACK_HEALTH_SOCKET_PATH']) {
  const value=environment[name];
  if(value && !path.isAbsolute(value) && !value.startsWith('~/')) {
    throw new Error(`${name} must be absolute for offline recovery`);
  }
}
for(const name of ['DONA_SOCKET_PATH','SLACK_HEALTH_SOCKET_PATH']) {
  const value=slackEnvironment[name];
  if(value && !path.isAbsolute(value) && !value.startsWith('~/')) {
    throw new Error(`${name} must be absolute for offline recovery`);
  }
}
const expand=value => value?.startsWith('~/') ? path.join(os.homedir(),value.slice(2)) :
  value ? path.resolve(value) : undefined;
environment.DONA_RELEASE_MANIFEST_PATH = path.join(release, 'release-manifest.json');
import(pathToFileURL(path.join(release, 'dispatcher/dist/config.js')).href).then(({loadConfig}) => {
  const config = loadConfig(environment);
  const slackDispatcherSocket=expand(slackEnvironment.DONA_SOCKET_PATH) ??
    path.join(base,'run',generation ? 'd.sock' : 'dispatcher.sock');
  if(slackDispatcherSocket!==config.socketPath) throw new Error('dispatcher_socket_config_mismatch');
  const slackSocket=expand(slackEnvironment.SLACK_HEALTH_SOCKET_PATH) ??
    path.join(base,'run',generation ? 's.sock' : 'slack-adapter.sock');
  if(slackSocket!==config.slackAdapterSocketPath) throw new Error('slack_socket_config_mismatch');
  process.stdout.write(JSON.stringify({database:config.databasePath,
    results:config.resultsDir,job_results:config.jobResultsDir,
    update_notifications:config.updateNotificationDatabasePath,
    job_progress:config.jobProgressDatabasePath,
    dispatcher_socket:config.socketPath,slack_socket:slackSocket}));
}).catch(error => { process.stderr.write(String(error)); process.exitCode=1; });
JS
)"
dona_database="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).database))')"
dona_results="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).results))')"
dona_job_results="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).job_results))')"
dona_update_notifications="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).update_notifications))')"
dona_job_progress="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).job_progress))')"
dona_dispatcher_socket="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).dispatcher_socket))')"
dona_slack_socket="$(printf '%s' "$resolved_paths" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).slack_socket))')"
test -f "$dona_database" && test -f "$dona_update_notifications" &&
  test -f "$dona_job_progress" && test -d "$dona_results" && test -d "$dona_job_results"
updater_socket="$control_root/updater.sock"
old_updater_health="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
  --unix-socket "$updater_socket" http://localhost/health/version)"
old_updater_sha="$(printf '%s' "$old_updater_health" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);if(v.service!=="updater"||v.status!=="ready"||!(/^[0-9a-f]{40}$/.test(v.build_sha)))process.exitCode=1;else process.stdout.write(v.build_sha)})')"
mkdir -p -m 700 "$dona_base/recovery-backups"
backup_dir="$(mktemp -d "$dona_base/recovery-backups/attempt.XXXXXX")"
dispatcher_pid="$(launchctl list | awk '$3=="dev.dona.dispatcher" {print $1}')"
slack_pid="$(launchctl list | awk '$3=="dev.dona.slack-adapter" {print $1}')"
case "$dispatcher_pid:$slack_pid" in
  *[!0-9:]*|:*|*:) printf '%s\n' '停止前のDona PIDを確定できません。' >&2; exit 1 ;;
esac
slack_bootout_exit=0
launchctl bootout "gui/$UID/dev.dona.slack-adapter" || slack_bootout_exit=$?
dispatcher_bootout_exit=0
launchctl bootout "gui/$UID/dev.dona.dispatcher" || dispatcher_bootout_exit=$?
if launchctl print "gui/$UID/dev.dona.slack-adapter" >/dev/null 2>&1 ||
   launchctl print "gui/$UID/dev.dona.dispatcher" >/dev/null 2>&1; then
  printf '%s\n' 'Dona serviceの登録が残っています。DB操作へ進みません。' >&2
  exit 1
fi
if ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_dispatcher_socket" ||
   ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_slack_socket"; then
  printf '%s\n' 'Dona socketが使用中です。DB操作へ進みません。' >&2
  exit 1
fi
if [ "$slack_bootout_exit" -ne 0 ] || [ "$dispatcher_bootout_exit" -ne 0 ]; then
  printf 'bootout非0を停止状態で照合済み: Slack=%s Dispatcher=%s\n' \
    "$slack_bootout_exit" "$dispatcher_bootout_exit" >&2
fi
if kill -0 "$dispatcher_pid" 2>/dev/null || kill -0 "$slack_pid" 2>/dev/null; then
  printf '%s\n' '停止前のDona PIDが残っています。DB操作へ進みません。' >&2
  exit 1
fi
updater_status="$(DONA_UPDATE_POLICY_PATH="$control_root/policy.json" node "$control_root/updater/dist/cli.js" status)"
if ! printf '%s' "$updater_status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);if(v.nonterminal_count!==0||!Array.isArray(v.updates)||v.updates.some(x=>!["succeeded","failed","rolled_back","needs_review","cancelled"].includes(x.state)))process.exitCode=1})'; then
  printf '%s\n' 'Updaterに非terminal requestが残っています。DB操作へ進みません。' >&2
  exit 1
fi
updater_pid="$(launchctl list | awk '$3=="dev.dona.updater" {print $1}')"
case "$updater_pid" in
  ''|*[!0-9]*) printf '%s\n' '停止前のUpdater PIDを確定できません。' >&2; exit 1 ;;
esac
updater_bootout_exit=0
launchctl bootout "gui/$UID/dev.dona.updater" || updater_bootout_exit=$?
if launchctl print "gui/$UID/dev.dona.updater" >/dev/null 2>&1 ||
   ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$updater_socket" ||
   kill -0 "$updater_pid" 2>/dev/null; then
  printf '%s\n' 'Updaterの停止を確認できません。DB操作へ進みません。' >&2
  exit 1
fi
if [ "$updater_bootout_exit" -ne 0 ]; then
  printf 'Updater bootout非0を停止状態で照合済み: %s\n' "$updater_bootout_exit" >&2
fi
python3 - "$control_root/updater.sqlite3" <<'PY'
import sqlite3, sys
db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
count = db.execute("SELECT COUNT(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled')").fetchone()[0]
db.close()
if count != 0:
    raise RuntimeError('updater_nonterminal_request_after_stop')
PY
python3 - "$dona_database" "$backup_dir/dona.sqlite3" \
  "$control_root/updater.sqlite3" "$backup_dir/updater.sqlite3" \
  "$dona_update_notifications" "$backup_dir/update-notifications.sqlite3" \
  "$dona_job_progress" "$backup_dir/job-progress.sqlite3" <<'PY'
import os, sqlite3, sys
for source_path, target_path, expected_schema in ((sys.argv[1],sys.argv[2],3),(sys.argv[3],sys.argv[4],7),
                                                  (sys.argv[5],sys.argv[6],2),(sys.argv[7],sys.argv[8],2)):
    descriptor = os.open(target_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    os.close(descriptor)
    source = sqlite3.connect('file:' + source_path + '?mode=ro', uri=True)
    target = sqlite3.connect(target_path)
    source.backup(target)
    target.close(); source.close()
    os.chmod(target_path, 0o600)
    check = sqlite3.connect('file:' + target_path + '?mode=ro', uri=True)
    if check.execute('pragma integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('backup_integrity_check_failed')
    if check.execute('pragma foreign_key_check').fetchone() is not None:
        raise RuntimeError('backup_foreign_key_check_failed')
    if check.execute('pragma user_version').fetchone()[0] != expected_schema:
        raise RuntimeError('backup_schema_mismatch')
    check.close()
PY
ditto "$dona_job_results" "$backup_dir/job-results"
ditto "$dona_results" "$backup_dir/results"
python3 - "$dona_base" "$control_root" "$backup_dir" "$dona_database" "$dona_results" "$dona_job_results" \
  "$dispatcher_env" "$slack_env" "$dona_update_notifications" "$dona_job_progress" <<'PY'
import datetime, hashlib, json, os, re, shutil, sqlite3, stat, sys
base, control, root, database, results, job_results, dispatcher_env, slack_env, update_notifications, job_progress = sys.argv[1:]
runtime = os.path.join(base, 'runtime')
pointers = {}
for name in ('current', 'previous'):
    target = os.readlink(os.path.join(runtime, name))
    if not re.fullmatch(r'releases/[0-9a-f]{40}', target):
        raise RuntimeError('runtime_pointer_invalid')
    pointers[name] = target
sources = {
    'dispatcher.plist': os.path.join(os.path.expanduser('~'), 'Library/LaunchAgents/dev.dona.dispatcher.plist'),
    'slack-adapter.plist': os.path.join(os.path.expanduser('~'), 'Library/LaunchAgents/dev.dona.slack-adapter.plist'),
    'updater.plist': os.path.join(os.path.expanduser('~'), 'Library/LaunchAgents/dev.dona.updater.plist'),
    'release-manifest.json': os.path.join(runtime, 'current/release-manifest.json'),
    'policy.json': os.path.join(control, 'policy.json'),
    'dispatcher.env': dispatcher_env,
    'slack.env': slack_env,
}
receipt = os.path.join(control, 'control-plane-receipt.json')
if os.path.lexists(receipt):
    sources['control-plane-receipt.json'] = receipt
for name, source in sources.items():
    if not stat.S_ISREG(os.stat(source).st_mode) or os.path.islink(source):
        raise RuntimeError('backup_source_not_regular:' + name)
    destination = os.path.join(root, name)
    with open(source, 'rb') as read, open(destination, 'xb') as write:
        shutil.copyfileobj(read, write)
        write.flush(); os.fsync(write.fileno())
    os.chmod(destination, 0o600)
counts = {}
for name, tables, source_path in (('dona.sqlite3', ('jobs','events','job_groups'), database),
                                  ('updater.sqlite3', ('update_requests','update_outbox'), os.path.join(control, 'updater.sqlite3')),
                                  ('update-notifications.sqlite3', ('update_notifications',), update_notifications),
                                  ('job-progress.sqlite3', ('job_progress','job_progress_throttles'), job_progress)):
    db = sqlite3.connect('file:' + os.path.join(root, name) + '?mode=ro', uri=True)
    counts[name] = {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in tables}
    db.close()
    source_db = sqlite3.connect('file:' + source_path + '?mode=ro', uri=True)
    source_counts = {table: source_db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in tables}
    source_db.close()
    if source_counts != counts[name]: raise RuntimeError('backup_table_count_mismatch')
digests = {}
for directory, directories, files in os.walk(root, followlinks=False):
    for entry in directories + files:
        candidate = os.path.join(directory, entry)
        if os.path.islink(candidate): raise RuntimeError('backup_symlink_present')
    for name in files:
        candidate = os.path.join(directory, name)
        if not stat.S_ISREG(os.stat(candidate).st_mode): raise RuntimeError('backup_file_not_regular')
        digest = hashlib.sha256()
        with open(candidate, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        digests[os.path.relpath(candidate, root)] = digest.hexdigest()
inventory = {'schema_version':1, 'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'source_paths':{'database':database,'results':results,'job_results':job_results,
                             'dispatcher_env':dispatcher_env,'slack_env':slack_env,
                             'update_notifications':update_notifications,'job_progress':job_progress},
             'pointers':pointers,'table_counts':counts,'sha256':digests}
temporary = os.path.join(root, 'inventory.json.tmp')
with open(temporary, 'x', encoding='utf-8') as stream:
    os.chmod(temporary, 0o600)
    json.dump(inventory, stream, sort_keys=True)
    stream.flush(); os.fsync(stream.fileno())
os.replace(temporary, os.path.join(root, 'inventory.json'))
descriptor = os.open(root, os.O_RDONLY)
os.fsync(descriptor); os.close(descriptor)
print('backup inventory recorded:', len(digests), 'files')
PY
```

`bootout`が非0やtimeoutでもblind retryしない。`launchctl print`、socket、PIDを照合し、停止が一意に確認できなければDB writeへ進まない。上記の`print`は未登録時に非0となることが期待値である。

対象releaseのCLIを、`DOTENV_CONFIG_PATH`で既存Dispatcher設定、`DONA_RELEASE_MANIFEST_PATH`で**対象release自身のmanifest**、`DONA_DATABASE_PATH`でproduction DBへ固定して実行する。`DispatcherDatabase`のconstructorはschema/補助tableのmigrationを行うため、`inspect`もwriteとして扱い、停止とbackupより前に実行しない。rollback用backup DBをCLIのdry runに使わない。DBコピーでも保存済みの絶対`result_path`がproductionを指し、routing migrationがResult fileを動かし得る。隔離試験を行うなら、rollback snapshotと異なる作業コピーを用い、全Result pathをコピー内の隔離先へ書き換え、production pathへ到達しないことを確認する。このmaintenance手順はその試験に依存しない。

```sh
job_id='<確認済みの個別job ID>'
env DOTENV_CONFIG_PATH="$dispatcher_env" \
  DONA_DATABASE_PATH="$dona_database" \
  DONA_RELEASE_MANIFEST_PATH="$target_release/release-manifest.json" \
  node "$target_release/dispatcher/dist/cli.js" \
  job inspect-operator-recovery "$job_id"
```

`recover-operator-assertion`には、直前の`inspect`から得た`updated_at`、`cause`、`result_class`、`result_sha256`または`missing`、`notification_evidence_sha256`と、別途レビューした副作用証跡SHA-256、保存済み申告event IDを渡す。CLIのflagは[旧job回復手順](legacy-job-recovery-gate.md)のexact順序に従う。1件ごとに`job show`、`operator-recovery-record`、Resultと通知状態を再読する。応答喪失時はこれらを照合し、blind retryしない。無効・欠落Resultは成功に変換されず`failed`となる。全件を機械的に一括承認しない。

## runtime bootstrapとrollback

回復後、全対象のterminal statusと監査記録を確認する。残る危険状態の原因が一意に説明できなければ停止を維持する。現在の`runtime/current`の旧SHAを`runtime/previous`へ保存してから、`runtime/current`を対象releaseへ同一filesystem上の一時symlinkから切り替える。macOS `mv -f`はdestination symlinkをdirectoryとして追跡するため、`mv -fh`でsymlink自体を置換する。停止中のUpdaterを旧build SHAで起動・確認した後、Dispatcherを起動する。Dispatcherのversioned healthと`/v1/admin/update-safety`が対象SHA・`safe: true`・`unsafe_states: []`を示すまでSlack Adapterを起動しない。失敗時はbootstrapを試みたDispatcherとSlack Adapterを再停止・照合する。Slack起動後に両serviceのhealth、DB schema 3、socket/PIDの新世代、通知重複なしを再読する。`dona-main`のcwd/sessionが旧releaseなら**完全なruntime更新とは報告しない**。この手順はHerdr agentの再作成権限を含まない。

```sh
set -euo pipefail
runtime_root="$dona_base/runtime"
target_sha='<承認済みのexact SHA>'
old_sha='<事前記録した旧currentのexact SHA>'
test "$(readlink "$runtime_root/current")" = "releases/$old_sha"
test -f "$runtime_root/releases/$target_sha/release-manifest.json"
test ! -e "$runtime_root/.previous.recovery.tmp" && test ! -L "$runtime_root/.previous.recovery.tmp"
test ! -e "$runtime_root/.current.recovery.tmp" && test ! -L "$runtime_root/.current.recovery.tmp"
ln -s "releases/$old_sha" "$runtime_root/.previous.recovery.tmp"
mv -fh "$runtime_root/.previous.recovery.tmp" "$runtime_root/previous"
test "$(readlink "$runtime_root/previous")" = "releases/$old_sha"
ln -s "releases/$target_sha" "$runtime_root/.current.recovery.tmp"
mv -fh "$runtime_root/.current.recovery.tmp" "$runtime_root/current"
recovery_updater_attempted=0
recovery_dispatcher_attempted=0
recovery_slack_attempted=0
recovery_bootstrap_complete=0
stop_failed_bootstrap() {
  if [ "$recovery_bootstrap_complete" -eq 1 ]; then return; fi
  local failed_slack_pid failed_dispatcher_pid failed_updater_pid
  failed_slack_pid="$(launchctl list | awk '$3=="dev.dona.slack-adapter" {print $1}')" || failed_slack_pid=''
  failed_dispatcher_pid="$(launchctl list | awk '$3=="dev.dona.dispatcher" {print $1}')" || failed_dispatcher_pid=''
  failed_updater_pid="$(launchctl list | awk '$3=="dev.dona.updater" {print $1}')" || failed_updater_pid=''
  if [ "$recovery_slack_attempted" -eq 1 ]; then
    launchctl bootout "gui/$UID/dev.dona.slack-adapter" || true
    if launchctl print "gui/$UID/dev.dona.slack-adapter" >/dev/null 2>&1 ||
       ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_slack_socket" ||
       { [[ "$failed_slack_pid" =~ ^[0-9]+$ ]] && kill -0 "$failed_slack_pid" 2>/dev/null; }; then
      printf '%s\n' 'Slack Adapterの再停止を確認できません。' >&2
    fi
  fi
  if [ "$recovery_dispatcher_attempted" -eq 1 ]; then
    launchctl bootout "gui/$UID/dev.dona.dispatcher" || true
    if launchctl print "gui/$UID/dev.dona.dispatcher" >/dev/null 2>&1 ||
       ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$dona_dispatcher_socket" ||
       { [[ "$failed_dispatcher_pid" =~ ^[0-9]+$ ]] && kill -0 "$failed_dispatcher_pid" 2>/dev/null; }; then
      printf '%s\n' 'Dispatcherの再停止を確認できません。' >&2
    fi
  fi
  if [ "$recovery_updater_attempted" -eq 1 ]; then
    launchctl bootout "gui/$UID/dev.dona.updater" || true
    if launchctl print "gui/$UID/dev.dona.updater" >/dev/null 2>&1 ||
       ! node scripts/self-update-install-preflight.mjs assert-socket-unused "$updater_socket" ||
       { [[ "$failed_updater_pid" =~ ^[0-9]+$ ]] && kill -0 "$failed_updater_pid" 2>/dev/null; }; then
      printf '%s\n' 'Updaterの再停止を確認できません。' >&2
    fi
  fi
}
trap stop_failed_bootstrap EXIT
recovery_updater_attempted=1
updater_bootstrap_exit=0
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/dev.dona.updater.plist" || updater_bootstrap_exit=$?
if ! node scripts/self-update-install-preflight.mjs wait-updater-sha \
  "$updater_socket" "$old_updater_sha" 30000; then
  printf '%s\n' '旧Updaterのexact SHA healthを確認できません。DispatcherとSlackは停止したままにします。' >&2
  exit 1
fi
if [ "$updater_bootstrap_exit" -ne 0 ]; then
  printf 'Updater bootstrap非0をexact SHA healthで照合済み: %s\n' "$updater_bootstrap_exit" >&2
fi
recovery_dispatcher_attempted=1
dispatcher_bootstrap_exit=0
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/dev.dona.dispatcher.plist" || dispatcher_bootstrap_exit=$?
if ! node scripts/self-update-install-preflight.mjs wait-dispatcher-sha \
  "$dona_dispatcher_socket" "$target_sha" 30000; then
  printf '%s\n' 'Dispatcherのexact SHA healthを確認できません。Slack ingressは停止したままにします。' >&2
  exit 1
fi
if [ "$dispatcher_bootstrap_exit" -ne 0 ]; then
  printf 'Dispatcher bootstrap非0をexact SHA healthで照合済み: %s\n' "$dispatcher_bootstrap_exit" >&2
fi
if ! safety_json="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 --unix-socket \
  "$dona_dispatcher_socket" \
  http://localhost/v1/admin/update-safety)"; then
  printf '%s\n' 'Dispatcherの安全状態を取得できません。Slack ingressは停止したままにします。' >&2
  exit 1
fi
if ! printf '%s\n' "$safety_json" | node -e '
let body="";
process.stdin.on("data", chunk => { body += chunk; });
process.stdin.on("end", () => {
  try {
    const snapshot=JSON.parse(body);
    if(snapshot.safe!==true || !Array.isArray(snapshot.unsafe_states) || snapshot.unsafe_states.length!==0) process.exitCode=1;
  } catch { process.exitCode=1; }
});'; then
  printf '%s\n' 'Dispatcherの安全判定がclearではありません。Slack ingressは停止したままにします。' >&2
  exit 1
fi
recovery_slack_attempted=1
slack_bootstrap_exit=0
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/dev.dona.slack-adapter.plist" || slack_bootstrap_exit=$?
slack_ready=0
slack_deadline=$((SECONDS+30))
while (( SECONDS < slack_deadline )); do
  if slack_health="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 --unix-socket "$dona_slack_socket" \
    http://localhost/health/version 2>/dev/null)" &&
     printf '%s' "$slack_health" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);if(v.service!=="slack_adapter"||v.status!=="ready"||v.build_sha!==process.argv[1])process.exitCode=1})' "$target_sha"; then
    slack_ready=1
    break
  fi
  sleep 0.5
done
test "$slack_ready" -eq 1
if [ "$slack_bootstrap_exit" -ne 0 ]; then
  printf 'Slack bootstrap非0をexact SHA healthで照合済み: %s\n' "$slack_bootstrap_exit" >&2
fi
node scripts/self-update-install-preflight.mjs wait-updater-sha "$updater_socket" "$old_updater_sha" 2000
node scripts/self-update-install-preflight.mjs wait-dispatcher-sha "$dona_dispatcher_socket" "$target_sha" 2000
recovery_bootstrap_complete=1
trap - EXIT
```

`bootstrap`応答が曖昧なら再送せず、登録状態とversioned healthを照合する。対象releaseの読み取り・CLI準備が失敗した場合に古いpointerのままserviceを戻す手順と、pointer切替後のrollback手順を同じmaintenance記録に残す。

新Dispatcherがhealthを満たさない場合はSlack/Dispatcherを停止し、両labelとsocketの停止を確認してから旧pointerへ戻す。DBを旧releaseが開けることをDBコピーとschemaで確認する。回復CLIがDBへ書いた後のbackup restoreは監査記録と通知状態を巻き戻すため、機械的には行わない。restoreが必要なら全service停止下でbackup integrity、失われる回復・通知・job変更を個別照合し、別のoperator判断を得る。pointer rollbackとDB restoreを同一操作と見なさない。

対象releaseでDispatcherが起動し、危険状態が空になった後だけ、terminalでない更新planがないことを再確認して`--upgrade-control`を使う。世代別rootではsocketと両env fileがその世代内にあることを確認する。installerは既存policy、pointer、plist、DBを照合してから更新する。これはstable Updater/policyを更新する別操作で、installer内のbackupとrollback・exact SHA healthを確認する。新しい通常self-update plan/applyはさらに別のexact plan承認を要する。対象SHAへpointerを先に切り替えた場合、同じSHAへのplan/applyで`dona-main`が再起動すると推測しない。main agentのrelease identityを揃える手段は別に確認する。

```sh
test "$dona_dispatcher_socket" = "$expected_dispatcher_socket" &&
  test "$dona_slack_socket" = "$expected_slack_socket" &&
  test "$dispatcher_env" = "$dona_base/config/dispatcher.env" &&
  test "$slack_env" = "$dona_base/config/slack.env" || {
    printf '%s\n' 'custom構成では現行control installerを実行できません。' >&2
    exit 1
  }
if [[ "$dona_base" == "$HOME/Library/Application Support/Dona" ]]; then
  ./scripts/install-self-update.sh --upgrade-control
else
  ./scripts/install-self-update.sh --upgrade-control "$dona_base"
fi
```
