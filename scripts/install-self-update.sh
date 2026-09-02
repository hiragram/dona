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

if [[ "$MODE" != "--check" && "$MODE" != "--install" && "$MODE" != "--bootstrap" ]]; then
  print -u2 "Usage: $0 --check | --install | --bootstrap"
  print -u2 -- "--checkはtemplateのみ検証し、--installはrelease/config/plistを配置し、--bootstrapだけがlaunchctlを操作します。"
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
  print -u2 -- "--installは非rootのmacOS GUI userだけで実行できます。"
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
if [[ -e "$CONTROL_ROOT/updater" ]]; then
  print -u2 "stable updaterは既にinstall済みです。updater自身の上書き更新は実施しません。"
  exit 1
fi

umask 077
mkdir -p "$CONTROL_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT" "$LAUNCH_AGENTS_DIR"
chmod 700 "$BASE_DIR" "$CONTROL_ROOT" "$RUNTIME_ROOT" "$RELEASE_ROOT" "$RELEASE_ROOT/.staging" "$CONFIG_ROOT" "$LOG_ROOT"
STAGING_DIR=$(mktemp -d "$RELEASE_ROOT/.staging/install.XXXXXX")
$GIT_PATH -C "$REPOSITORY_DIR" archive --format=tar --output="$INSTALL_TMP/release.tar" "$INSTALL_SHA"
/usr/bin/tar -xf "$INSTALL_TMP/release.tar" -C "$STAGING_DIR"

mkdir -p "$INSTALL_TMP/npm-cache"
for component in dispatcher sources/slack updater; do
  COMPONENT_DIR="$STAGING_DIR/$component"
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=1 NO_COLOR=1 npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_audit=false npm_config_fund=false \
    npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null npm_config_update_notifier=false \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" ci
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" test
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" run typecheck
  env -i PATH="$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/bin:/bin:/usr/sbin:/sbin" CI=1 NO_COLOR=1 \
    npm_config_cache="$INSTALL_TMP/npm-cache" npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
    "$NPM_PATH" --prefix "$COMPONENT_DIR" run build
done
NPM_VERSION=$($NPM_PATH --version)
$NODE_PATH "$SCRIPT_DIR/write-release-manifest.mjs" "$STAGING_DIR" "$INSTALL_SHA" "$NPM_VERSION" "2026-09-02.1"
FINAL_RELEASE="$RELEASE_ROOT/$INSTALL_SHA"
if [[ -e "$FINAL_RELEASE" ]]; then
  print -u2 "release $INSTALL_SHA は既に存在します。上書きしません。"
  exit 1
fi
/bin/mv "$STAGING_DIR" "$FINAL_RELEASE"

/usr/bin/ditto "$FINAL_RELEASE/updater" "$CONTROL_ROOT/updater.next"
/bin/mv "$CONTROL_ROOT/updater.next" "$CONTROL_ROOT/updater"
find "$FINAL_RELEASE" -type f -exec chmod 400 {} +
find "$FINAL_RELEASE" -type d -exec chmod 500 {} +

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
