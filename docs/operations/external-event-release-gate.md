# External Events release gate

この手順はGitHub、Notion、Figma、Google Driveのingressを、共通contract・security・運用境界を含む1つのrelease candidateとして判定する。CIやfake E2Eの成功をlive smoke成功とは扱わない。

## read-only evidence

`dona-dispatcher external-events health`または`GET /v1/external-events/health`を使う。出力は登録済みconnectionごとのstate、queue depth/lag、dead letter、subscription expiry/renewal unknown、cursor version、last delivery/reconcile/errorと、source/connection/outcome/固定latency bucketのingress集計を返す。credential参照、cursor token、provider本文、callback URLは返さない。未認証requestは任意のconnection labelを作れず、`unattributed`へ集約する。

判定時は次を保存する。

- candidate SHA、base SHA、CI run、fixture E2E結果
- 各connectionの`active` / `degraded` / `disabled`、queue/backpressure、cursor version、subscription expiry、last success/error
- duplicate/conflict、auth failure、ACK結果、dead letterとrecovery後の再観測
- `integrity_check`、`foreign_key_check`、migration/read compatibilityの結果

`ready: false`、`renewal_unknown`、dead letter、増加し続けるlag、停止したcursor、古いlast reconcileのいずれかがあればreleaseを止める。labelはsource、登録済みconnection、固定outcome/state/bucketだけに限定し、resource IDやdelivery IDをmetric labelへ追加しない。

## deterministic fake/fault gate

repository rootの`npm run verify`は、provider別fixtureのauth→normalize→commit→ACK、duplicate/conflict、queue fairness、cursor/subscription、restartとSQLite競合を検証する。release evidenceでは次のfaultを対応する既存test名と結び付ける。

| fault | 期待結果 |
| --- | --- |
| auth failure / credential revoke | non-2xx、event未作成、connection degradedまたはquarantine |
| DB busy/crash | ACKしない、transaction外のpartial stateなし |
| commit後response loss | receiptをread-only照合し、同じwriteをblind retryしない |
| duplicate / out-of-order / renew overlap | 同一identityへ収束、binding不一致は拒否 |
| queue saturation / burst | non-ACKまたはbounded queue、source/connection fairness維持 |
| cursor invalid / fetch 429・5xx | cursorをblind jumpせずretryまたはreconciliationへ隔離 |
| clock rewind / expiry | dispatch拒否、stored high-waterを維持 |
| shutdown / drain | 新規claimを止め、in-flightとunsafe stateをread-only確認 |

自動scanではResult、prompt、DBのprojection、health JSON、構造化logを対象に、fixture secret、raw credential、passcode/token、private callback URL、不要なprovider contentが含まれないことを確認する。ingress packageが公開するprovider clientはread-only allowlistに限定し、comment/update/file mutation、汎用tool dispatch、認証成功から派生するoutbound capabilityがないことをcode reviewとcontract testで確認する。

## incident and recovery

unknown/ambiguous acceptanceでは同じ外部writeを再実行しない。まずreceipt、delivery identity、provider公式history、queue/health、cursor、subscription generationをread-onlyで照合する。確定できない場合は`needs_review`のまま人間へ引き継ぐ。restart後はstale claim、provider fetch phase、renew operation、cursor versionを確認し、安全と証明されたpre-send failureだけを通常retryへ戻す。

## live smoke（別工程・明示権限が必要）

各providerで隔離test resourceを1件用い、最小read-only credentialで実配送する。receiptにはexternal delivery/subscription identity、provider側HTTP履歴、Dispatcher event/Result、queue/health、cleanup/reconcile状態を記録する。providerへのbusiness writeは0件とする。

このrepositoryのfixture/CIだけではGitHub、Notion、Figma、Driveのlive smoke、public TLS endpoint、credential revoke、provider console/historyを検証できない。認証情報や明示権限がない場合は全providerを「未検証」と記録し、成功、production-ready、Epic closeを主張しない。

## integration handoff

Issue #56の実装PRは`feature/external-event-sources`向けとし、integration PR #47は別のmerge判断である。実provider receiptが未検証なら、その境界をPR evidenceに残す。production rollout、credential登録・変更、provider resource作成/renew/stop、integration PR mergeはこの手順から実行しない。
