#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPOSITORY_DIR=${SCRIPT_DIR:h}
MODE=${1:-}
BASE_DIR="$HOME/Library/Application Support/Dona"
CONTROL_ROOT="$BASE_DIR/update-control"
RUNTIME_ROOT="$BASE_DIR/runtime"
RELEASE_ROOT="$RUNTIME_ROOT/releases"
CONFIG_ROOT="$BASE_DIR/config"
LOG_ROOT="$BASE_DIR/logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$UID"
CONTROL_UPGRADE_ACTIVE=0
CONTROL_SWAPPED=0
CONTROL_BACKUP_ROOT=""

restore_control_plane() {
  if [[ "$CONTROL_UPGRADE_ACTIVE" != "1" || -z "$CONTROL_BACKUP_ROOT" ]]; then return 0; fi
  if /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/dev.dona.updater" >/dev/null 2>&1 || true
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
  fi
  if ! /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" >/dev/null 2>&1; then
    print -u2 "旧stable updaterをlaunchdへ再登録できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  if [[ -n "${OLD_UPDATER_SHA:-}" ]] && \
    ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha \
      "$CONTROL_ROOT/updater.sock" "$OLD_UPDATER_SHA" 30000; then
    print -u2 "旧stable updaterの復旧healthを確認できません。backup: $CONTROL_BACKUP_ROOT"
    return 1
  fi
  return 0
}

if [[ "$MODE" != "--check" && "$MODE" != "--install" && "$MODE" != "--bootstrap" && "$MODE" != "--upgrade-control" ]]; then
  print -u2 "Usage: $0 --check | --install | --bootstrap | --upgrade-control"
  print -u2 -- "--checkはtemplateのみ検証し、--installは初期配置、--bootstrapは初回起動、--upgrade-controlは停止確認付きでstable control-planeを更新します。"
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
  restore_control_plane || true
  if [[ -n "${STAGING_DIR:-}" ]]; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" cleanup-staging "$RELEASE_ROOT" "$STAGING_DIR" || \
      print -u2 "staging directoryのcleanupに失敗しました。"
  fi
  if [[ -n "${INSTALL_TMP:-}" && -d "$INSTALL_TMP" && "$INSTALL_TMP" == *dona-self-update-install.* ]]; then
    rm -rf "$INSTALL_TMP"
  fi
}
trap cleanup_temp EXIT

$NODE_PATH "$SCRIPT_DIR/render-self-update-templates.mjs" "$INSTALL_TMP/rendered" "$INSTALL_SHA"
/usr/bin/plutil -lint "$INSTALL_TMP/rendered/dev.dona.updater.plist" \
  "$INSTALL_TMP/rendered/dev.dona.dispatcher.plist" \
  "$INSTALL_TMP/rendered/dev.dona.slack-adapter.plist"
$NODE_PATH -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$INSTALL_TMP/rendered/policy.json"

if [[ "$MODE" == "--check" ]]; then
  print "self-update policyと3つのLaunchAgent templateは有効です。実環境は変更していません。"
  exit 0
fi

if [[ "$MODE" == "--bootstrap" ]]; then
  for plist in dev.dona.updater dev.dona.dispatcher dev.dona.slack-adapter; do
    if [[ ! -f "$LAUNCH_AGENTS_DIR/$plist.plist" ]]; then
      print -u2 "Missing $LAUNCH_AGENTS_DIR/$plist.plist. Run --install first."
      exit 1
    fi
  done
  if ! /bin/launchctl print "$DOMAIN/dev.dona.dispatcher" >/dev/null 2>&1; then
    $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$BASE_DIR/run/dispatcher.sock"
  fi
  if ! /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist"
  fi
  if /bin/launchctl print "$DOMAIN/dev.dona.slack-adapter" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/dev.dona.slack-adapter"
  fi
  if /bin/launchctl print "$DOMAIN/dev.dona.dispatcher" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/dev.dona.dispatcher"
  fi
  /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
  /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist"
  print "stable updater、Dispatcher、Slack Adapterを順序付きでbootstrapしました。"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" || "$UID" == "0" ]]; then
  print -u2 -- "--installと--upgrade-controlは非rootのmacOS GUI userだけで実行できます。"
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
$NODE_PATH -e '
const runs = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).check_runs ?? [];
for (const name of ["Verify dispatcher", "Verify sources/slack", "Verify updater"]) {
  if (!runs.some((run) => run.name === name && run.status === "completed" && run.conclusion === "success" && run.app?.slug === "github-actions")) {
    throw new Error(`Required trusted check is not successful: ${name}`);
  }
}' "$INSTALL_TMP/check-runs.json"
if [[ "$MODE" == "--install" && -e "$CONTROL_ROOT/updater" ]]; then
  print -u2 "stable updaterは既にinstall済みです。updater自身の上書き更新は実施しません。"
  exit 1
fi
if [[ "$MODE" == "--upgrade-control" && ! -d "$CONTROL_ROOT/updater" ]]; then
  print -u2 "stable updaterが未導入です。先に--installと--bootstrapを実行してください。"
  exit 1
fi
if [[ "$MODE" == "--upgrade-control" ]]; then
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-slack-metadata-attested "$CONFIG_ROOT/slack.env"
fi

umask 077
mkdir -p "$CONTROL_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT" "$LAUNCH_AGENTS_DIR"
chmod 700 "$BASE_DIR" "$CONTROL_ROOT" "$RUNTIME_ROOT" "$RELEASE_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT"
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
FINAL_RELEASE="$RELEASE_ROOT/$INSTALL_SHA"
if [[ -e "$FINAL_RELEASE" ]]; then
  if [[ "$MODE" != "--upgrade-control" ]] || \
    ! $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" validate-existing-release \
      "$FINAL_RELEASE" "$STAGING_DIR" "$INSTALL_SHA"; then
    print -u2 "release $INSTALL_SHA は既に存在し、今回のmodeでは再利用できません。上書きしません。"
    exit 1
  fi
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" cleanup-staging "$RELEASE_ROOT" "$STAGING_DIR"
  STAGING_DIR=
  print "既存の検証済みimmutable release $INSTALL_SHA をcontrol-plane更新に再利用します。"
else
  /bin/mv "$STAGING_DIR" "$FINAL_RELEASE"
  STAGING_DIR=

  find "$FINAL_RELEASE" -type f -exec chmod 400 {} +
  find "$FINAL_RELEASE" -type d -exec chmod 500 {} +
fi

if [[ "$MODE" == "--upgrade-control" ]]; then
  UPDATER_SOCKET="$CONTROL_ROOT/updater.sock"
  if ! /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
    print -u2 "dev.dona.updaterがlaunchd管理下で起動していないため、安全に更新できません。"
    exit 1
  fi
  OLD_UPDATER_SHA=$($NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-control-upgrade-safe "$UPDATER_SOCKET")
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
  chmod 600 "$BACKUP_ROOT/policy.next.json" "$BACKUP_ROOT/dev.dona.updater.next.plist"

  CONTROL_UPGRADE_ACTIVE=1
  if ! /bin/launchctl bootout "$DOMAIN/dev.dona.updater"; then
    if /bin/launchctl print "$DOMAIN/dev.dona.updater" >/dev/null 2>&1; then
      print -u2 "stable updaterの停止受理を確認できません。fileは切り替えていません。"
      CONTROL_UPGRADE_ACTIVE=0
      exit 1
    fi
  fi
  $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" assert-socket-unused "$UPDATER_SOCKET"
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
  if [[ -f "$CONTROL_ROOT/updater.sqlite3" ]]; then
    /usr/bin/sqlite3 "$CONTROL_ROOT/updater.sqlite3" "PRAGMA wal_checkpoint(TRUNCATE);"
    /bin/cp "$CONTROL_ROOT/updater.sqlite3" "$BACKUP_ROOT/updater.previous.sqlite3"
    SQLITE_INTEGRITY=$(/usr/bin/sqlite3 "$BACKUP_ROOT/updater.previous.sqlite3" "PRAGMA integrity_check;")
    if [[ "$SQLITE_INTEGRITY" != "ok" ]]; then
      print -u2 "updater database backupのintegrity checkに失敗しました。"
      exit 1
    fi
    chmod 600 "$BACKUP_ROOT/updater.previous.sqlite3"
  else
    /usr/bin/touch "$BACKUP_ROOT/updater.database-was-absent"
    chmod 600 "$BACKUP_ROOT/updater.database-was-absent"
  fi
  CONTROL_SWAPPED=1
  /bin/mv "$CONTROL_ROOT/updater" "$BACKUP_ROOT/updater.previous"
  /bin/mv "$BACKUP_ROOT/updater.next" "$CONTROL_ROOT/updater"
  /bin/mv "$BACKUP_ROOT/policy.next.json" "$CONTROL_ROOT/policy.json"
  /bin/mv "$BACKUP_ROOT/dev.dona.updater.next.plist" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist"

  /bin/launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/dev.dona.updater.plist" >/dev/null 2>&1 || true
  if $NODE_PATH "$SCRIPT_DIR/self-update-install-preflight.mjs" wait-updater-sha "$UPDATER_SOCKET" "$INSTALL_SHA" 30000 3; then
    CONTROL_UPGRADE_ACTIVE=0
    print "stable updaterとpolicyを${INSTALL_SHA}へ更新し、version healthを確認しました。"
    print "次に通常updateをplan/applyして、DispatcherとSlack Adapterを同じreleaseへ切り替えてください。"
    exit 0
  fi

  print -u2 "新しいstable updaterのversion healthを確認できないため、control-planeを復旧します。"
  if ! restore_control_plane; then
    CONTROL_UPGRADE_ACTIVE=0
    print -u2 "control-planeの自動復旧を安全に完了できません。backup: $BACKUP_ROOT"
    exit 1
  fi
  CONTROL_UPGRADE_ACTIVE=0
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
