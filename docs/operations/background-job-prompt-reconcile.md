# Background job prompt reconcile運用runbook

Dispatcherはbackground Codex workerへの最初のpromptを1回だけ送信する。Herdrのstatus待機が受理証拠を返さない場合も、prompt、Enter、job create、agent start、steer、cancelを再送せず、保存済みagent identityに対するstatus readとResult Envelope確認だけを行う。

## 時間契約

- `DONA_JOB_PROMPT_TIMEOUT_MS`: 最初のprompt status待機。既定30,000ms。
- `DONA_JOB_PROMPT_RECONCILE_MS`: 受理不明後の照合deadline。既定30,000ms。
- `DONA_JOB_PROMPT_RECONCILE_POLL_MS`: status readのtick間隔。既定5,000msで、照合deadline以下の正の整数が必要。
- `DONA_JOB_COMMAND_TIMEOUT_MS`: cancel、workspace、Updater等の汎用command timeout。prompt専用値を変更しても影響しない。

照合はmonotonic absolute deadlineを固定し、各status readを`min(poll interval, remaining)`で打ち切る。readが早く終わっても次のabsolute tickまで待つためbusy loopや処理時間による累積driftは生じない。既定の最大待機は、準備・process cleanup・DB/outbox処理を除き、prompt 30秒 + reconcile 30秒で概ね60秒となる。

## 観測と終端判断

| 観測 | 動作 |
| --- | --- |
| valid Result Envelope | Resultのstatusを保存する |
| 同一identityかつ`state_change_seq`進行 | 受理済みとして既存monitorへ進む。`blocked`は既存blocked処理へ進む |
| sequence不変 | 次のabsolute tickでread-only再観測する |
| read timeout、transport failure、agent not found | deadline内では単発で隔離せず再観測する |
| identity mismatch、sequence rollback、identity/sequence欠落 | 別agentやmalformed responseとして即時fail-closedにする |
| shutdown/abort | 最後にResultを確認し、なければ`prompt_interrupted`にする |
| deadline到達 | 最後にResultを1回確認し、観測理由を区別して`needs_review`にする |

## Operator対応

`needs_review`後に同じpromptや制御writeをblind retryしない。Result Envelope、Dispatcherのdurable job status、保存済みagent identityと監査情報をread-onlyで照合し、受理済みか不明なままなら人間判断へ送る。production sessionでfault injectionを行わず、isolated workspaceの決定的testでtimeout、agent消失・再出現、restart、deadline同時Result公開を検証してからrolloutを判断する。
