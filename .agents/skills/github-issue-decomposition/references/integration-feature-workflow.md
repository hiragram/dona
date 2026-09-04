# Integration feature workflow手順

Issue、feature branchのpush、integration PR作成をすべて明示的に依頼されたcreate-or-update modeでのみ、この手順を使う。Skillの有効化や「Issueを作成して」という依頼だけでは、このworkflowの実行権限にならない。write範囲が曖昧な場合はplan-onlyに留めるか、質問する。

## 実行前に固定するplan

- repository、default branch、最新remote default commit、親Epic title、全child title・body、native parent topology、最小`blocker -> blocked` edge、parallel laneを確定する。
- 全open/closed Issueを再取得し、正規化titleと成果から既存重複を検索する。重複候補の扱いが一意に決まらなければwriteしない。
- topicを表すlowercase kebab-caseの短いslugから、`feature/<short-kebab-slug>`を作る。local/remote両方のbranch collisionを確認し、無関係な既存branchを上書き・再利用しない。
- working treeが対象作業だけを含むことを確認する。default branchの最新remote commitを明示的なbranch起点として記録する。

## 必須の実行順序

順序は`親Epic Issue -> feature branch -> 空commit -> integration PR -> 子Issue -> native graph`とする。後段の情報を先行resourceへ推測で埋めない。

### 1. 親Epic Issueを作成する

[Issue記述contract](issue-contract.md)に従う親Epicだけを先に作成し、responseのURL、Issue番号、REST `id`、author、作成時刻を記録する。作成responseがtimeoutや接続断で曖昧な場合はblind retryせず、title、author、作成時刻帯、bodyなどで再取得・照合する。一意に特定できなければ停止する。

親Issue番号が確定するまでbranchを作らない。確定後は`parent_issue_number`と`feature_branch`をexecution contextへ固定する。

### 2. feature branchと空commitを作成・pushする

- branch作成直前にremote default branchを再取得し、その時点の最新commitを起点にする。local/remote両方のcollisionをもう一度確認してからexact feature branchを作成し、起点commitを再検証する。
- `git commit --allow-empty`で空commitを1件作る。commit messageは、そのtopicのintegration準備であることが伝わる意味のある日本語にする。
- 作成した空commitのSHAを`empty_commit_sha`として記録する。
- remoteへ通常のpushを行う。force pushは禁止する。push前後にremote refを確認し、無関係な既存headを更新しない。
- push結果が曖昧な場合はremote refとcommit ancestryを再取得し、受理済みか確認する。同じpushをblind retryしない。non-fast-forwardやcollisionを安全に解消できない場合は停止する。

### 3. non-draft integration PRを作成する

exact feature branchをhead、default branchをbaseとするnon-draft PRを作成する。title・bodyは日本語で記述し、bodyにGitHub closing keywordをexactly `Closes #<親Issue番号>`として1件含める。このPRは、子Issueの実装PRをfeature branchへ集約し、最終的にfeature branchをdefault branchへ統合するためのものであり、直ちにmergeしない。

作成responseだけに依存せず、PR URL・番号、base、head、state、draft状態、`Closes #<親Issue番号>`を再取得して検証する。作成がtimeoutなどで曖昧な場合は、同じhead/baseのPRを検索して照合し、blind retryしない。

PRを一意に検証できたら、`integration_pr_number`と`integration_pr_url`をexecution contextへ固定する。子Issue作成前に、`parent_issue_number`、`feature_branch`、`empty_commit_sha`、`integration_pr_number`、`integration_pr_url`をimmutableなexecution contextとして確定し、以後のchild body間で不一致を作らない。

### 4. 子Issueを作成する

[Issue記述contract](issue-contract.md)に従って各childを作成する。各bodyに以下を含める。

- 実装PRのmerge先としてexact feature branch名をcode表記する。
- integration PRをMarkdown linkで記載する。例: `[#123](https://github.com/owner/repo/pull/123)`。
- 子Issueの実装PRはdefault branchではなくexact feature branchをbaseにする、と明記する。

各作成responseのURL、Issue番号、REST `id`、acceptanceを記録してから次へ進む。acceptance unknown時は親Issueと同じく再取得・照合し、blind retryしない。

### 5. native graphを設定する

全child作成後、[native graph手順](native-issue-graph.md)に従い、親Epic直下のnative sub-issuesを設定する。その後、技術的prerequisiteだけからなる最小native blocker DAGを設定する。phase-only edge、並列可能な単位間のedge、推移edgeを追加しない。parent relationとdependencyをそれぞれ両方向から再取得して検証する。

## partial failureと安全な再開

- **parent成功 / branch失敗:** 親Issueをclose・deleteせず、親Issue番号と失敗したbranch操作、観測したremote state、次の安全なactionを報告する。
- **branch成功 / PR失敗:** branchや空commitを削除・force pushせず、同じhead/baseのPR有無を再取得する。PR作成の成否を一意に確定できる場合だけ続ける。
- **PR成功 / child失敗:** PRをcloseせず、作成済みchildと不足childを再取得で区別する。immutable execution contextを維持できる場合だけ不足分を続行する。
- **relationのpartial success:** 作成済みparent/dependency relationを両方向から再取得し、残るwriteが重複や既存topology破損を起こさない場合だけ続ける。

どの段階でもacceptance unknownの操作を自動retryしない。既に作成した親Issue、branch、PRを破壊的にdelete・close・force pushしてrollbackしない。安全に続行できない場合は停止し、部分成果物、確定済みstate、曖昧なstate、必要なnext actionを報告する。

## 最終検証・報告

以下を再取得結果とともに報告する。

- 親Issue番号・URL。
- exact feature branch、起点となった最新default branch commit、空commit SHA、remote head。
- integration PR番号・URL・base・head・state・non-draft状態・exact `Closes #<親Issue番号>`の存在。
- 全child Issueと、各bodyに記載したmerge-target branch、integration PR link。
- 両方向で検証したnative parent topology、最小blocker edge、parallel lane。
- partialまたはambiguous failure、未完了resource、次の安全なaction。部分的にしか検証できないworkflowを完了扱いしない。
