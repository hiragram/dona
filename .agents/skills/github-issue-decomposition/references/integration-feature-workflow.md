# Integration feature workflow手順

Issue、feature branchのpush、integration PR作成をすべて明示的に依頼されたcreate-or-update modeでのみ、この手順を使う。Skillの有効化や「Issueを作成して」という依頼だけでは、このworkflowの実行権限にならない。write範囲が曖昧な場合はplan-onlyに留めるか、質問する。

## 実行前に固定するplan

- repository、default branch、最新remote default commit、親Epic title、全child title・body、native parent topology、最小`blocker -> blocked` edge、parallel laneを確定する。
- 全open/closed Issueを再取得し、正規化titleと成果から既存重複を検索する。重複候補の扱いが一意に決まらなければwriteしない。
- topicを表すlowercase kebab-caseの短いslugから、`feature/<short-kebab-slug>`を作る。local/remote両方のbranch collisionを確認し、無関係な既存branchを上書き・再利用しない。
- working treeが対象作業だけを含むことを確認する。default branchの最新remote commitを明示的なbranch起点として記録する。

## 必須の実行順序

順序は`親Epic Issue -> feature branch -> 空commit -> integration PR -> 子Issue -> integration PR closing relationship reconcile -> native graph`とする。後段の情報を先行resourceへ推測で埋めない。

### 1. 親Epic Issueを作成する

[Issue記述contract](issue-contract.md)に従う親Epicだけを先に作成し、responseのURL、Issue番号、REST `id`、author、作成時刻を記録する。作成responseがtimeoutや接続断で曖昧な場合はblind retryせず、title、author、作成時刻帯、bodyなどで再取得・照合する。一意に特定できなければ停止する。

親Issue番号が確定するまでbranchを作らない。確定後は`parent_issue_number`と`feature_branch`をexecution contextへ固定する。

### 2. feature branchと空commitを作成・pushする

- branch作成直前にremote default branchを再取得し、その時点の最新commitを起点にする。local/remote両方のcollisionをもう一度確認してからexact feature branchを作成し、起点commitを再検証する。
- `git commit --allow-empty`で空commitを1件作る。commit messageは、そのtopicのintegration準備であることが伝わる意味のある日本語にする。
- 作成した空commitのSHAを`empty_commit_sha`として記録する。
- remoteへ通常のpushを行う。force pushは禁止する。push前後にremote refを確認し、無関係な既存headを更新しない。
- push結果が曖昧な場合はremote refとcommit ancestryを再取得し、受理済みか確認する。同じpushをblind retryしない。non-fast-forwardやcollisionを安全に解消できない場合は停止する。

### 3. 標準templateからnon-draft integration PRを作成する

PR作成前にcurrent default branchのexact SHAから標準`.github/PULL_REQUEST_TEMPLATE.md`を取得する。取得元のref/SHAとtemplate blob/hashを記録し、fileがない、空、取得不能、または構造を安全に解釈できない場合はPRを作成せず停止する。templateのコメント、全見出し、順序を維持し、`完了する Issue`へexactly 1件の`Closes #<親Issue番号>`、変更内容へchild PRをfeature branchへ集約する方針、test範囲、実行済みの確認手順と未検証境界を記入する。未解決placeholderを残さず、子Issue作成後にstep 5でintegration完了対象childを同じ欄へreconcileする予定も明記する。

この検証済みtitle/bodyを使い、exact feature branchをhead、default branchをbaseとするnon-draft PRを作成する。このPRは、子Issueの実装PRをfeature branchへ集約し、最終的にfeature branchをdefault branchへ統合するためのものであり、直ちにmergeしない。

作成responseだけに依存せず、PR URL・番号、raw title/body、base、head、state、draft状態、標準templateの全見出し、exactly 1件の`Closes #<親Issue番号>`を再取得して検証する。作成がtimeoutなどで曖昧な場合は、同じhead/baseのPRを検索して照合し、blind retryしない。

PRを一意に検証できたら、`integration_pr_number`と`integration_pr_url`をexecution contextへ固定する。子Issue作成前に、`parent_issue_number`、`feature_branch`、`empty_commit_sha`、`integration_pr_number`、`integration_pr_url`をimmutableなexecution contextとして確定し、以後のchild body間で不一致を作らない。

### 4. 子Issueを作成する

[Issue記述contract](issue-contract.md)に従って各childを作成する。各bodyに以下を含める。

- 実装PRのmerge先としてexact feature branch名をcode表記する。
- integration PRをMarkdown linkで記載する。例: `[#123](https://github.com/owner/repo/pull/123)`。
- 子Issueの実装PRはdefault branchではなくexact feature branchをbaseにする、と明記する。
- childごとにIssue全体の完了点を`feature branchへの実装PR merge`または`default branchへのintegration PR merge`へ固定する。前者はchildのacceptanceと必須testがfeature branch上で独立して完了すると確認できる場合だけ選び、実装PRで`Closes #<child>`を使用できる。ただしこのkeywordはnon-default branchへのmergeでGitHubによる自動closeを保証しない。実装PRをmergeするauthenticated identityを`close_owner`とし、target child IssueのGraphQL `viewerCanClose: true`または同等のcurrent permission evidenceを事前取得する。`post_merge_close_action`として、merge済みPRのbase/head/merge commitとcurrent child Issue identityの照合、exact childへの明示的なclose write、Issueの`state`・`closedAt`・close eventの再取得をchild本文とexecution contextへ固定し、手動closeの再取得検証までを完了条件にする。permissionがfalse・unknown・別identityの場合はfeature-merge完了点で`Closes`を許可せず、権限あるclose ownerを確認するかintegration完了点へ戻す。後者ではchild実装PRを部分対応として扱い、`Closes`を使用しない。この`child_completion_point`とclose mechanismをIssue番号に結び付けてexecution contextへ追加する。

各作成responseのURL、Issue番号、REST `id`、acceptanceを記録してから次へ進む。acceptance unknown時は親Issueと同じく再取得・照合し、blind retryしない。

### 5. integration PRのchild closing relationshipをreconcileする

`child_completion_point`が`default branchへのintegration PR merge`であるchildだけをIssue番号でsort・重複排除し、integration PRのclosing targetへ追加する。対象が0件でも、integration PRが親Issue以外の意図しないclosing targetを持たないことを読み取りで検証する。

1. integration PRのcurrent raw title/body、`updatedAt`、base/head SHA、state、draft状態と、GraphQL `closingIssuesReferences`全pageを再取得する。親Issueおよび対象childのrepository、node ID、number、state、`updatedAt`、raw title/body hashも取得し、immutable execution contextと一致するcanonical snapshotへ固定する。取得やpaginationが不完全、PRが別base/head、対象Issue identityが変化、または人間の同時編集とのreconcileが一意でなければwriteしない。
2. current default branchのexact SHAから標準`.github/PULL_REQUEST_TEMPLATE.md`を再取得する。既存bodyのtemplate構造、人間の追記、`Closes #<親Issue番号>`を保持し、`完了する Issue`欄へ対象childごとにexactly 1件の`Closes #<child>`を追加する。feature branchへの実装PR mergeで完了するchildや、許可していないIssueのclosing keywordを追加しない。標準templateを取得・解釈できない、必要欄がない、または既存記述と競合する場合は更新せず停止する。
3. write直前にPRと全対象Issueのsnapshotを再取得する。差分があれば古いbodyを送信せず、最新stateからreconcileをやり直す。body更新の結果がtimeout・切断で曖昧ならblind retryせず、raw body、`updatedAt`、base/headとclosing relationshipを再取得して受理を一意に照合する。
4. 更新後のraw bodyと`closingIssuesReferences`全pageを再取得し、親Issueとintegration完了対象childがexactly 1件ずつ存在し、feature-merge完了childや未知のIssueが存在しないこと、default branchへのmergeでGitHubが自動closeするrelationshipになったことを検証する。不一致ならnative graphや後続reviewへ進まず停止する。

### 6. native graphを設定する

全child作成後、[native graph手順](native-issue-graph.md)に従い、親Epic直下のnative sub-issuesを設定する。その後、技術的prerequisiteだけからなる最小native blocker DAGを設定する。phase-only edge、並列可能な単位間のedge、推移edgeを追加しない。parent relationとdependencyをそれぞれ両方向から再取得して検証する。

## partial failureと安全な再開

- **parent成功 / branch失敗:** 親Issueをclose・deleteせず、親Issue番号と失敗したbranch操作、観測したremote state、次の安全なactionを報告する。
- **branch成功 / PR失敗:** branchや空commitを削除・force pushせず、同じhead/baseのPR有無を再取得する。PR作成の成否を一意に確定できる場合だけ続ける。
- **PR成功 / child失敗:** PRをcloseせず、作成済みchildと不足childを再取得で区別する。immutable execution contextを維持できる場合だけ不足分を続行する。全childが確定するまでintegration PRへchild closing referenceを推測で追加しない。
- **integration PR本文更新のpartial success:** raw body、`updatedAt`、base/headと`closingIssuesReferences`全pageを再取得し、受理済みか一意に照合する。曖昧なwriteを再試行せず、許可した親・child以外のclosing targetを自動でunlinkしない。
- **relationのpartial success:** 作成済みparent/dependency relationを両方向から再取得し、残るwriteが重複や既存topology破損を起こさない場合だけ続ける。

どの段階でもacceptance unknownの操作を自動retryしない。既に作成した親Issue、branch、PRを破壊的にdelete・close・force pushしてrollbackしない。安全に続行できない場合は停止し、部分成果物、確定済みstate、曖昧なstate、必要なnext actionを報告する。

## 最終検証・報告

以下を再取得結果とともに報告する。

- 親Issue番号・URL。
- exact feature branch、起点となった最新default branch commit、空commit SHA、remote head。
- integration PR番号・URL・base・head・state・non-draft状態・exact `Closes #<親Issue番号>`の存在。
- 全child Issueと、各bodyに記載したmerge-target branch、integration PR link、`child_completion_point`、実装PRでの`Closes`可否、`close_owner`、post-merge closeまたはintegration PR relationshipの検証結果。
- integration PR本文へ追加したintegration完了対象childの`Closes`一覧と、全page取得したcurrent `closingIssuesReferences`。feature-merge完了childがその一覧に混入していないこと。
- 両方向で検証したnative parent topology、最小blocker edge、parallel lane。
- partialまたはambiguous failure、未完了resource、次の安全なaction。部分的にしか検証できないworkflowを完了扱いしない。
