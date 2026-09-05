# Dona

Donaは、外部イベントを1つの秘書エージェントへ安全に直列投入するためのローカル実行基盤です。

```text
Slack Socket Mode -> sources/slack Adapter -> UDS HTTP -> dispatcher -> SQLite -> Herdr dona-main
                                                         dona-main -> sources/slack MCP -> Slack Web API
                                                         dona-main -> dispatcher MCP -> background Codex jobs
                                                         dona-main -> dispatcher MCP -> stable updater
stable updater -> immutable release -> ordered restart -> dona_update completion -> dispatcher
```

- [`dispatcher/`](./dispatcher/README.md): 永続キュー、`dona-main`への直列投入、バックグラウンドJob supervisor、別プロセスのstdio MCP
- [`sources/slack/`](./sources/slack/README.md): Socket Mode Adapterと、同じKeychain認証を使う別プロセスのstdio MCP
- [`updater/`](./updater/README.md): 更新対象から独立したstable controller、専用SQLite/outbox、immutable release、activation/rollback
- [External event ingress contract](./docs/external-event-ingress.md): raw-byte認証、source登録、durable receipt、ACK gate、互換matrix

Slack AdapterはHerdrやSQLiteを直接操作しません。Dispatcherからエージェントへの入口は一方向です。エージェントがSlack操作を選んだ場合は、別プロセスのDona Slack MCPを使います。

## 開発時の起動

依存関係のインストールは初回だけ各パッケージで行います。

```sh
npm --prefix dispatcher install
npm --prefix sources/slack install
npm --prefix updater install
```

以降はリポジトリのルートから1コマンドで起動できます。

```sh
npm run dev
```

開発ランチャーはDispatcherを先に起動し、readyを確認してからSlack Adapterを起動します。`Ctrl+C`、またはどちらか一方の終了時には両方を停止します。プロセス自体は分離されたままです。

Herdrの`dona`セッション内には、事前に`dona-main`という名前のCodexエージェントを起動してください。詳細な設定、疎通方法、復旧コマンドは各ディレクトリのREADMEにあります。

`npm run dev`が起動するのはDispatcherとAdapterだけです。Slack MCPとDispatcher MCPのstdioプロセスは[`.codex/config.toml`](./.codex/config.toml)を読んだCodexが必要に応じて起動します。

## Production self-update / launchd

初回導入は[runbook](./docs/self-update-runbook.md)に従います。`--check`はtemp directory内のpolicy/plist検証だけです。

```sh
./scripts/install-self-update.sh --check
./scripts/install-self-update.sh --install
# maintenance windowで内容を確認後だけ
./scripts/install-self-update.sh --bootstrap
```

`--install`はprocessを停止・開始せず、`--bootstrap`だけがlaunchctlを操作します。routine updateではplistを書き換えず、stable updaterが`dona-main`をdrainして同じHerdr paneへtarget releaseのCodexを再生成し、`runtime/current` pointerとDispatcher/Slack Adapterを切り替えます。旧`install-launchd.sh`はdeveloper checkoutを直接起動するlegacy互換用です。

設計と復旧:

- [Self-update architecture](./docs/self-update-architecture.md)
- [Self-update運用runbook](./docs/self-update-runbook.md)

updater自身はroutine updateの対象外です。stable updater/policy/schemaの更新には、非terminal requestを拒否し、旧DBとfilesをbackupして新旧version healthを照合する`./scripts/install-self-update.sh --upgrade-control`をmaintenance windowで使います。app DB schema migrationとGitHub repository settings変更は対象外です。

## 全体検証

```sh
npm run verify
```
