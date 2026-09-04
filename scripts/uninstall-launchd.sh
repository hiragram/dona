#!/bin/zsh
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DISPATCHER_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
SLACK_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist"
UPDATER_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.updater.plist"
DOMAIN="gui/$UID"

for label in dev.dona.slack-adapter dev.dona.dispatcher dev.dona.updater; do
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$label"
  fi
done

if [[ -f "$SLACK_PLIST" ]]; then mv "$SLACK_PLIST" "$HOME/.Trash/dev.dona.slack-adapter.plist"; fi
if [[ -f "$DISPATCHER_PLIST" ]]; then mv "$DISPATCHER_PLIST" "$HOME/.Trash/dev.dona.dispatcher.plist"; fi
if [[ -f "$UPDATER_PLIST" ]]; then mv "$UPDATER_PLIST" "$HOME/.Trash/dev.dona.updater.plist"; fi

print "Dona LaunchAgentsを停止し、plistをゴミ箱へ移動しました。"
print "app/update DB、immutable releases、results、logs、config、Keychain項目は保持しました。"
