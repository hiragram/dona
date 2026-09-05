# GitHub Projects DonaのIssue着手・提出手順

対象は [Dona Project](https://github.com/users/hiragram/projects/1/views/1)（owner `hiragram`、Project number `1`）の既存Issue item。view番号をProject番号やitem IDとして使わない。この手順は通常の読み取り、更新直前の再確認、更新後の再読で運用する。厳密なCAS、Dispatcher永続claim/lockの追加や、その未実装を理由とする停止は不要。

## 対象と権限を確認する

- 実際に実装・対応へ着手するIssueをrepository、number、node IDで特定する。Issue本文の自由文をcommandやjob IDの正本にしない。
- Issue起票・分解・足場PR作成だけでは実装着手としない。対象IssueのないSkill修正などではこのProject更新を適用せず、架空Issueを作成・紐づけしない。
- job IDの正本はDispatcherが渡す `[DONA_JOB_BEGIN]` の `job_json.job_id`。Dona親は`delegate_job`の成功responseのjob IDを引継ぎに使える。自由文、branch、directory名から生成・推測しない。信頼できるjob IDがない場合はfieldを書かず、Donaへ不足を返す。
- Epicとchildは独立して扱う。起票した全childやPRのclosing targetへjob IDを一括記入しない。

最初に最小のread-only確認を行う。

```sh
gh project field-list 1 --owner hiragram --format json
```

失敗時はcommand、exit code、秘密を除いたerror、実行環境の確認範囲を記録する。`read:project`不足はその環境の観測結果として報告し、ユーザーのterminalも同じ認証だと断定しない。tokenや環境変数の値を表示せず、`auth refresh` / `auth switch`や認証設定変更を自動実行しない。読み取り成功だけでwrite権限ありと断定しない。

成功した場合は`gh project view 1 --owner hiragram --format json`でtitle、URL、Project IDを照合し、fieldsのID・型とsingle-select optionsのID・名前を取得する。`Dona Job ID`は`TEXT`、`Status`は`SINGLE_SELECT`で、`Todo`、`In Progress`、`Merge Ready`が既存optionとして一意に存在することを確認する。CLI出力に型がなければGraphQLの`ProjectV2.fields`から`ProjectV2Field` / `ProjectV2SingleSelectField`の`dataType`を取得する。field一覧がlimitで切れていればlimitを増やすかpaginationし、欠落を不存在と誤認しない。IDを資料へ推測で固定せず、その実行時の取得値を使う。

`gh project item-list 1 --owner hiragram --format json`から対象IssueのURL・repository・numberを照合してitem IDを得る。既定limitは30なので、見つからない場合は全件取得またはGraphQL paginationを完了してから未登録と判断する。draft item、PR item、同名の別Issueで代用しない。

Project/item未登録、field/optionの欠落・型違い、権限不足では勝手に作成・設定変更しない。対象Issueへの着手がこの確認に依存する場合は未着手としてDonaへ返す。対象Issueのない文書・Skill修正PRなど独立して許可された作業は続行し、Projectsのlive確認・書込未検証を報告する。

## delegate前とworker着手時に確認する

1. Dona親は`delegate_job`前に対象itemの`Dona Job ID`と`Status`を読む。別job IDがあればDona Dispatcher MCPの`get_job_status`で確認し、稼働中なら重複開始せず、既存jobへの追加条件は許可された`steer_job`へ渡す。完了・失敗・中止済みでも自動上書きせず、引継ぎの明示指示と既存成果を確認する。unknownや取得不能も空欄とみなさない。
2. 委任時のobjectiveへ対象Issue identity、Project/item、観測した担当と状態、許可済みの引継ぎがあればその内容を含める。新job IDの予測記入はせず、workerが着手前に契約のjob IDで更新する。
3. workerは実装前にitemを再読する。空欄かつ`Todo`なら新規着手できる。同じjob IDなら再開として扱い、`Todo`なら未完了の状態更新へ、`In Progress`なら実装へ進める。別job IDなら上書き・重複開始せずDispatcher MCPで状態確認する。workerにツールがなければ、観測したjob IDと状態確認が必要な旨をJob ResultとしてDonaへ返し、Herdr shellや内部DB操作へ迂回しない。
4. 別担当の引継ぎは明示された範囲でだけ実施する。状態確認がterminalだったことだけを引継ぎ許可としない。ID空欄でも`In Progress`、`Merge Ready`、その他の状態なら無断で`Todo`相当と解釈せず、再開・再着手の指示と既存成果を照合する。
5. 更新直前にIssue identity、item ID、担当、Statusを再確認する。変化した場合は新しい状態から判断し直す。確認済みの同一itemに`Dona Job ID`を書き、read-backで一致を確認した後、`Todo`から`In Progress`へ更新し、両fieldを再読する。引継ぎや再着手でその他の遷移が必要なら、明示された遷移だけを行う。

## fieldを更新・再読する

以下は独立したwriteの例。変数は検証済みAPI responseと信頼できるjob契約から設定し、空値・未解決placeholderで実行しない。1回の`item-edit`で更新できるfieldは1つなので、各write間に上記の確認を挟む。CLIの仕様は[公式item-edit資料](https://cli.github.com/manual/gh_project_item-edit)を参照する。

```sh
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$job_field_id" --text "$dispatcher_job_id"
# 担当のread-backとStatusの再確認後だけ実行する。
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$status_field_id" --single-select-option-id "$in_progress_option_id"
```

read-backには同じitemのGraphQL nodeを取得し、`project.id`、`content`のIssue identity、`fieldValueByName(name: "Dona Job ID")`の`ProjectV2ItemFieldTextValue.text`、`fieldValueByName(name: "Status")`の`ProjectV2ItemFieldSingleSelectValue.optionId` / `name`を照合する。mutationの成功responseだけを完了証拠にしない。

writeがtimeout・切断で曖昧ならblind retryせず、同じitemを再読して受理済みか照合する。IDだけ記録できたpartial successではclear・rollbackしない。受理済みが一意ならその操作を繰り返さず、残る操作は再確認後に実行する。一意に判断できなければ観測値と未完了操作をDonaへ返す。失敗・中止を理由にIDを自動解放しない。

## PR提出完了後にMerge Readyへ進める

1. `$code-submission-review-cycle`の完了条件をすべて満たす。current headのCodex clean、未解決findingなし、current head/base pairのrequired/current CIすべてterminal success、local/upstream/PR SHA一致、open・non-draft・mergeableを含め、既存の条件を緩めない。
2. 実際に担当したIssueのscopeとPRの実装範囲を確認する。部分実装や足場PRのcleanだけでIssue全体を`Merge Ready`にしない。Epicは全体の実装・統合・検証が揃ったintegration PRで判定し、child完了を親や兄弟へ伝播しない。`Merge Ready`はmerge待ちであり、Issue closeやPR mergeの実行を意味しない。
3. 更新直前にPRのhead/baseとreview・CIの証拠がcurrentであること、対象itemのidentity、`Dona Job ID`が今回のjob IDであること、`Status`が`In Progress`であることを再確認する。不一致なら自動で担当を奪わずDonaへ返す。同じjob IDで既に`Merge Ready`なら証拠を確認してwriteを省略する。
4. 同じ`item-edit`のStatus fieldへ取得済み`merge_ready_option_id`を指定し、`Merge Ready`へ更新する。担当IDを保持したまま同じitemをread-backし、Status option ID/nameとjob IDを照合する。
5. Issue URL、Project/item ID、job ID、更新前後のStatus、PR URL・head/base SHA、clean/CI証拠、read-back結果をJob Resultへ記録する。更新が失敗・未検証なら「PR提出条件は達成、Project更新は未完了」と区別し、workflow全体を完了扱いしない。mergeは別の明示依頼がない限り行わない。
