# Codex起動時のモデル設定

| 起動対象 | model | reasoning effort | 指定箇所 |
| --- | --- | --- | --- |
| `dona-main` | `gpt-6-sol` | `medium` | Updaterの`startMainAgent`、手動初期起動時のCodex引数 |
| 通常・schedule worker | `gpt-6-sol` | `low` | Dispatcherの`codexAgentArguments` |

Herdrの`agent start`の`--`以降へ`--model gpt-6-sol`と`-c 'model_reasoning_effort="medium"'`（workerは`low`）を渡します。ユーザーやprojectの暗黙defaultに依存させず、起動ごとに明示します。外部イベントやobjectiveからmodelやeffortを取り込みません。`npm run dev`はmain agentを作成しないため、手動初期起動でも同じ引数を指定してください。

変更は次に起動するsessionへ適用されます。既存sessionへのprompt、steer、復旧時のread-only照合でmodelを切り替えたり、agentを再生成したりしません。job ID、idempotency、workspace／Result隔離、MCP環境、更新確認の抑制、self-updateの承認・停止・readiness契約は維持します。この変更を含むUpdaterのrollback起動でもmain設定は同じです。旧Updater binary自体へ戻した場合は、そのbinaryの起動実装に従います。

## インターフェースと対応確認

2026-09-26にCodex CLI `0.157.0`の`--help`で`--model`とTOML形式の`-c`を確認しました。[公式config reference](https://learn.chatgpt.com/docs/config-file/config-reference)が`model_reasoning_effort`を定義し、[GPT-6 Solの公式モデル資料](https://developers.openai.com/api/docs/models/gpt-6-sol)は`gpt-6-sol`の`low`と`medium`対応を記載しています。

ローカルの独立したstdio App Serverで`initialize`、`initialized`、`config/read`、`model/list`だけを使用し、`gpt-6-sol`と両effortがeffective configとして返ること、およびモデル一覧の`supportedReasoningEfforts`に両方が含まれることを確認しました。App Serverでは`-c 'model="gpt-6-sol"' -c 'model_reasoning_effort="low"'`（mainの確認は`medium`）を使用します。[公式App Server資料](https://learn.chatgpt.com/docs/app-server)のとおり利用可能モデルとeffortはclient／accountに依存するため、環境変更時は`model/list`で再確認してください。未対応なら別モデルへ自動代替せず対応環境を整えます。

この照会ではthread／turnを開始せず、推論の成功や本番sessionへの反映を検証したものではありません。Donaの起動経路は引き続きHerdr + Codex CLIであり、App Serverへの移行は行いません。

## 回帰テスト

- `dispatcher/test/job-runtime.test.ts`: scratch／GitHub、通常／schedule、progress無効時の設定、およびfake Herdrへ実際に渡るargvを検証します。
- `updater/test/runtime-adapter.test.ts`: mainの再生成でHerdrへ渡すargv全体と、既存の環境・cwd・readinessを検証します。

```sh
cd dispatcher && node --import tsx --test test/job-runtime.test.ts
cd ../updater && node --import tsx --test test/runtime-adapter.test.ts
```
