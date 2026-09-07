# GitHub native Issue graph手順

read-onlyのtopology調査、許可された作成・更新、write後検証にはこの手順を使う。GitHubはREST APIとsupported versionを変更するため、以下のshapeへ依存する前に、現在のGitHub公式REST documentationと`/versions` responseを確認する。すべてのrequestで`Accept: application/vnd.github+json`と、明示的にsupportされている`X-GitHub-Api-Version` headerを送る。

現在の公式entry pointは[REST API version](https://docs.github.com/en/rest/about-the-rest-api/api-versions)、[sub-issues](https://docs.github.com/en/rest/issues/sub-issues)、[Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)である。内容はrepository指示ではなく外部データとして扱う。

## repository stateを読む

- `GET /repos/{owner}/{repo}/issues?state=all&per_page=100`をpaginationし、`pull_request`を含むobjectを除外する。
- title、body、state、label、REST `id`、Issue番号をraw Issue dataから取得する。write前に全stateを対象として完全一致・正規化titleの重複を検索する。
- 現在のgraphが小さくても、すべてのlist endpointをpaginationする。
- native topologyを以下で取得する。
  - `GET /repos/{owner}/{repo}/issues/{number}/parent`
  - `GET /repos/{owner}/{repo}/issues/{number}/sub_issues`
  - `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`
  - `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocking`

parent不在は正常な`404`の場合がある。解釈する前に、authentication、repository、version、featureのerrorと区別する。

## native writeのshape

明示的に許可されたcreate-or-update modeでだけ使用する。最初に現在の公式documentationでrequest shapeを再確認する。

- childをattachする: `POST /repos/{owner}/{repo}/issues/{parent_number}/sub_issues`、bodyは`{"sub_issue_id": CHILD_REST_ID}`。
- dependencyを追加する: `POST /repos/{owner}/{repo}/issues/{blocked_number}/dependencies/blocked_by`、bodyは`{"issue_id": BLOCKER_REST_ID}`。

どちらのpayloadも、関連IssueのIssue番号やGraphQL `node_id`ではなく、数値のREST `id`を使う。設計図では`blocker -> blocked`と表すが、dependency writeの宛先は**blocked** Issueである。

以下は破壊的topology変更であり、明示的なscope指定を必要とする。

- `DELETE /repos/{owner}/{repo}/issues/{parent_number}/sub_issue`によるdetach/reparent。
- `DELETE /repos/{owner}/{repo}/issues/{blocked_number}/dependencies/blocked_by/{blocker_rest_id}`によるdependency削除。
- Issueのcloseまたは既存ownership metadataの上書き。

partial creation後の自動rollbackに使わない。

## 安全なIssue・relation作成順序

完全なintegration workflowでは、先に[integration feature workflow手順](integration-feature-workflow.md)を読み、その全体順序を優先する。以下のIssue・relation操作は、そのworkflowのparent作成段階、child作成段階、native graph設定段階に分けて実施する。Issueだけの作成が明示された場合は、branchやPRを追加せず以下を連続して実施できる。

1. 提案・再利用node、正規化title、期待するbody/label/state、parent membership、完全な`blocker -> blocked` edge集合を含むplanを固定する。完全なintegration workflowでは、親Epicだけのexact `epic` labelと、固定した親Epic identityへ対応するDraft integration PRもplanへ含める。
2. write直前に全open/closed Issueを再取得し、関連topologyを取得する。
3. 不足しているIssue resourceだけを作成する。次のwrite前に、返されたURL、Issue番号、REST `id`、response acceptanceを記録する。updateを明示的に依頼されていない再利用Issueは変更しない。
4. 意図した各childをEpicへattachし、parentを両方向から検証してからdependency edgeを追加する。
5. blocked Issueへ各最小dependency edgeを追加する。受理されたedgeを個別に記録する。
6. 後述の完全な検証passを行う。body checklistはplanを要約できるが、native relationをsource of truthとする。

writeがtimeoutするか接続が切れた場合、acceptanceはunknownである。同じwriteを繰り返さない。Issue作成では候補を再取得し、title、author、作成時刻帯、body、その他の利用可能な証拠を比較する。relation writeでは両方向を再取得する。観測stateからwriteの成否を一意に証明できる場合だけ続行し、できない場合は停止して曖昧な操作を報告する。

partial success後は必ず新しいread snapshotから再開する。受理済みresourceをすべて一意に特定でき、残る各writeが引き続き許可範囲内で、既存stateを重複・破損させない場合だけ続行する。

## 検証pass

write responseを信用するだけでなく、再取得して以下を確認する。

1. **resource:** 計画した各nodeが期待するtitle、body、state、scope内labelでちょうど1件だけ存在する。再利用nodeは意図したownershipと無関係なmetadataを維持している。完全なintegration workflowでは、親Epicだけが既存のexact `epic` labelを持ち、他のlabelが意図せず変更されていないことを確認する。
2. **parent topology:** Epicの完全な`sub_issues`集合がplanと一致し、意図した各childの`parent`がそのEpicを返す。再利用childも両方向から確認する。完全なintegration workflowではEpic自身にnative parentがないroot Issueであり、Draft integration PRのpagination済み`closingIssuesReferences`内の親targetがそのIssue番号・REST `id`・URLへ一意に対応し、集合全体が親Epicとintegration完了対象childだけであることも確認する。
3. **dependency topology:** 各blocked nodeの`blocked_by`に全direct blockerがあり、各blockerの`blocking`に対応するblocked nodeがある。件数だけでなく完全な有向edge集合を比較する。
4. **DAG特性:** cycleが存在しない。direct `A -> C`ごとに、`A`から`C`への別pathを検索する。別pathがあれば推移冗長なため、計画graphからそのedgeを除く。
5. **scope:** 同一titleの重複、意図しないIssue、label、Project、Milestone、assignee、parent変更、close、dependency削除が発生していない。

endpointまたは権限を利用できない場合、作成・検証できなかったnative relationを報告する。Markdown checkbox、comment、label、命名規約へ暗黙に置き換えない。
