#!/bin/zsh
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DISPATCHER_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
SLACK_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist"
DOMAIN="gui/$UID"

launchctl bootout "$DOMAIN" "$SLACK_PLIST" 2>/dev/null || true
launchctl bootout "$DOMAIN" "$DISPATCHER_PLIST" 2>/dev/null || true

if [[ -f "$SLACK_PLIST" ]]; then mv "$SLACK_PLIST" "$HOME/.Trash/dev.dona.slack-adapter.plist"; fi
if [[ -f "$DISPATCHER_PLIST" ]]; then mv "$DISPATCHER_PLIST" "$HOME/.Trash/dev.dona.dispatcher.plist"; fi

print "Stopped Dona launch agents and moved their plist files to Trash."
print "Database, results, logs, and Keychain items were preserved."
