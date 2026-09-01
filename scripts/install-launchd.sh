#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_DIR=${SCRIPT_DIR:h}
DISPATCHER_DIR="$REPO_DIR/dispatcher"
SLACK_DIR="$REPO_DIR/sources/slack"
NODE_PATH=$(command -v node)
HERDR_PATH=$(command -v herdr)
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DONA_DIR="$HOME/Library/Application Support/Dona"
LOG_DIR="$DONA_DIR/logs"
DISPATCHER_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.dispatcher.plist"
SLACK_PLIST="$LAUNCH_AGENTS_DIR/dev.dona.slack-adapter.plist"
DOMAIN="gui/$UID"

if [[ ! -f "$SLACK_DIR/.env" ]]; then
  print -u2 "Missing $SLACK_DIR/.env. Copy .env.example and configure it first."
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
chmod 700 "$DONA_DIR" "$LOG_DIR"

npm --prefix "$DISPATCHER_DIR" ci
npm --prefix "$DISPATCHER_DIR" run build
npm --prefix "$SLACK_DIR" ci
npm --prefix "$SLACK_DIR" run build

escape_xml() {
  print -r -- "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

NODE_XML=$(escape_xml "$NODE_PATH")
DISPATCHER_XML=$(escape_xml "$DISPATCHER_DIR")
SLACK_XML=$(escape_xml "$SLACK_DIR")
LOG_XML=$(escape_xml "$LOG_DIR")
HERDR_XML=$(escape_xml "$HERDR_PATH")

cat > "$DISPATCHER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.dona.dispatcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$DISPATCHER_XML/dist/cli.js</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$DISPATCHER_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DONA_HERDR_PATH</key><string>$HERDR_XML</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_XML/dispatcher.log</string>
  <key>StandardErrorPath</key><string>$LOG_XML/dispatcher.error.log</string>
</dict>
</plist>
PLIST

cat > "$SLACK_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.dona.slack-adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$SLACK_XML/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$SLACK_XML</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_XML/slack-adapter.log</string>
  <key>StandardErrorPath</key><string>$LOG_XML/slack-adapter.error.log</string>
</dict>
</plist>
PLIST

chmod 600 "$DISPATCHER_PLIST" "$SLACK_PLIST"
plutil -lint "$DISPATCHER_PLIST" "$SLACK_PLIST"

launchctl bootout "$DOMAIN" "$DISPATCHER_PLIST" 2>/dev/null || true
launchctl bootout "$DOMAIN" "$SLACK_PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DISPATCHER_PLIST"
launchctl bootstrap "$DOMAIN" "$SLACK_PLIST"

print "Installed and started dev.dona.dispatcher and dev.dona.slack-adapter"
print "Logs: $LOG_DIR"
