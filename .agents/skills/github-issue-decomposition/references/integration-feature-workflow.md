# Integration feature workflow手順

Issue、feature branchのpush、integration PR作成をすべて明示的に依頼されたcreate-or-update modeでのみ、この手順を使う。Skillの有効化や「Issueを作成して」という依頼だけでは、このworkflowの実行権限にならない。write範囲が曖昧な場合はplan-onlyに留めるか、質問する。

## 実行前に固定するplan

- repository、default branch、最新remote default commit、親Epic title、全child title・body、native parent topology、最小`blocker -> blocked` edge、parallel laneを確定する。
- repositoryのlabelをpaginationして再取得し、名前がexact `epic`の既存labelを一意に確定する。このworkflowはlabel作成を許可しない。exact `epic` labelが存在しない場合、またはユーザーの明示的なlabel方針と必須付与が衝突する場合は、最初のwrite前に停止して確認する。他のlabelは明示的に依頼されたものだけをplanへ含める。
- 全open/closed Issueを再取得し、正規化titleと成果から既存重複を検索する。重複候補の扱いが一意に決まらなければwriteしない。
- topicを表すlowercase kebab-caseの短いslugから、`feature/<short-kebab-slug>`を作る。local/remote両方のbranch collisionを確認し、無関係な既存branchを上書き・再利用しない。
- working treeが対象作業だけを含むことを確認する。default branchの最新remote commitを明示的なbranch起点として記録する。

## 必須の実行順序

順序は`親Epic Issue（epic label） -> feature branch -> 空commit -> Draft integration PR -> 子Issue -> native graph`とする。後段の情報を先行resourceへ推測で埋めない。

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

### 3. Draft integration PRを作成する

PR write前にopen/closed/mergedを含む同じhead/baseのPRを再取得する。安全な再開として一意に照合できるopen Draft PRを除き、既存PRがあれば新規PRを作成せず停止する。

exact feature branchをhead、default branchをbaseとするPR create requestへ`draft: true`を指定してDraft PRを作成する。`gh pr create`を使う場合は`--draft`を明示する。title・bodyは日本語で記述し、bodyの独立した1行にGitHub closing keywordをexactly `Closes #<親Issue番号>`として1件だけ含める。他Issueをtargetにするclosing keywordを含めない。このPRは、子Issueの実装PRをfeature branchへ集約し、最終的にfeature branchをdefault branchへ統合するためのものであり、ready化やmergeを自動実行しない。

作成responseだけに依存せず、PR URL・番号、author、base repository/ref、head repository/ref、state、`draft: true`、head SHAを再取得する。raw bodyのactive closing keywordが1件だけで、そのtargetがexecution contextの`parent_issue_number`と一致することに加え、GitHub GraphQLの`closingIssuesReferences`をpaginationして完全な集合がその親Issue1件だけであることを確認する。closing referenceのrepository、Issue番号、`fullDatabaseId`、URLを、固定したrepositoryと親EpicのIssue番号・REST `id`・URLへ照合する。`fullDatabaseId`とREST `id`は10進文字列へ正規化して比較し、親Epicがrootかつexact `epic` label付きであることも再確認する。PR作成がtimeoutなどで曖昧な場合は、同じhead/baseのPRを全stateから検索し、author、作成時刻帯、title、body、Draft状態、head SHA、`closingIssuesReferences`で照合して、blind retryしない。一意に確定できなければ停止する。

PRと親Epicの対応を一意に検証できたら、`integration_pr_number`、`integration_pr_url`、`integration_pr_head_sha`をexecution contextへ固定する。子Issue作成前に、`parent_issue_number`、`parent_issue_rest_id`、`parent_issue_url`、`feature_branch`、`empty_commit_sha`、`integration_pr_number`、`integration_pr_url`、`integration_pr_head_sha`をimmutableなexecution contextとして確定し、以後のchild body間で不一致を作らない。

### 4. 子Issueを作成する

[Issue記述contract](issue-contract.md)に従って各childを作成する。各bodyに以下を含める。

- 実装PRのmerge先としてexact feature branch名をcode表記する。
- Draft integration PRをMarkdown linkで記載する。例: `[#123](https://github.com/owner/repo/pull/123)`。
- 子Issueの実装PRはdefault branchではなくexact feature branchをbaseにする、と明記する。

各作成responseのURL、Issue番号、REST `id`、acceptanceを記録してから次へ進む。acceptance unknown時は親Issueと同じく再取得・照合し、blind retryしない。

### 5. native graphを設定する

全child作成後、[native graph手順](native-issue-graph.md)に従い、親Epic直下のnative sub-issuesを設定する。その後、技術的prerequisiteだけからなる最小native blocker DAGを設定する。phase-only edge、並列可能な単位間のedge、推移edgeを追加しない。parent relationとdependencyをそれぞれ両方向から再取得して検証する。

## partial failureと安全な再開

- **parent成功 / branch失敗:** 親Issueをclose・deleteせず、親Issue番号と失敗したbranch操作、観測したremote state、次の安全なactionを報告する。
- **branch成功 / PR失敗:** branchや空commitを削除・force pushせず、同じhead/baseのPRを全stateから再取得する。open、Draft、parent closing targetを含むidentityからPR作成の成否を一意に確定できる場合だけ続ける。
- **PR成功 / child失敗:** PRをcloseせず、作成済みchildと不足childを再取得で区別する。immutable execution contextを維持できる場合だけ不足分を続行する。
- **relationのpartial success:** 作成済みparent/dependency relationを両方向から再取得し、残るwriteが重複や既存topology破損を起こさない場合だけ続ける。

どの段階でもacceptance unknownの操作を自動retryしない。既に作成した親Issue、branch、PRを破壊的にdelete・close・force pushしてrollbackしない。安全に続行できない場合は停止し、部分成果物、確定済みstate、曖昧なstate、必要なnext actionを報告する。

## 最終検証・報告

以下を再取得結果とともに報告する。

- 親Issue番号・URL。
- exact feature branch、起点となった最新default branch commit、空commit SHA、remote head。
- 親EpicのIssue番号・REST `id`・URL・root状態・exact `epic` labelと、意図しない既存label変更がないこと。
- integration PR番号・URL・base・head・state・Draft状態・head SHA・唯一のexact `Closes #<親Issue番号>`と、`closingIssuesReferences`の完全な集合が固定した親Epic identity1件に一致すること。
- 全child Issueと、各bodyに記載したmerge-target branch、integration PR link。
- 両方向で検証したnative parent topology、最小blocker edge、parallel lane。
- partialまたはambiguous failure、未完了resource、次の安全なaction。部分的にしか検証できないworkflowを完了扱いしない。
