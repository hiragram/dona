# Integration feature workflow手順

Issue、feature branchのpush、integration PR作成をすべて明示的に依頼されたcreate-or-update modeでのみ、この手順を使う。Skillの有効化や「Issueを作成して」という依頼だけでは、このworkflowの実行権限にならない。write範囲が曖昧な場合はplan-onlyに留めるか、質問する。

## 実行前に固定するplan

- repository、default branch、最新remote default commit、親Epic title、全child title・body、native parent topology、最小`blocker -> blocked` edge、parallel laneを確定する。
- repositoryのlabelをpaginationして再取得し、名前がexact `epic`の既存labelを一意に確定する。このworkflowはlabel作成を許可しない。exact `epic` labelが存在しない場合、またはユーザーの明示的なlabel方針と必須付与が衝突する場合は、最初のwrite前に停止して確認する。他のlabelは明示的に依頼されたものだけをplanへ含める。
- integration PRの必須状態がDraftであることをplanへ明記する。ユーザーがreadyまたはnon-draftを明示している場合は、Draft必須contractと衝突するため最初のwrite前に停止して確認する。親Issueやbranchを先に作成してからPR状態の衝突を発見しない。
- 全open/closed Issueを再取得し、正規化titleと成果から既存重複を検索する。重複候補の扱いが一意に決まらなければwriteしない。
- topicを表すlowercase kebab-caseの短いslugから、`feature/<short-kebab-slug>`を作る。local/remote両方のbranch collisionを確認し、無関係な既存branchを上書き・再利用しない。
- working treeが対象作業だけを含むことを確認する。default branchの最新remote commitを明示的なbranch起点として記録する。

## 必須の実行順序

順序は`親Epic Issue（epic label） -> feature branch -> 空commit -> Draft integration PR -> 子Issue -> integration PR closing relationship reconcile -> native graph`とする。後段の情報を先行resourceへ推測で埋めない。

### 1. 親Epic Issueを作成する

[Issue記述contract](issue-contract.md)に従う親Epicだけを先に作成し、作成requestの`labels`へexact `epic`と明示的に依頼されたlabelだけを含める。responseのURL、Issue番号、REST `id`、author、作成時刻を記録する。作成responseがtimeoutや接続断で曖昧な場合はblind retryせず、title、author、作成時刻帯、bodyなどで再取得・照合する。一意に特定できなければ停止する。

作成後の親Issueを再取得し、記録したIssue番号、REST `id`、URL、title、authorと一致し、exact `epic` labelを持ち、native parentが存在しないroot Issueであることを確認する。`epic`だけが欠ける場合は、既存labelを置換するIssue更新ではなく`POST /repos/{owner}/{repo}/issues/{issue_number}/labels`へ`{"labels":["epic"]}`を送り、全labelを再取得して既存labelが保持されたことを確認する。このlabel writeが曖昧なら再実行せず、再取得したlabel集合で受理を一意に判定できる場合だけ続ける。

親Issueのidentityとlabelを確定するまでbranchを作らない。確定後は`parent_issue_number`、`parent_issue_rest_id`、`parent_issue_url`、`feature_branch`をexecution contextへ固定する。

### 2. feature branchと空commitを作成・pushする

- branch作成直前にremote default branchを再取得し、その時点の最新commitを起点にする。local/remote両方のcollisionをもう一度確認してからexact feature branchを作成し、起点commitを再検証する。
- `git commit --allow-empty`で空commitを1件作る。commit messageは、そのtopicのintegration準備であることが伝わる意味のある日本語にする。
- 作成した空commitのSHAを`empty_commit_sha`として記録する。
- remoteへ通常のpushを行う。force pushは禁止する。push前後にremote refを確認し、無関係な既存headを更新しない。
- push結果が曖昧な場合はremote refとcommit ancestryを再取得し、受理済みか確認する。同じpushをblind retryしない。non-fast-forwardやcollisionを安全に解消できない場合は停止する。

### 3. 標準templateからDraft integration PRを作成する

PR作成前にcurrent default branchのexact SHAから標準`.github/PULL_REQUEST_TEMPLATE.md`を取得する。取得元のref/SHAとtemplate blob/hashを記録し、fileがない、空、取得不能、または構造を安全に解釈できない場合はPRを作成せず停止する。templateのコメント、全見出し、順序を維持し、`完了する Issue`へexactly 1件の`Closes #<親Issue番号>`、変更内容へchild PRをfeature branchへ集約する方針、test範囲、実行済みの確認手順と未検証境界を記入する。未解決placeholderを残さず、子Issue作成後にstep 5でintegration完了対象childを同じ欄へreconcileする予定も明記する。

PR write前にopen/closed/mergedを含む同じhead/baseのPRを再取得する。該当PRがなければ新規作成へ進む。後述するidentityを満たすopen Draft PRを1件だけ安全な再開対象として照合できた場合は、そのPRをexecution contextへ採用し、PR create requestを送らず再取得検証へ進む。それ以外の既存PRがあれば新規PRを作成せず停止する。

既存PRを採用しない新規作成時だけ、exact feature branchをhead、default branchをbaseとするPR create requestへ`draft: true`を指定してDraft PRを作成する。`gh pr create`を使う場合は`--draft`を明示する。title・bodyは日本語で記述し、bodyの独立した1行にGitHub closing keywordをexactly `Closes #<親Issue番号>`として1件だけ含める。他Issueをtargetにするclosing keywordを含めない。このPRは、子Issueの実装PRをfeature branchへ集約し、最終的にfeature branchをdefault branchへ統合するためのものであり、ready化やmergeを自動実行しない。

作成responseだけに依存せず、PR URL・番号、author、base repository/ref、head repository/ref、state、`draft: true`、head SHAを再取得する。raw title/bodyと標準templateの全見出しを検証し、この子Issue作成前の段階ではexactly 1件の`Closes #<親Issue番号>`があり、raw bodyのactive closing keywordが1件だけで、そのtargetがexecution contextの`parent_issue_number`と一致することに加え、GitHub GraphQLの`closingIssuesReferences`をpaginationして完全な集合がその親Issue1件だけであることを確認する。closing referenceのrepository、Issue番号、`fullDatabaseId`、URLを、固定したrepositoryと親EpicのIssue番号・REST `id`・URLへ照合する。`fullDatabaseId`とREST `id`は10進文字列へ正規化して比較し、親Epicがrootかつexact `epic` label付きであることも再確認する。PR作成がtimeoutなどで曖昧な場合は、同じhead/baseのPRを全stateから検索し、author、作成時刻帯、title、body、Draft状態、head SHA、`closingIssuesReferences`で照合して、blind retryしない。一意に確定できなければ停止する。

新規作成または再開したPRと親Epicの対応を一意に検証できたら、`integration_pr_number`、`integration_pr_url`、`integration_pr_head_sha`と`integration_pr_origin`（`created`または`resumed`）をexecution contextへ固定する。子Issue作成前に、`parent_issue_number`、`parent_issue_rest_id`、`parent_issue_url`、`feature_branch`、`empty_commit_sha`、`integration_pr_number`、`integration_pr_url`、`integration_pr_head_sha`、`integration_pr_origin`をimmutableなexecution contextとして確定し、以後のchild body間で不一致を作らない。

### 4. 子Issueを作成する

[Issue記述contract](issue-contract.md)に従って各childを作成する。各bodyに以下を含める。

- 実装PRのmerge先としてexact feature branch名をcode表記する。
- Draft integration PRをMarkdown linkで記載する。例: `[#123](https://github.com/owner/repo/pull/123)`。
- 子Issueの実装PRはdefault branchではなくexact feature branchをbaseにする、と明記する。
- childごとにIssue全体の完了点を`feature branchへの実装PR merge`または`default branchへのintegration PR merge`へ固定する。前者はchildのacceptanceと必須testがfeature branch上で独立して完了すると確認できる場合だけ選び、実装PRで`Closes #<child>`を使用できる。ただしこのkeywordはnon-default branchへのmergeでGitHubによる自動closeを保証しない。実装PRをmergeするauthenticated identityを`close_owner`とし、target child IssueのGraphQL `viewerCanClose: true`または同等のcurrent permission evidenceを事前取得する。`post_merge_close_action`として、merge済みPRのbase/head/merge commitとcurrent child Issue identityの照合、exact childへの明示的なclose write、Issueの`state`・`closedAt`・close eventの再取得をchild本文とexecution contextへ固定し、手動closeの再取得検証までを完了条件にする。permissionがfalse・unknown・別identityの場合はfeature-merge完了点で`Closes`を許可せず、権限あるclose ownerを確認するかintegration完了点へ戻す。後者ではchild実装PRを部分対応として扱い、`Closes`を使用しない。この`child_completion_point`とclose mechanismをIssue番号に結び付けてexecution contextへ追加する。

各作成responseのURL、Issue番号、REST `id`、acceptanceを記録してから次へ進む。acceptance unknown時は親Issueと同じく再取得・照合し、blind retryしない。

### 5. integration PRのchild closing relationshipをreconcileする

execution contextだけから対象集合を決めず、全childのcurrent contractを再取得してから、`child_completion_point`が`default branchへのintegration PR merge`であるchildだけをIssue番号でsort・重複排除し、integration PRのclosing targetへ追加する。対象が0件でも、integration PRが親Issue以外の意図しないclosing targetを持たないことを読み取りで検証する。

1. integration PRのcurrent raw title/body、`updatedAt`、base/head SHA、state、draft状態と、GraphQL `closingIssuesReferences`全pageを再取得する。親Issueと、feature-merge完了として除外するchildを含む全childについてrepository、node ID、number、state、`updatedAt`、raw title/body hash、current `child_completion_point`、close mechanismを取得する。全childのcurrent contractからintegration完了対象集合を再計算し、全child集合・各identity・各完了contractがimmutable execution contextと一致するcanonical snapshotへ固定する。1件でも変更、欠落、追加、曖昧なcontractがあれば対象集合を古いcontextから推測せず、write前に停止する。取得やpaginationが不完全、PRが別base/head、Draftでない、または人間の同時編集とのreconcileが一意でない場合もwriteしない。
2. current default branchのexact SHAから標準`.github/PULL_REQUEST_TEMPLATE.md`を再取得する。既存bodyのtemplate構造、人間の追記、`Closes #<親Issue番号>`を保持し、`完了する Issue`欄へ対象childごとにexactly 1件の`Closes #<child>`を追加する。feature branchへの実装PR mergeで完了するchildや、許可していないIssueのclosing keywordを追加しない。標準templateを取得・解釈できない、必要欄がない、または既存記述と競合する場合は更新せず停止する。
3. write直前にPR、親Issue、全childのsnapshotを再取得し、全childのcurrent contractから対象集合をもう一度再計算する。identity、完了contract、対象集合のいずれかに差分があれば古いbodyを送信せず停止する。body更新の結果がtimeout・切断で曖昧ならblind retryせず、raw body、`updatedAt`、base/headとclosing relationshipを再取得して受理を一意に照合する。
4. 更新後のraw bodyと`closingIssuesReferences`全pageに加えて全childのidentity・current `child_completion_point`・close mechanismを再取得し、snapshotと対象集合が不変であること、親Issueとintegration完了対象childがexactly 1件ずつ存在し、feature-merge完了childや未知のIssueが存在しないこと、default branchへのmergeでGitHubが自動closeするrelationshipになったことを検証する。不一致ならnative graphや後続reviewへ進まず停止する。

### 6. native graphを設定する

全child作成後、[native graph手順](native-issue-graph.md)に従い、親Epic直下のnative sub-issuesを設定する。その後、技術的prerequisiteだけからなる最小native blocker DAGを設定する。phase-only edge、並列可能な単位間のedge、推移edgeを追加しない。parent relationとdependencyをそれぞれ両方向から再取得して検証する。

## partial failureと安全な再開

- **parent成功 / branch失敗:** 親Issueをclose・deleteせず、親Issue番号と失敗したbranch操作、観測したremote state、次の安全なactionを報告する。
- **branch成功 / PR失敗:** branchや空commitを削除・force pushせず、同じhead/baseのPRを全stateから再取得する。open、Draft、parent closing targetを含むidentityからPR作成の成否を一意に確定できる場合だけ続ける。
- **PR成功 / child失敗:** PRをcloseせず、作成済みchildと不足childを再取得で区別する。immutable execution contextを維持できる場合だけ不足分を続行する。全childが確定するまでintegration PRへchild closing referenceを推測で追加しない。
- **integration PR本文更新のpartial success:** raw body、`updatedAt`、base/headと`closingIssuesReferences`全pageを再取得し、受理済みか一意に照合する。曖昧なwriteを再試行せず、許可した親・child以外のclosing targetを自動でunlinkしない。
- **relationのpartial success:** 作成済みparent/dependency relationを両方向から再取得し、残るwriteが重複や既存topology破損を起こさない場合だけ続ける。

どの段階でもacceptance unknownの操作を自動retryしない。既に作成した親Issue、branch、PRを破壊的にdelete・close・force pushしてrollbackしない。安全に続行できない場合は停止し、部分成果物、確定済みstate、曖昧なstate、必要なnext actionを報告する。

## 最終検証・報告

以下を再取得結果とともに報告する。

- 親Issue番号・URL。
- exact feature branch、起点となった最新default branch commit、空commit SHA、remote head。
- 親EpicのIssue番号・REST `id`・URL・root状態・exact `epic` labelと、意図しない既存label変更がないこと。
- integration PR番号・URL・base・head・state・Draft状態・head SHA・exact `Closes #<親Issue番号>`と、`closingIssuesReferences`の完全な集合が固定した親Epicとintegration完了対象childに一致すること。
- 全child Issueと、各bodyに記載したmerge-target branch、integration PR link、`child_completion_point`、実装PRでの`Closes`可否、`close_owner`、post-merge closeまたはintegration PR relationshipの検証結果。
- integration PR本文へ追加したintegration完了対象childの`Closes`一覧と、全page取得したcurrent `closingIssuesReferences`。feature-merge完了childがその一覧に混入していないこと。
- 両方向で検証したnative parent topology、最小blocker edge、parallel lane。
- partialまたはambiguous failure、未完了resource、次の安全なaction。部分的にしか検証できないworkflowを完了扱いしない。
