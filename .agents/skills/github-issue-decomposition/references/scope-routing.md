# Scope routing contract

GitHub Issueの作成・更新依頼では、希望されたIssue数や表面的な変更量より先に、成果、責務、検証、failure boundaryを調べてrouteを決める。

## 判定順序

1. 依頼された成果とrepositoryの既存ownershipを特定する。
2. 独立してreview・testできる責務、API/data/runtime/運用境界、migration/rollout、failure/recovery contract、並行可能性を列挙する。
3. 構造化条件が1つでも実質的に存在する場合は、**構造化Issue**を選ぶ。
4. 構造化条件がなく、単一Issue条件をすべて満たす場合だけ、**単一Issue**を選ぶ。
5. read-only調査後も判定に必要な事実が不足する場合は、曖昧なままwriteせず、判定を変える質問だけを行う。

## 単一Issueの条件

以下をすべて満たす。

- 完了時に1つのcohesiveな成果が得られる。
- 主責務とownerが1つである。
- 単独のreview単位でacceptanceと必要なtestを実証できる。
- 別ownership、独立したdata migration、段階的rollout、別のfailure/recovery contractを内部に隠さない。

小さなbugでも、security境界やmigrationが独立成果として必要なら自動的に単一Issueとはしない。逆に変更fileが複数でも、1つの責務を1つのreviewで実証できるならfile数だけを理由に分解しない。

## 構造化Issueの条件

以下のいずれかが実質的に存在する。

- 独立したacceptanceとtestを持つ責務が複数ある。
- API、data、runtime、UI、security、運用など複数ownershipへまたがる。
- 共通artifactの確定後に並行できるlaneがある。
- 複数PRとして個別にreview・mergeし得る成果がある。
- failure、ambiguity、restart、recovery contractを別々に所有すべき境界がある。
- 独立したmigrationまたはrolloutがあり、通常実装へ埋め込むと安全性やrollback条件が不明瞭になる。

構造化Issueでは、1件の親Epic、review可能なnative sub-issues、未解決判断に限るDecision/ADR、直接の技術的前提だけからなる最小blocker DAGを設計する。

## 出力数と規模を分離する

「Issueを1件作って」は依頼者が想定する出力形であり、scopeの事実ではない。調査結果が構造化条件を満たす場合は、希望数だけを理由に独立責務を1件へ押し込まず、判定理由と必要な構成を示してwrite前に整合させる。

行数、file数、担当者数、見積りpointの単一閾値も使わない。判定根拠は、成果、ownership、review/test可能性、failure/recovery、migration/rolloutで説明する。

## Routing例

### 小さな単一bug

同じparserの1つのvalidation branchが誤ったerror codeを返し、既存fixtureに1 caseを追加すれば単独で再現・修正・reviewできる。別schema、consumer、rollout、recovery contractはない。

**判定:** 単一Issue。bugの再現、期待error、修正境界、regression testを[単一Issue contract](issue-contract.md#単一issueの記述)へ記載する。

### 1 source eventから複数jobを安全に委任する

`job_key`付きAPI/MCP idempotency、SQLite migration、quota/fair scheduling、group completion/Agent Session、caller follow-up、段階rollout/E2Eがそれぞれ独立したacceptance、failure、recovery contractを持つ。

**判定:** 構造化Issue。cohesiveな成果は1つでも、複数ownershipとparallel lane、独立migration/rollout、複数PR相当のreview単位がある。

### 「Issueを1件」と指定された複数責務theme

依頼文は1件を希望しているが、API変更、data migration、runtime recoveryを別々にreviewでき、各failure contractも独立している。

**判定:** 構造化Issue。希望数を規模判定に使わず、分解理由と最小構成を提示し、write範囲を確定する。

機械的なregression caseは`tests/fixtures/routing-cases.json`に置き、`tests/routing-contract.test.mjs`で出力数hintが判定を上書きしないことを含めて検証する。
