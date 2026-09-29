#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPOSITORY_DIR=${SCRIPT_DIR:h}
MODE=${1:-}
TARGET_ROOT=${2:-}
if [[ -n "$TARGET_ROOT" ]]; then
  if [[ ( "$MODE" != "--upgrade-control" && "$MODE" != "--stage-recovery" ) || $# -ne 2 || "$TARGET_ROOT" != /* || "$TARGET_ROOT" == */ || ! -d "$TARGET_ROOT" || -L "$TARGET_ROOT" ]]; then
    print -u2 -- "--upgrade-controlまたは--stage-recoveryの既存absolute target rootだけを指定できます。"
    exit 2
  fi
  BASE_DIR="$TARGET_ROOT"
  CONTROL_ROOT="$BASE_DIR/control"
else
  if [[ $# -gt 1 ]]; then print -u2 -- "modeとtarget rootの組み合わせが不正です。"; exit 2; fi
  BASE_DIR="$HOME/Library/Application Support/Dona"
  CONTROL_ROOT="$BASE_DIR/update-control"
fi
if [[ -n "$TARGET_ROOT" ]]; then
  DISPATCHER_SOCKET="$BASE_DIR/run/d.sock"
  SLACK_SOCKET="$BASE_DIR/run/s.sock"
else
  DISPATCHER_SOCKET="$BASE_DIR/run/dispatcher.sock"
  SLACK_SOCKET="$BASE_DIR/run/slack-adapter.sock"
fi
RUNTIME_ROOT="$BASE_DIR/runtime"
RELEASE_ROOT="$RUNTIME_ROOT/releases"
CONFIG_ROOT="$BASE_DIR/config"
LOG_ROOT="$BASE_DIR/logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$UID"
CONTROL_UPGRADE_ACTIVE=0
CONTROL_SWAPPED=0
DISPATCHER_PLIST_SWAPPED=0
DISPATCHER_RESTORE_REQUIRED=0
CONTROL_BACKUP_ROOT=""
CONTROL_LEDGER_DIR=""

record_control_phase() {
  [[ -n "$CONTROL_LEDGER_DIR" ]] || return 0
  $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" advance "$CONTROL_LEDGER_DIR" "$@"
}

launchctl_once() {
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" launchctl-once "$@"
}

assert_control_targets() {
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-control-target-paths \
    "$CONTROL_ROOT" "$RELEASE_ROOT" "$LAUNCH_AGENTS_DIR" "$CONTROL_BACKUP_ROOT"
}

bootstrap_updater_reconciled() {
  local context=$1
  local expected_sha=$2
  local identity_mode=${3:-}
  local -a identity_args=()
  if [[ -n "$identity_mode" ]]; then identity_args=("$identity_mode"); fi
  local output=""
  local exit_code=0
  if output=$(launchctl_once bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" 30000 2>&1); then
    if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha \
      "$CONTROL_ROOT/updater.sock" "$expected_sha" 30000 3 && \
      $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-identity \
      "$CONTROL_ROOT/updater.sock" "$expected_sha" "$DOMAIN" 30000 "${identity_args[@]}"; then
      return 0
    fi
    print -u2 -- "${context}の起動identityを確定できません。"
    return 1
  else
    exit_code=$?
  fi
  if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-launchd-updater-sha \
    "$DOMAIN" "$expected_sha" 30000; then
    if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha \
        "$CONTROL_ROOT/updater.sock" "$expected_sha" 30000 3 && \
        $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-identity \
        "$CONTROL_ROOT/updater.sock" "$expected_sha" "$DOMAIN" 30000 "${identity_args[@]}"; then
      print -u2 -- "${context}ではlaunchctlがexit ${exit_code}を返しましたが、exact SHAの起動identityを確認しました。"
      return 0
    fi
  fi
  print -u2 -- "${context}のlaunchctl bootstrapはexit ${exit_code}で、登録状態を確定できません。再送せず照合が必要です。"
  if [[ -n "$output" ]]; then print -u2 -- "$output"; fi
  return 1
}

wait_dispatcher_unregistered() {
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-launchd-unregistered \
    "$DOMAIN" "dev.dona.dispatcher" 30000
}

bootstrap_dispatcher_reconciled() {
  local context=$1
  local expected_sha=$2
  local output=""
  local exit_code=0
  if ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$DISPATCHER_SOCKET"; then
    print -u2 -- "Dispatcherのsocketを別processが使用中のためbootstrapしません。"
    return 1
  fi
  if output=$(launchctl_once bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" 30000 2>&1); then
    if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha \
      "$DISPATCHER_SOCKET" "$expected_sha" "$DOMAIN" 30000; then return 0; fi
    print -u2 -- "${context}のDispatcher healthを確定できません。"
    return 1
  else
    exit_code=$?
  fi
  if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha \
    "$DISPATCHER_SOCKET" "$expected_sha" "$DOMAIN" 30000; then
    print -u2 -- "${context}ではlaunchctlがexit ${exit_code}を返しましたが、exact SHAの起動済み状態を確認しました。"
    return 0
  fi
  print -u2 -- "${context}のlaunchctl bootstrapはexit ${exit_code}で失敗し、exact SHAの起動済み状態も確認できませんでした。"
  if [[ -n "$output" ]]; then print -u2 -- "$output"; fi
  return 1
}

bootstrap_slack_reconciled() {
  local output=""
  local exit_code=0
  if ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$SLACK_SOCKET"; then
    print -u2 -- "Slack Adapterのsocketを別processが使用中のためbootstrapしません。"
    return 1
  fi
  if output=$(launchctl_once bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist" 30000 2>&1); then
    :
  else
    exit_code=$?
  fi
  if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-slack-sha \
      "$SLACK_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000; then
    if [[ "$exit_code" != "0" ]]; then
      print -u2 -- "Slack Adapterのbootstrap応答はexit ${exit_code}でしたが、固定labelとexact SHA healthを確認しました。"
    fi
    return 0
  fi
  print -u2 -- "Slack Adapterの起動状態を確定できません。bootstrapを再送せず登録とhealthを照合してください。"
  if [[ -n "$output" ]]; then print -u2 -- "$output"; fi
  return 1
}

restore_control_plane() {
  if [[ "$CONTROL_UPGRADE_ACTIVE" != "1" || -z "$CONTROL_BACKUP_ROOT" ]]; then return 0; fi
  local updater_registration=""
  updater_registration=$(/bin/launchctl print "$DOMAIN/dev.dona.updater" 2>/dev/null) || updater_registration=""
  if [[ -n "$updater_registration" ]]; then
    if [[ "$updater_registration" != *"DONA_UPDATER_BUILD_SHA => ${INSTALL_SHA}"* &&
          "$updater_registration" != *"DONA_UPDATER_BUILD_SHA => ${OLD_UPDATER_SHA}"* ]]; then
      print -u2 "control-plane復旧前にUpdaterの登録identityを確認できません。"
      return 1
    fi
    launchctl_once bootout "$DOMAIN" dev.dona.updater 30000 >/dev/null 2>&1 || true
  fi
  if /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    print -u2 "control-plane復旧前に新しいupdaterの停止を確認できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  if ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$CONTROL_ROOT/updater.sock"; then
    print -u2 "control-plane復旧前にupdater socketの停止を確認できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  if [[ "$CONTROL_SWAPPED" == "1" && -d "$CONTROL_BACKUP_ROOT/updater.previous" ]]; then
    if [[ -d "$CONTROL_ROOT/updater" && ! -e "$CONTROL_BACKUP_ROOT/updater.failed" ]]; then
      /bin/mv "$CONTROL_ROOT/updater" "$CONTROL_BACKUP_ROOT/updater.failed"
    fi
    if [[ ! -e "$CONTROL_ROOT/updater" ]]; then
      /bin/mv "$CONTROL_BACKUP_ROOT/updater.previous" "$CONTROL_ROOT/updater"
    fi
    /bin/cp "$CONTROL_BACKUP_ROOT/policy.previous.json" "$CONTROL_ROOT/policy.json"
    /bin/cp "$CONTROL_BACKUP_ROOT/dev.dona.updater.previous.plist" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist"
    if [[ -f "$CONTROL_BACKUP_ROOT/updater.previous.sqlite3" ]]; then
      /bin/rm -f "$CONTROL_ROOT/updater.sqlite3" "$CONTROL_ROOT/updater.sqlite3-wal" "$CONTROL_ROOT/updater.sqlite3-shm"
      /bin/cp "$CONTROL_BACKUP_ROOT/updater.previous.sqlite3" "$CONTROL_ROOT/updater.sqlite3"
      chmod 600 "$CONTROL_ROOT/updater.sqlite3"
    elif [[ -f "$CONTROL_BACKUP_ROOT/updater.database-was-absent" ]]; then
      /bin/rm -f "$CONTROL_ROOT/updater.sqlite3" "$CONTROL_ROOT/updater.sqlite3-wal" "$CONTROL_ROOT/updater.sqlite3-shm"
    fi
    if [[ -f "$CONTROL_BACKUP_ROOT/control-plane-receipt.previous.json" ]]; then
      /bin/cp "$CONTROL_BACKUP_ROOT/control-plane-receipt.previous.json" "$CONTROL_ROOT/control-plane-receipt.json"
      chmod 600 "$CONTROL_ROOT/control-plane-receipt.json"
    elif [[ -f "$CONTROL_BACKUP_ROOT/control-plane-receipt.was-absent" ]]; then
      /bin/rm -f "$CONTROL_ROOT/control-plane-receipt.json"
    else
      print -u2 "control-plane receiptの復元元を確認できません。"
      return 1
    fi
  fi
  $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" verify-restore-control "$CONTROL_BACKUP_ROOT" \
    "$CONTROL_ROOT/policy.json" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" \
    "$CONTROL_ROOT/updater" "$CONTROL_ROOT/updater.sqlite3" "$CONTROL_ROOT/control-plane-receipt.json" || return 1
  if ! bootstrap_updater_reconciled "旧stable updaterの復旧" "$OLD_UPDATER_SHA" legacy-health; then
    print -u2 "旧stable updaterをlaunchdへ再登録できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  if [[ -n "${OLD_UPDATER_SHA:-}" ]] && \
    ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha \
      "$CONTROL_ROOT/updater.sock" "$OLD_UPDATER_SHA" 30000; then
    print -u2 "旧stable updaterの復旧healthを確認できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  if [[ "$DISPATCHER_RESTORE_REQUIRED" == "1" && -f "$CONTROL_BACKUP_ROOT/dev.dona.dispatcher.previous.plist" ]]; then
    local dispatcher_bootout_exit=0
    if [[ "$DISPATCHER_PLIST_SWAPPED" != "1" ]] && [[ -n "${ACTIVE_DISPATCHER_SHA:-}" ]] && \
      $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha \
        "$DISPATCHER_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 2000; then
      DISPATCHER_RESTORE_REQUIRED=0
      $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" verify-restore-dispatcher \
        "$CONTROL_BACKUP_ROOT" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" || return 1
      return 0
    fi
    launchctl_once bootout "$DOMAIN" dev.dona.dispatcher 30000 || dispatcher_bootout_exit=$?
    if ! wait_dispatcher_unregistered; then
      print -u2 "旧Dispatcher復旧前の登録解除を確認できません（bootout exit ${dispatcher_bootout_exit}）。backup: $CONTROL_BACKUP_ROOT"
      return 1
    fi
    if [[ "$dispatcher_bootout_exit" != "0" ]]; then
      print -u2 "旧Dispatcher復旧前のlaunchctl bootoutはexit ${dispatcher_bootout_exit}でしたが、登録解除済み状態を確認しました。"
    fi
    if [[ "$DISPATCHER_PLIST_SWAPPED" == "1" ]]; then
      /bin/cp "$CONTROL_BACKUP_ROOT/dev.dona.dispatcher.previous.plist" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
    fi
    if ! bootstrap_dispatcher_reconciled "旧Updaterの復旧後の旧Dispatcher再登録" "$ACTIVE_DISPATCHER_SHA"; then
      print -u2 "旧Updaterの復旧後に旧Dispatcher plistをlaunchdへ再登録できません。backup: $CONTROL_BACKUP_ROOT"
      return 1
    fi
    if [[ -z "${ACTIVE_DISPATCHER_SHA:-}" ]] || \
      ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha \
        "$DISPATCHER_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000; then
      print -u2 "旧Dispatcherの復旧healthを確認できません。backup: $CONTROL_BACKUP_ROOT"
      return 1
    fi
    DISPATCHER_PLIST_SWAPPED=0
    DISPATCHER_RESTORE_REQUIRED=0
  fi
  $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" verify-restore-dispatcher \
    "$CONTROL_BACKUP_ROOT" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" || return 1
  return 0
}

if [[ "$MODE" != "--check" && "$MODE" != "--install" && "$MODE" != "--bootstrap" && "$MODE" != "--upgrade-control" && "$MODE" != "--stage-recovery" ]]; then
  print -u2 "Usage: $0 --check | --install | --bootstrap | --upgrade-control [existing-absolute-target-root] | --stage-recovery [existing-absolute-target-root]"
  print -u2 -- "--checkはtemplateのみ検証し、--installは初期配置、--bootstrapは初回起動、--upgrade-controlは停止確認付きでstable control-planeを更新します。"
  print -u2 -- "--stage-recoveryはCI検証済みreleaseだけを配置し、service、pointer、DB、Updaterは変更しません。"
  exit 2
fi

NODE_PATH=$(command -v node)
NPM_PATH=$(command -v npm)
GIT_PATH=$(command -v git)
GH_PATH=$(command -v gh)
HERDR_PATH=$(command -v herdr)
INSTALL_SHA=$($GIT_PATH -C "$REPOSITORY_DIR" rev-parse HEAD^{commit})
INSTALL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/dona-self-update-install.XXXXXX")

cleanup_temp() {
  if [[ "$CONTROL_UPGRADE_ACTIVE" == "1" ]]; then
    record_control_phase restore_required || print -u2 "control attemptの復旧intentを記録できません。手動照合が必要です。"
    if restore_control_plane; then
      record_control_phase restored || print -u2 "control attemptの復旧結果を記録できません。手動照合が必要です。"
    else
      record_control_phase needs_review || print -u2 "control attemptの要確認状態を記録できません。手動照合が必要です。"
    fi
  fi
  if [[ -n "${STAGING_DIR:-}" ]]; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" cleanup-staging "$RELEASE_ROOT" "$STAGING_DIR" || \
      print -u2 "staging directoryのcleanupに失敗しました。"
  fi
  if [[ -n "${INSTALL_TMP:-}" && -d "$INSTALL_TMP" && "$INSTALL_TMP" == *dona-self-update-install.* ]]; then
    rm -rf "$INSTALL_TMP"
  fi
}
trap cleanup_temp EXIT

$NODE_PATH "$SCRIPT_DIR/render-self-update-templates.mjs" "$INSTALL_TMP/rendered" "$INSTALL_SHA" "$BASE_DIR" "${TARGET_ROOT:+generation}"
if [[ -n "$TARGET_ROOT" ]]; then
  EXPECTED_OLD_UPDATER_SHA=$(/usr/bin/python3 "$SCRIPT_DIR/validate-generation-install-target.py" "$BASE_DIR" "$INSTALL_TMP/rendered" "$LAUNCH_AGENTS_DIR" "$MODE")
fi
/usr/bin/plutil -lint "$INSTALL_TMP/rendered/dev.dona.updater.plist" \
  "$INSTALL_TMP/rendered/dev.dona.dispatcher.plist" \
  "$INSTALL_TMP/rendered/dev.dona.slack-adapter.plist"
$NODE_PATH -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$INSTALL_TMP/rendered/policy.json"

if [[ "$MODE" == "--check" ]]; then
  print "self-update policyと3つのLaunchAgent templateは有効です。実環境は変更していません。"
  exit 0
fi

if [[ "$MODE" == "--bootstrap" ]]; then
  ACTIVE_DISPATCHER_SHA=$(/usr/bin/basename "$(/usr/bin/readlink "$RUNTIME_ROOT/current")")
  if [[ ! "$ACTIVE_DISPATCHER_SHA" =~ '^[0-9a-f]{40}$' ]]; then
    print -u2 "起動対象のDispatcher SHAを確定できません。"
    exit 1
  fi
  for plist in dev.dona.updater dev.dona.dispatcher dev.dona.slack-adapter; do
    if [[ ! -f "$LAUNCH_AGENTS_DIR/$plist.plist" ]]; then
      print -u2 "Missing $LAUNCH_AGENTS_DIR/$plist.plist. Run --install first."
      exit 1
    fi
  done
  BOOTSTRAP_UPDATER_SHA=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:DONA_UPDATER_BUILD_SHA" \
    "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist")
  if [[ ! "$BOOTSTRAP_UPDATER_SHA" =~ '^[0-9a-f]{40}$' || "$BOOTSTRAP_UPDATER_SHA" != "$ACTIVE_DISPATCHER_SHA" ]]; then
    print -u2 "install済みUpdater plistとcurrent releaseのSHAが一致しません。"
    exit 1
  fi
  $NODE_PATH -e 'const fs=require("node:fs");const manifest=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(manifest.sha!==process.argv[2])process.exit(1)' \
    "$RELEASE_ROOT/$BOOTSTRAP_UPDATER_SHA/release-manifest.json" "$BOOTSTRAP_UPDATER_SHA"
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-private-file "$CONTROL_ROOT/updater/dist/cli.js"
  if ! /bin/launchctl print "$DOMAIN/dev.dona.dispatcher" >/dev/null 2>&1; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$DISPATCHER_SOCKET"
  fi
  dispatcher_registered=0
  slack_registered=0
  if /bin/launchctl print "$DOMAIN/dev.dona.dispatcher" >/dev/null 2>&1; then dispatcher_registered=1; fi
  if /bin/launchctl print "$DOMAIN/dev.dona.slack-adapter" >/dev/null 2>&1; then slack_registered=1; fi
  if [[ "$slack_registered" == "1" && "$dispatcher_registered" == "0" ]]; then
    print -u2 "Slack Adapterのみ登録済みのため初回bootstrapを再開できません。"
    exit 1
  fi
  if [[ "$dispatcher_registered" == "1" ]]; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-private-file "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
    if ! /usr/bin/cmp -s "$INSTALL_TMP/rendered/dev.dona.dispatcher.plist" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" ||
       ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha \
         "$DISPATCHER_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000; then
      print -u2 "登録済みDispatcherのplistと起動状態を今回のinstallに照合できません。"
      exit 1
    fi
  fi
  if [[ "$slack_registered" == "1" ]]; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-private-file "$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist"
    if ! /usr/bin/cmp -s "$INSTALL_TMP/rendered/dev.dona.slack-adapter.plist" "$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist" ||
       ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-slack-sha \
         "$SLACK_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000; then
      print -u2 "登録済みSlack Adapterのplistと起動状態を今回のinstallに照合できません。"
      exit 1
    fi
  fi
  if ! /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    if ! bootstrap_updater_reconciled "初回Updater登録" "$BOOTSTRAP_UPDATER_SHA"; then exit 1; fi
  elif ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha \
      "$CONTROL_ROOT/updater.sock" "$BOOTSTRAP_UPDATER_SHA" 30000 3 || \
      ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-identity \
      "$CONTROL_ROOT/updater.sock" "$BOOTSTRAP_UPDATER_SHA" "$DOMAIN" 30000; then
    print -u2 "登録済みUpdaterのexact SHA起動identityを確認できません。"
    exit 1
  fi
  if [[ "$dispatcher_registered" == "0" ]] &&
     ! bootstrap_dispatcher_reconciled "初回Dispatcher登録" "$ACTIVE_DISPATCHER_SHA"; then
    print -u2 "Dispatcher登録状態が不明のためSlack Adapterの起動を保留しました。再送せず登録とhealthを照合してください。"
    exit 1
  fi
  if [[ "$slack_registered" == "0" ]] && ! bootstrap_slack_reconciled; then exit 1; fi
  print "stable updater、Dispatcher、Slack Adapterを順序付きでbootstrapしました。"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" || "$UID" == "0" ]]; then
  print -u2 -- "--install、--upgrade-control、--stage-recoveryは非rootのmacOS GUI userだけで実行できます。"
  exit 1
fi
if ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-remote \
  "$($GIT_PATH -C "$REPOSITORY_DIR" remote get-url origin)"; then
  print -u2 "originがcanonical repositoryではありません。"
  exit 1
fi
if [[ "$($GIT_PATH -C "$REPOSITORY_DIR" symbolic-ref --short HEAD)" != "main" ]]; then
  print -u2 -- "--installはcanonical main branchのclean checkoutだけを受け付けます。"
  exit 1
fi
if [[ -n "$($GIT_PATH -C "$REPOSITORY_DIR" status --porcelain=v1 --untracked-files=all)" ]]; then
  print -u2 "install元worktreeに未commit差分があります。"
  exit 1
fi
$GIT_PATH -C "$REPOSITORY_DIR" fetch --no-tags origin main
if [[ "$INSTALL_SHA" != "$($GIT_PATH -C "$REPOSITORY_DIR" rev-parse refs/remotes/origin/main^{commit})" ]]; then
  print -u2 "install対象HEADは最新origin/mainと一致しません。"
  exit 1
fi
$GH_PATH api --method GET "repos/hiragram/dona/commits/$INSTALL_SHA/check-runs" -f per_page=100 > "$INSTALL_TMP/check-runs.json"
TRUSTED_RUN_ID=$($NODE_PATH "$SCRIPT_DIR/verify-install-ci.mjs" checks "$INSTALL_TMP/check-runs.json" "$INSTALL_SHA")
$GH_PATH api --method GET "repos/hiragram/dona/actions/runs/$TRUSTED_RUN_ID" > "$INSTALL_TMP/workflow-run.json"
$NODE_PATH "$SCRIPT_DIR/verify-install-ci.mjs" workflow "$INSTALL_TMP/workflow-run.json" "$INSTALL_SHA" "$TRUSTED_RUN_ID"
if [[ "$MODE" == "--install" && -e "$CONTROL_ROOT/updater" ]]; then
  print -u2 "stable updaterは既にinstall済みです。updater自身の上書き更新は実施しません。"
  exit 1
fi
if [[ "$MODE" == "--upgrade-control" && ! -d "$CONTROL_ROOT/updater" ]]; then
  print -u2 "stable updaterが未導入です。先に--installと--bootstrapを実行してください。"
  exit 1
fi
umask 077
if [[ "$MODE" == "--stage-recovery" ]]; then
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || { print -u2 "既存release rootを確認できません。"; exit 1; }
  mkdir -p "$RELEASE_ROOT/.staging"
  chmod 700 "$RELEASE_ROOT/.staging"
else
  mkdir -p "$CONTROL_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT" "$LAUNCH_AGENTS_DIR"
  chmod 700 "$BASE_DIR" "$CONTROL_ROOT" "$RUNTIME_ROOT" "$RELEASE_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT"
fi
STAGING_DIR=$(mktemp -d "$RELEASE_ROOT/.staging/install.XXXXXX")
$GIT_PATH -C "$REPOSITORY_DIR" archive --format=tar --output="$INSTALL_TMP/release.tar" "$INSTALL_SHA"
/usr/bin/tar -xf "$INSTALL_TMP/release.tar" -C "$STAGING_DIR"

mkdir -p "$INSTALL_TMP/npm-cache"
/usr/bin/touch "$INSTALL_TMP/npm-userconfig" "$INSTALL_TMP/npm-globalconfig"
for component in dispatcher sources/slack updater; do
  COMPONENT_DIR="$STAGING_DIR/$component"
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=1 NO_COLOR=1 npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_audit=false npm_config_fund=false \
    npm_config_userconfig="$INSTALL_TMP/npm-userconfig" npm_config_globalconfig="$INSTALL_TMP/npm-globalconfig" \
    npm_config_update_notifier=false \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" ci
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig="$INSTALL_TMP/npm-userconfig" \
    npm_config_globalconfig="$INSTALL_TMP/npm-globalconfig" \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" test
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig="$INSTALL_TMP/npm-userconfig" \
    npm_config_globalconfig="$INSTALL_TMP/npm-globalconfig" \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" run typecheck
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig="$INSTALL_TMP/npm-userconfig" \
    npm_config_globalconfig="$INSTALL_TMP/npm-globalconfig" \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" run build
done
NPM_VERSION=$($NPM_PATH --version)
$NODE_PATH "$SCRIPT_DIR/write-release-manifest.mjs" "$STAGING_DIR" "$INSTALL_SHA" "$NPM_VERSION" "2026-09-03.2"
STAGED_DIGEST=$($NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-staged-release "$STAGING_DIR" "$INSTALL_SHA")
FINAL_RELEASE="$RELEASE_ROOT/$INSTALL_SHA"
if [[ -e "$FINAL_RELEASE" ]]; then
  if [[ "$MODE" != "--upgrade-control" && "$MODE" != "--stage-recovery" ]] || \
    ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-existing-release \
      "$FINAL_RELEASE" "$STAGING_DIR" "$INSTALL_SHA"; then
    print -u2 "release $INSTALL_SHA は既に存在し、今回のmodeでは再利用できません。上書きしません。"
    exit 1
  fi
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" cleanup-staging "$RELEASE_ROOT" "$STAGING_DIR"
  STAGING_DIR=
  print "既存の検証済みimmutable release $INSTALL_SHA をcontrol-plane更新に再利用します。"
else
  find "$STAGING_DIR" -type f -exec chmod 400 {} +
  find "$STAGING_DIR" -mindepth 1 -type d -exec chmod 500 {} +
  /bin/mv "$STAGING_DIR" "$FINAL_RELEASE"
  STAGING_DIR=
  chmod 500 "$FINAL_RELEASE"
fi
$NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-published-release \
  "$FINAL_RELEASE" "$INSTALL_SHA" "$STAGED_DIGEST"

if [[ "$MODE" == "--stage-recovery" ]]; then
  print "検証済みimmutable release $INSTALL_SHA を配置しました。service、pointer、DB、Updaterは変更していません。"
  exit 0
fi

if [[ "$MODE" == "--upgrade-control" ]]; then
  UPDATER_SOCKET="$CONTROL_ROOT/updater.sock"
  if ! /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    print -u2 "dev.dona.updaterがlaunchd管理下で起動していないため、安全に更新できません。"
    exit 1
  fi
  OLD_UPDATER_SHA=$($NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-control-upgrade-safe "$UPDATER_SOCKET")
  if [[ -n "$TARGET_ROOT" && "$OLD_UPDATER_SHA" != "$EXPECTED_OLD_UPDATER_SHA" ]]; then
    print -u2 "稼働中Updaterと保存済みplistのSHAが一致しないため、停止しません。"
    exit 1
  fi
  if [[ ! -f "$CONTROL_ROOT/updater.sqlite3" ]]; then
    print -u2 "updater databaseを確認できないため、stable updaterを停止しません。"
    exit 1
  fi
  PRESTOP_NONTERMINAL_COUNT=$(/usr/bin/sqlite3 "$CONTROL_ROOT/updater.sqlite3" \
    "SELECT COUNT(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled');")
  if [[ ! "$PRESTOP_NONTERMINAL_COUNT" =~ '^[0-9]+$' || "$PRESTOP_NONTERMINAL_COUNT" != "0" ]]; then
    print -u2 "停止前のDB確認でnonterminal self-updateを${PRESTOP_NONTERMINAL_COUNT}件検出したため、stable updaterを停止しません。"
    exit 1
  fi
  mkdir -p "$CONTROL_ROOT/control-backups"
  BACKUP_ROOT=$(mktemp -d "$CONTROL_ROOT/control-backups/$INSTALL_SHA.XXXXXX")
  CONTROL_BACKUP_ROOT="$BACKUP_ROOT"
  chmod 700 "$CONTROL_ROOT/control-backups" "$BACKUP_ROOT"
  /usr/bin/ditto "$FINAL_RELEASE/updater" "$BACKUP_ROOT/updater.next"
  find "$BACKUP_ROOT/updater.next" -type f -exec chmod 400 {} +
  find "$BACKUP_ROOT/updater.next" -type d -exec chmod 500 {} +
  chmod 700 "$BACKUP_ROOT/updater.next"
  /bin/cp "$INSTALL_TMP/rendered/policy.json" "$BACKUP_ROOT/policy.next.json"
  /bin/cp "$INSTALL_TMP/rendered/dev.dona.updater.plist" "$BACKUP_ROOT/dev.dona.updater.next.plist"
  /bin/cp "$INSTALL_TMP/rendered/dev.dona.dispatcher.plist" "$BACKUP_ROOT/dev.dona.dispatcher.next.plist"
  chmod 600 "$BACKUP_ROOT/policy.next.json" "$BACKUP_ROOT/dev.dona.updater.next.plist" "$BACKUP_ROOT/dev.dona.dispatcher.next.plist"
  if [[ -e "$CONTROL_ROOT/control-plane-receipt.json" || -L "$CONTROL_ROOT/control-plane-receipt.json" ]]; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-private-file "$CONTROL_ROOT/control-plane-receipt.json"
    /bin/cp "$CONTROL_ROOT/control-plane-receipt.json" "$BACKUP_ROOT/control-plane-receipt.previous.json"
    chmod 600 "$BACKUP_ROOT/control-plane-receipt.previous.json"
  else
    /usr/bin/touch "$BACKUP_ROOT/control-plane-receipt.was-absent"
    chmod 600 "$BACKUP_ROOT/control-plane-receipt.was-absent"
  fi

  assert_control_targets

  OLD_RECEIPT_PATH="-"
  if [[ -f "$CONTROL_ROOT/control-plane-receipt.json" ]]; then OLD_RECEIPT_PATH="$CONTROL_ROOT/control-plane-receipt.json"; fi
  $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" create "$BACKUP_ROOT" \
    "$OLD_UPDATER_SHA" "$INSTALL_SHA" "$CONTROL_ROOT/policy.json" "$BACKUP_ROOT/policy.next.json" \
    "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" "$BACKUP_ROOT/dev.dona.updater.next.plist" "$STAGED_DIGEST" \
    "$CONTROL_ROOT/updater" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" "$OLD_RECEIPT_PATH"
  CONTROL_LEDGER_DIR="$BACKUP_ROOT"

  CONTROL_UPGRADE_ACTIVE=1
  record_control_phase updater_stop_intent bootout_updater
  UPDATER_BOOTOUT_EXIT=0
  launchctl_once bootout "$DOMAIN" dev.dona.updater 30000 || UPDATER_BOOTOUT_EXIT=$?
  if ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-launchd-unregistered \
      "$DOMAIN" dev.dona.updater 30000; then
    print -u2 "stable updaterの登録解除を確定できません（bootout exit ${UPDATER_BOOTOUT_EXIT}）。fileは切り替えていません。"
    CONTROL_UPGRADE_ACTIVE=0
    record_control_phase needs_review
    exit 1
  fi
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$UPDATER_SOCKET"
  record_control_phase updater_stopped
  if [[ ! -f "$CONTROL_ROOT/updater.sqlite3" ]]; then
    print -u2 "停止後のupdater databaseを確認できないため、control-planeを更新しません。"
    exit 1
  fi
  NONTERMINAL_COUNT=$(/usr/bin/sqlite3 "$CONTROL_ROOT/updater.sqlite3" \
    "SELECT COUNT(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled');")
  if [[ ! "$NONTERMINAL_COUNT" =~ '^[0-9]+$' || "$NONTERMINAL_COUNT" != "0" ]]; then
    print -u2 "停止後のDB確認でnonterminal self-updateを${NONTERMINAL_COUNT}件検出したため、旧updaterを再開します。"
    exit 1
  fi

  /bin/cp "$CONTROL_ROOT/policy.json" "$BACKUP_ROOT/policy.previous.json"
  /bin/cp "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" "$BACKUP_ROOT/dev.dona.updater.previous.plist"
  /bin/cp "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist" "$BACKUP_ROOT/dev.dona.dispatcher.previous.plist"
  if [[ -f "$CONTROL_ROOT/updater.sqlite3" ]]; then
    assert_control_targets
    /usr/bin/python3 "$SCRIPT_DIR/backup-control-db.py" \
      "$CONTROL_ROOT/updater.sqlite3" "$BACKUP_ROOT/updater.previous.sqlite3"
    $NODE_PATH "$SCRIPT_DIR/rehearse-control-restore.mjs" \
      "$CONTROL_ROOT/updater/dist/database.js" "$FINAL_RELEASE/updater/dist/database.js" \
      "$BACKUP_ROOT/updater.previous.sqlite3" "$BACKUP_ROOT/restore-rehearsal.json"
    record_control_phase backup_verified none "$BACKUP_ROOT/updater.previous.sqlite3" "$BACKUP_ROOT/restore-rehearsal.json"
  else
    /usr/bin/touch "$BACKUP_ROOT/updater.database-was-absent"
    chmod 600 "$BACKUP_ROOT/updater.database-was-absent"
  fi
  CONTROL_SWAPPED=1
  ACTIVE_DISPATCHER_SHA=$(/usr/bin/basename "$(/usr/bin/readlink "$RUNTIME_ROOT/current")")
  if [[ ! "$ACTIVE_DISPATCHER_SHA" =~ '^[0-9a-f]{40}$' ]]; then
    print -u2 "active Dispatcher SHAをcurrent pointerから確定できません。"
    exit 1
  fi
  DISPATCHER_RESTORE_REQUIRED=1
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" quiesce-dispatcher "$DISPATCHER_SOCKET" "$INSTALL_SHA"
  record_control_phase dispatcher_stop_intent bootout_dispatcher
  if ! launchctl_once bootout "$DOMAIN" dev.dona.dispatcher 30000; then
    if /bin/launchctl print "$DOMAIN/dev.dona.dispatcher" >/dev/null 2>&1; then
      print -u2 "Dispatcherの停止受理を確認できないため、plistを更新しません。"
      exit 1
    fi
  fi
  if ! wait_dispatcher_unregistered; then
    print -u2 "Dispatcherの登録解除完了を確認できないため、plistを更新しません。"
    exit 1
  fi
  record_control_phase dispatcher_stopped
  /bin/mv "$BACKUP_ROOT/dev.dona.dispatcher.next.plist" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
  DISPATCHER_PLIST_SWAPPED=1
  record_control_phase dispatcher_start_intent bootstrap_dispatcher
  if ! bootstrap_dispatcher_reconciled "新しいDispatcher plistの登録" "$ACTIVE_DISPATCHER_SHA"; then
    print -u2 "新しいDispatcher plistをlaunchdへ登録できないため、control-planeを復旧します。"
    exit 1
  fi
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha "$DISPATCHER_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000
  record_control_phase dispatcher_started
  assert_control_targets
  /bin/mv "$CONTROL_ROOT/updater" "$BACKUP_ROOT/updater.previous"
  /bin/mv "$BACKUP_ROOT/updater.next" "$CONTROL_ROOT/updater"
  /bin/mv "$BACKUP_ROOT/policy.next.json" "$CONTROL_ROOT/policy.json"
  /bin/mv "$BACKUP_ROOT/dev.dona.updater.next.plist" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist"
  record_control_phase control_swapped

  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-published-release \
    "$FINAL_RELEASE" "$INSTALL_SHA" "$STAGED_DIGEST"
  record_control_phase updater_start_intent bootstrap_updater
  if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-dispatcher-sha "$DISPATCHER_SOCKET" "$ACTIVE_DISPATCHER_SHA" "$DOMAIN" 30000 && \
    bootstrap_updater_reconciled "新しいstable updaterの登録" "$INSTALL_SHA" && \
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha "$UPDATER_SOCKET" "$INSTALL_SHA" 30000 3 && \
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-identity "$UPDATER_SOCKET" "$INSTALL_SHA" "$DOMAIN" 30000; then
    record_control_phase updater_started
    $NODE_PATH "$SCRIPT_DIR/control-attempt-ledger.mjs" verify "$BACKUP_ROOT" \
      "$CONTROL_ROOT/policy.json" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" \
      "$BACKUP_ROOT/updater.previous.sqlite3" "$BACKUP_ROOT/restore-rehearsal.json"
    assert_control_targets
    record_control_phase verified
    CONTROL_RECEIPT_TMP="$CONTROL_ROOT/.control-plane-receipt.json.$$.$RANDOM.tmp"
    $NODE_PATH "$SCRIPT_DIR/write-control-receipt.mjs" "$BACKUP_ROOT" "$CONTROL_RECEIPT_TMP" "$INSTALL_SHA" "$CONTROL_ROOT/updater"
    /bin/mv "$CONTROL_RECEIPT_TMP" "$CONTROL_ROOT/control-plane-receipt.json"
    $NODE_PATH -e 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$CONTROL_ROOT"
    CONTROL_UPGRADE_ACTIVE=0
    print "stable updaterとpolicyを${INSTALL_SHA}へ更新し、version healthを確認しました。"
    print "次に通常updateをplan/applyして、DispatcherとSlack Adapterを同じreleaseへ切り替えてください。"
    exit 0
  fi

  print -u2 "新しいstable updaterのversion healthを確認できないため、control-planeを復旧します。"
  record_control_phase restore_required
  if ! restore_control_plane; then
    CONTROL_UPGRADE_ACTIVE=0
    record_control_phase needs_review
    print -u2 "control-planeの自動復旧を安全に完了できません。backup: $BACKUP_ROOT"
    exit 1
  fi
  CONTROL_UPGRADE_ACTIVE=0
  record_control_phase restored
  print -u2 "control-plane updateをロールバックし、旧stable updaterの復旧を確認しました。"
  exit 1
fi

/usr/bin/ditto "$FINAL_RELEASE/updater" "$CONTROL_ROOT/updater.next"
chmod 700 "$CONTROL_ROOT/updater.next"
/bin/mv "$CONTROL_ROOT/updater.next" "$CONTROL_ROOT/updater"

/bin/ln -s "releases/$INSTALL_SHA" "$RUNTIME_ROOT/.current.tmp"
/bin/mv -f "$RUNTIME_ROOT/.current.tmp" "$RUNTIME_ROOT/current"
/bin/ln -s "releases/$INSTALL_SHA" "$RUNTIME_ROOT/.previous.tmp"
/bin/mv -f "$RUNTIME_ROOT/.previous.tmp" "$RUNTIME_ROOT/previous"

if [[ ! -f "$CONTROL_ROOT/dispatcher.token" ]]; then
  /usr/bin/openssl rand -hex 32 > "$CONTROL_ROOT/dispatcher.token.tmp"
  chmod 600 "$CONTROL_ROOT/dispatcher.token.tmp"
  /bin/mv "$CONTROL_ROOT/dispatcher.token.tmp" "$CONTROL_ROOT/dispatcher.token"
fi

if [[ ! -f "$CONFIG_ROOT/slack.env" && -f "$REPOSITORY_DIR/sources/slack/.env" ]]; then
  /bin/cp "$REPOSITORY_DIR/sources/slack/.env" "$CONFIG_ROOT/slack.env"
fi
if [[ ! -f "$CONFIG_ROOT/dispatcher.env" ]]; then
  /usr/bin/touch "$CONFIG_ROOT/dispatcher.env"
fi
chmod 600 "$CONFIG_ROOT/dispatcher.env"
if [[ -f "$CONFIG_ROOT/slack.env" ]]; then chmod 600 "$CONFIG_ROOT/slack.env"; fi

/bin/cp "$INSTALL_TMP/rendered/policy.json" "$CONTROL_ROOT/.policy.json.tmp"
chmod 600 "$CONTROL_ROOT/.policy.json.tmp"
/bin/mv "$CONTROL_ROOT/.policy.json.tmp" "$CONTROL_ROOT/policy.json"
for plist in dev.dona.updater dev.dona.dispatcher dev.dona.slack-adapter; do
  /bin/cp "$INSTALL_TMP/rendered/$plist.plist" "$LAUNCH_AGENTS_DIR/.$plist.plist.tmp"
  chmod 600 "$LAUNCH_AGENTS_DIR/.$plist.plist.tmp"
  /bin/mv "$LAUNCH_AGENTS_DIR/.$plist.plist.tmp" "$LAUNCH_AGENTS_DIR/$plist.plist"
done

print "immutable release、stable updater、policy、plistを配置しました。processは開始していません。"
print "設定を確認後、明示的に '$0 --bootstrap' を実行してください。"
