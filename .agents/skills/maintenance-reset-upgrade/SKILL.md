---
name: maintenance-reset-upgrade
description: Donaの既存DB履歴を引き継がず、独立した新世代へ保守reset / upgradeする計画・実行・再開を支援する。通常self-updateや既存DBの個別回復には使わない。
---

# Dona保守reset / upgrade

このSkillは世代切替の判断を助けるもので、production、service、DB、workerへの操作を許可しない。現在の依頼で許された範囲を確認し、実行の詳細と正しいコマンドは[保守runbook](../../../docs/operations/maintenance-reset-upgrade.md)と現行の`scripts/maintenance/reset_upgrade.py`を読む。古いplanやこのSkillだけを実行契約にしない。

## 適用境界

既存DBの履歴を継がず、DonaのDispatcher・Slack adapter・Updaterを独立した新世代へ切り替えるときに使う。通常のself-updateは`plan_self_update`とexact plan承認・`apply_self_update`の経路を使う。既存DB内の個別job、通知、Resultの回復やreconciliationをこの切替の条件・成果に混ぜない。旧履歴の問題は旧世代に残る。

## 準備と実行の判断

- `prepare`はcanonical mainのexact SHA、required CI・署名、元のplist・設定・pointer・writer、容量余裕、新世代のbuild・DB・設定を調べ、planと成果をsealする。準備だけでは本番を止めない。prepare後の元設定やsealのdriftは再準備の判断に戻す。
- 旧DB・Result・release・設定はその場に保持する。WALを含む整合snapshotは`--snapshot-old-databases`を明示した場合だけ作る。snapshotはDB間の同時刻transactionや旧worker停止の証明ではない。旧pathを新世代へ再利用・転送せず、新DB、Result、socketを分離する。
- 本番実行の前に、委任job、元event、親の完了通知eventが所定のterminal状態であることと、親のhandoff receiptを確認する。親は最終Job Resultを先に公開・検証してからreceiptを作り、自身のEvent Result公開後に独立runnerが進められるよう`arm`する。限定的な`needs_review / timeout`受理はrunbookのResult hash・同一会話・時刻条件を満たす場合だけ使う。receiptのoperator assertionやidle/done観測を旧workerの完全停止証明と呼ばない。
- `arm`の受理を確認し、terminal barrier成立後にsealed runnerの`execute`へ進む。旧Slackのquiesceとdrain、3サービスの停止・identity確認、旧設定とpointerの再照合を経て、新Dispatcher、mainと両MCP、Slack ingress、最後にUpdaterの順でreadinessを確認する。`probe-mcp`は停止前の補助検査であり、新mainからの接続確認の代わりにはならない。
- 成功判定はjournalと現行process、Herdr登録、exact SHA、MCP child、health、pointer・設定のread-backで行う。`succeeded`はサービス切替の確認であり、Slack投稿や新mainのevent処理成功までは示さない。

## 曖昧応答と復旧

外部writeのtimeout・切断はblind retryしない。journal、receipt、登録状態、process identity、healthをread-onlyで照合し、受理不明と確定拒否を区別する。元のmain handoff開始前の失敗だけ、旧DBを上書きせず保持した旧世代へのrollbackを検討する。`awaiting_main`以後は新世代DBを保持して`forward_recovery`し、同じrunの`execute`で照合・再開する。`activation_committed`以後はcoreを維持してUpdaterだけを収束させる。各phaseの意味と`restore`の可否はrunbookとjournalで確認する。

別世代のDB、Result、socket、workerの状態を混ぜない。旧workerの遅延writeは旧世代へ残り得るため、見かけ上のname不在やidle/doneから停止・再生成なしを推定しない。
