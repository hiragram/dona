# Issue記述contract

隣接Issueと内容を重複させず、各Issueを独立してreview可能にするため、以下のcontractを使う。既存のrepository templateに合わせて見出しは調整してよいが、情報は維持する。

## 単一Issueの記述

規模判定で単一Issueを選んだ場合は、次の情報を1件の中でimplementation-readyにする。

- **成果と背景:** 修正・追加後に観測できる1つのcohesiveな成果と、その必要性。
- **scopeと主責務:** Issueが所有する1つの主責務。変更候補componentやfileはownershipを説明する候補として挙げ、file数をscopeそのものにしない。
- **現状と再現証拠:** bugなら最小再現、期待値と実際値、確認できた原因境界。機能なら現在不足するcontractとconsumerを示す。未確認の推測は事実と分ける。
- **acceptance criteria:** 単独のPRまたは同等のreview単位で実証できるbehavior、永続state、該当する失敗時behavior。
- **必須test:** riskに応じたunit、integration、migration、concurrency、fault、live-smokeのうち必要な証拠。「testが通る」だけをtest plan全体にしない。
- **security・運用invariant:** 認証、認可、isolation、secret、idempotency、ambiguity、restart、observability、recoveryのうち、このIssueが違反し得る境界だけを書く。
- **non-goalsと既存Issue境界:** 別ownership、独立migration/rollout、近接Issueへ残す責務を明示し、1件へ隠さない。
- **dependency / 完了可能性:** directな技術的前提があれば供給artifactを示す。別Issueが完了しないと大半をreview・testできない場合は、単一Issue判定または責務境界を見直す。

単一Issue routeを選んだことを理由に、不要なEpic、空の調整Issue、phase専用Issueを追加しない。一方、依頼文の「Issueを1件」を守るために独立責務を無理に詰め込まない。

## Epic Issueの記述

Epicには以下を記載する。

- **成果と背景:** 全child完了時に実現する、user-visibleまたは運用上のcapability。
- **一貫したscope:** 1つのarchitecture境界と、完全に成立する最小のvertical成果。範囲外に残す隣接成果も明示する。
- **architectureまたはflow:** すべての実装詳細を早期に固定せず、責務境界の理解に必要な永続componentとhandoffを示す。
- **non-goals:** 完了境界を曖昧にする魅力的な隣接作業、より広いplatform、危険なshortcut。
- **native sub-issue一覧:** 提案・再利用するchildと、それぞれ固有の責務。
- **最小native dependency graph:** `blocker -> blocked` edgeと、各edgeの短い技術的理由。
- **parallel lane:** 同時に開始できる単位と、それらを合流させる具体的artifact。
- **完了contract:** end-to-end behavior、releaseまたは運用準備、security invariant、Epic完了前に必要な証拠。
- **既存Issueとの境界:** 再利用する関連作業、別parentに残す作業、重複させてはならない作業。

Phaseはrolloutの説明には使えるが、それだけをdependency graphの根拠にしてはならない。

完全なintegration workflowでは、親Epicだけに既存のexact `epic` labelを付ける。単一Issue route、Issue-onlyの構造化route、子Issueへは、このcontractを理由に`epic`や他のlabelを自動付与しない。存在しないlabelも自動作成しない。

## 実装sub-issue

各実装childには以下を記載する。

- **背景 / scope:** 1つの責務と、その責務が必要な理由。
- **変更候補componentまたはfile:** ownership対象になり得る箇所。網羅的な変更一覧ではなく候補であることを明示する。
- **acceptance criteria:** 観測可能なbehaviorと永続state。該当する場合は失敗時behaviorも含める。
- **必須test:** riskに応じた具体的なcontract、integration、migration、concurrency、fault、end-to-endの証拠。「testが通る」だけをtest plan全体としない。
- **security・運用invariant:** この単位が維持すべきauthentication、authorization、isolation、secret処理、idempotency、ambiguity、restart、observability、recovery規則。該当しない分類は汎用boilerplateを足さず省略する。
- **non-goals:** siblingまたは既存Issueへ意図的に残す責務。
- **既存Issue境界:** 再利用するprimitiveと、このIssueが再実装・引き継ぎしてはならない正確なbehavior。
- **dependency / parallelism:** 直接の技術的前提、各前提が供給するartifact、並行して進められるsibling作業。

acceptance criteriaだけでIssueを独立してreviewできるようにする。criteriaの大半がsibling branchを必要とする、または無関係なphase完了まで実証できない場合は、分割を見直す。

完全なintegration workflowでは、各child本文へ以下も固定して記載する。

- 実装PRのmerge先となるexact feature branch名。例: `feature/foo-bar`。
- feature branchからdefault branchへのDraft integration PR番号とURLをMarkdown linkで記載する。例: `[#123](https://github.com/owner/repo/pull/123)`。
- 実装PRのbaseはdefault branchではなく、上記feature branchであること。

## Decision/ADR Issueの記述

未解決の選択が複数のdownstream contractを変える場合にDecision/ADR childを使う。以下を含める。

- 判断すべき問いと、影響を受けるconsumer。
- 制約、threat modelまたはfailure model、確定済みの事実。
- 実行可能な代替案、選択基準、migrationまたはreversal cost、必要なdecision record。
- 明示的な決定、根拠、却下案、downstream更新checklistを求めるacceptance criteria。
- 有用な場合は、downstream testで利用できるexampleまたはfixture。
- 決定なしでは本当に完了できないconsumerへのdirect dependency edgeだけ。

通常の実装探索、単に調査が必要なtask、repository policyで決定済みの選択にはADRを作らない。

## 責務・重複確認

draft確定前に、以下をすべて確認する。

1. 各childは、別childの主要責務を暗黙に完了させず、review・testできるか。
2. 必須end-to-end behaviorごとにowner Issueと最終integration/release gateがあるか。
3. 共通primitiveをcopyせず再利用し、共有schemaまたはmigration作業のownerを指定しているか。
4. securityとambiguous-write invariantを、違反可能なすべての境界でいずれかのIssueが所有しているか。
5. reparentを明示的に依頼されていない関連既存Issueを、現在のparent配下に維持しているか。
6. 記載したparallel laneは、明記されていないdecision、schema、APIへ依存せず本当に進められるか。
7. 各dependencyは時系列や好みではなく、具体的artifactで正当化されているか。
