# Supervisor approval integration manifest

## 目的と範囲

この文書は、[Issue #26](https://github.com/hiragram/dona/issues/26)配下の実装を1本のintegration branchへ安全に集約するためのmanifestです。子Issueの責務、native dependency graph、Epicのsecurity invariantをsource of truthとし、このbranch上で未完了の子Issueを実装済みと扱いません。

```yaml
epic: 26
integration_branch: integration/issue-26-supervisor-approval
default_branch: main
child_pull_request_base: integration/issue-26-supervisor-approval
final_merge_target: main
release_state: safe_off
```

子Issueの実装PRは`main`ではなく`integration/issue-26-supervisor-approval`をbaseにします。integration PR自体は`main`をbaseにし、後述のmerge gateがすべて揃うまでmergeしません。

## 統合対象

| Issue | 固有の責務 |
| --- | --- |
| [#15](https://github.com/hiragram/dona/issues/15) | trust boundary、lifecycle、UX、運用方針のADR |
| [#16](https://github.com/hiragram/dona/issues/16) | transport-neutral domain、SQLite repository、audit/outbox |
| [#17](https://github.com/hiragram/dona/issues/17) | instance/supervisor binding、bootstrap、rotation、break-glass |
| [#18](https://github.com/hiragram/dona/issues/18) | UDS/MCP API、LLM assessment policy、AGENTS integration |
| [#19](https://github.com/hiragram/dona/issues/19) | SlackApprovalTransport、Block Kit、interactive decision |
| [#20](https://github.com/hiragram/dona/issues/20) | DonaActionGateway、typed immutable action plan/hash |
| [#21](https://github.com/hiragram/dona/issues/21) | OperationExecutorRegistry、legacy direct-write bypass遮断 |
| [#22](https://github.com/hiragram/dona/issues/22) | `dona_approval` event、one-shot consume、execution result routing |
| [#23](https://github.com/hiragram/dona/issues/23) | background jobの`awaiting_approval`とresume lifecycle |
| [#24](https://github.com/hiragram/dona/issues/24) | health、metrics、CLI、reconcile、expiry、retention |
| [#25](https://github.com/hiragram/dona/issues/25) | deterministic integration/chaos/security testとrunbook |

このmanifest作成時点で#15〜#25はすべて未完了です。状態の判定にはGitHub Issueとnative relationの最新値を使い、この記述だけで完了扱いしません。

## Native dependency graph

矢印は`blocker -> blocked`を表します。以下はIssue #26で定義済みの直接依存だけであり、phaseの都合によるedgeや推移edgeは追加しません。

```text
#15 -> #16, #17
#16 -> #18, #19, #24
#17 -> #18, #19
#18 -> #20, #22
#20 -> #21
#21 -> #22
#22 -> #23
#19 -> #25
#23 -> #25
#24 -> #25
```

native relationがこのgraphと一致することを、Epic側の`sub_issues`、各子Issueの`parent`、`blocked_by`、`blocking`の両方向から照合します。

## 子PRの受け入れ条件

子IssueのPRは次を満たす場合だけintegration branchへmergeできます。

- PRは対応する子1件の責務とacceptance criteriaに限定され、baseがexact `integration/issue-26-supervisor-approval`である。
- direct blockerが供給するADR、schema、typed contract、または永続artifactを、子branch内で別物として先取りしない。
- 対象Issueの必須testと失敗境界を検証し、current head/base pairのCIとreview結果を確認できる。
- secret、private URL、不要なSlack本文をcode、fixture、log、artifactへ含めない。
- acceptance不明の外部writeを自動retryせず、`needs_review`または明示的なreconcile境界に残す。

独立したparallel laneはまずintegration branchの最新headを取り込み、合流時に最新のcontractとmigration順序を再検証します。conflict解消は文脈ごとに行い、force pushや無差別な`ours`/`theirs`選択は使いません。

## `main`へのmerge gate

integration PRは、次の証拠が同一のcurrent head/base pairで揃った場合だけmerge可能と判定します。

- #15〜#25がすべて完了し、Issueのnative parent/dependency stateと実装stateが一致する。
- binding済みsupervisorのみが、instance/workspace/request/action/Slack coordinatesの照合後にdecisionできる。
- typed immutable snapshot/hash、expiry、one-shot consume、TOCTOU再検証、cross-workspace拒否がend-to-endで確認できる。
- original event/turnのterminal後もpending requestが再起動を越え、別の`dona_approval` eventからだけ1回resumeする。
- `approved`、consume、execution attempt、external acceptance/resultが分離され、acceptance unknownは自動retryされない。
- approval-requiredなMVP operationでlegacy direct-write bypassが閉じ、Phase 1のresume未接続状態を安全な完成と誤認しない。
- background jobのcancel/expiry/restart競合、運用診断、reconcile、retention、backup/restore、rotation、break-glassをdeterministic testとrunbookで検証する。
- repositoryの全検証、security/chaos E2E、current integration PR headのCodex Cloud reviewとCIがcleanである。

## 現在の検証境界

このscaffoldはbranchのmerge targetと安全な合流条件を固定するもので、supervisor approvalのruntime/product実装は含みません。文書検証やCIが成功しても、Slack UI/API、identity proof、SQLite migration、one-shot execution、legacy bypass遮断、restart/race、実Slack workspaceでのlive smokeの完了証拠にはなりません。実行機能は上記のmerge gateが揃うまで`safe_off`とします。
