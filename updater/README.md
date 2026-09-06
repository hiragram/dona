# Dona stable updater

`updater/`は、更新対象releaseとは別のcontrol slotから動くself-update controllerです。DispatcherやSlack Adapterのmoduleをimportせず、専用SQLite、固定policy、Git/npm/Filesystem/launchctl/healthのtyped portだけを所有します。updater自身の自動更新は初期版の対象外です。

## 更新経路

```text
plan_self_update
  -> fixed origin/mainのexact SHA・GitHub Actions checks・互換性metadataを検証
  -> plan hashを専用SQLiteへ保存
  -> 人間がexact planを承認
apply_self_update
  -> 元Slack受付eventのcompleted barrierを待つ
  -> isolated checkoutで3 packageのnpm ci/test/typecheck/build
  -> immutable releases/<sha>をpublish
  -> Slack Adapterのingressを止め、Dispatcherをstop-after-currentでdrain
  -> Herdr上のdona-mainがidle/doneになったことを確認して同じpaneのCodexを終了
  -> previous/current pointerをsame-filesystem renameで切替
  -> target releaseを明示的にtrustしたCodexを同じpaneへdona-mainとして起動
  -> Dispatcher、Slack Adapterの順にstartしtarget SHA healthを検証
  -> stable outboxからinternal dona_update eventを新Dispatcherへ配送
```

状態は`requested / planning / awaiting_approval / approved / preparing / staged / quiescing / activating / restarting / verifying / succeeded / failed / rolling_back / rolled_back / needs_review / cancelled`を明示します。外部command前にruntime intentを保存し、timeoutやlaunchctl応答喪失はbounded read-only reconcileへ移します。同じwriteを再送せず、期限内にprocess/session/version healthを証明できない場合だけ`needs_review`にします。自動rollbackは、target由来のwrong SHAがlocal healthで確認でき、previousのprotocol/config/app schemaが双方向互換で、circuit breaker内の場合に1回だけです。

## 固定policy

生成例は[`config/update-policy.example.json`](../config/update-policy.example.json)です。public APIは`source_event_id`、`request_id`、`plan_id`、`plan_hash`、`approval_id`だけを受け、repository URL、ref、path、command、npm flag、launchctl argument、environmentを受けません。

policyは次を固定します。

- `hiragram/dona`、HTTPS canonical remote、`main`
- stable control root、release/current/previous、0600 config root、UDS、internal token file
- `dev.dona.dispatcher`と`dev.dona.slack-adapter`
- fixed Herdr session `dona`、agent名`dona-main`、minimum Herdr version
- absolute `git/npm/node/gh/herdr/launchctl`
- timeout、output上限、disk floor、retention
- expected GitHub Actions check 3件と、任意のcommit signature gate
- protocol/config/app schema read/write range

candidate自身の[`config/release-compatibility.json`](../config/release-compatibility.json)をexact SHAからplan時に読み、staging checkoutでも再照合します。このbridgeはschema v2〜v3をreadしつつwrite schema 2を維持します。activation releaseはbridgeの実稼働exact SHAを祖先として別途検証し、live WAL DB fileの単体copyをbackup扱いしません。

## APIとCLI

常駐processは`<control_root>/updater.sock`にtyped UDS APIを公開します。通常のplan/apply/status/cancelはDispatcher MCP経由で使います。

local operator CLI:

```sh
node dist/cli.js status [upd_...]
node dist/cli.js doctor
node dist/cli.js reconcile upd_...
node dist/cli.js rollback upd_... --confirm-plan-hash <64-hex>
```

operator rollbackは`needs_review`かつcurrent=exact target、previous=planned current、互換性ありの場合、plan hash一致の場合だけ再開します。`/metrics`はstate別件数とpending outbox数を出します。statusはlease/fence、attempt、activation generation、restart回数、SHA、health、last error、audit、runtime operations、runtime/notification state、outboxを返します。

## 検証

```sh
npm ci
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

testはtemporary SQLite/release root、isolated temporary Git remote、fake runtime/Dispatcher/Herdr responseを使います。Codexへ渡すMCP environmentは固定config pathだけで、token値をargvへ載せないことも検証します。実GitHub、Slack、Keychain、production LaunchAgent、live processは操作しません。

## Stable control-plane更新

stable updater自身はroutine updateに含めません。policy/schema変更はmaintenance windowで`./scripts/install-self-update.sh --upgrade-control`を使い、非terminal requestがないこと、旧DB checkpoint/integrity/backup、新旧version healthを確認して切り替えます。Slack完了通知のidentityはmessage blockで照合するため、外部manifest attestationは不要です。app DB migrationとGitHub repository settings変更は対象外です。
