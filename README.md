# Dona

Donaは、外部イベントを1つの秘書エージェントへ安全に直列投入するためのローカル実行基盤です。

```text
Slack Socket Mode -> sources/slack Adapter -> UDS HTTP -> dispatcher -> SQLite -> Herdr dona-main
                                                         dona-main -> sources/slack MCP -> Slack Web API
```

- [`dispatcher/`](./dispatcher/README.md): 永続キュー、重複排除、単一worker、Herdr連携、結果回収、運用CLI
- [`sources/slack/`](./sources/slack/README.md): Socket Mode Adapterと、同じKeychain認証を使う別プロセスのstdio MCP

Slack AdapterはHerdrやSQLiteを直接操作しません。Dispatcherからエージェントへの入口は一方向です。エージェントがSlack操作を選んだ場合は、別プロセスのDona Slack MCPを使います。

## 開発時の起動

依存関係のインストールは初回だけ各パッケージで行います。

```sh
npm --prefix dispatcher install
npm --prefix sources/slack install
```

以降はリポジトリのルートから1コマンドで起動できます。

```sh
npm run dev
```

開発ランチャーはDispatcherを先に起動し、readyを確認してからSlack Adapterを起動します。`Ctrl+C`、またはどちらか一方の終了時には両方を停止します。プロセス自体は分離されたままです。

Herdrの`dona`セッション内には、事前に`dona-main`という名前のCodexエージェントを起動してください。詳細な設定、疎通方法、復旧コマンドは各ディレクトリのREADMEにあります。

`npm run dev`が起動するのはDispatcherとAdapterだけです。stdio MCPは[`.codex/config.toml`](./.codex/config.toml)を読んだCodexが必要に応じて起動します。

## launchdで常駐

両パッケージの設定とKeychain登録をターミナル起動で確認した後に実行します。

```sh
./scripts/install-launchd.sh
```

停止・登録解除:

```sh
./scripts/uninstall-launchd.sh
```

解除スクリプトはplistをゴミ箱へ移しますが、SQLite、結果、ログ、Keychain項目は削除しません。
