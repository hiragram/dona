# 承認運用の検証済み観測

Issue #24の運用機能のうち、内部read-only観測を提供する。公開CLIやruntime readinessの完成を意味しない。

`ApprovalOperations`は既存の共有監査、record repository、保護clock履歴を使用する。scopeはinstance/workspaceの両方へ固定する。request handleは認可proofではなく、内部workerの候補だけである。公開する場合はcurrent operator認可と安全な投影が別途必要になる。

## expiry候補

`expiryPage({limit, after})`は1〜100件のrequestを走査してから期限でfilterする。`next_after`は期限に達したhandleの最後ではなく、走査した候補の最後を返す。返却handleが空でも`has_more`がtrueなら後続pageを確認する。SQLのstate/期限で候補を先に除外せず、監査rootに結び付いたrecordを再読する。SQL件数と監査付きmanifestが一致しない場合は失敗する。

期限は保護されたeffective UTCへ照合し、clock履歴欠落、boot変更、大きなclock jump、監査不一致では候補を返さない。観測はclock markとaudit anchorを更新しない。内部expiry workerは既存`ApprovalDecisionBroker.expire`で各handleの期限をtransaction内で再検証する。候補一覧だけで状態変更を承認しない。

## healthとmetrics

`health()`はlivenessとsafe readinessを分離する。内部recordの検証成功だけではoperator認可、配送、executor、retentionを証明できないため、`live: true`、`ready: false`を維持する。expiry lag、stale claim、execution/deliveryのunknown、needs_reviewを件数だけで返す。各collectionは最大100件まで検証し、それを超える場合もdegradedを返す。大規模datasetの全体件数を推測しない。

`metrics()`は固定名のPrometheus形式でliveness、safe readiness、観測の検証成否と検証済み件数だけを返す。検証失敗時は状態別の件数を出力しない。retentionの未検証値もゼロへ置き換えない。handle、action body、private context、token、private URLはlabelや値に使用しない。

## 未接続の運用境界

以下はIssue #24の残作業であり、この観測を有効なwrite経路やIssue全体の完了として扱わない。

- current operator認可をtransaction内で再検証するCLI、filter/pagination、dry-run、explicit confirm。
- providerのdurable evidenceとoperator reasonに結び付いたreconcile。0件・複数件・不一致を成功とみなさず、自動再送しない。
- 常駐expiry sweepの接続と重複・restart・障害試験。
- active/needs_reviewとunknown acceptanceを保護するretention、期限overdueの観測。one-shot fence、marker、audit continuityを削除して再実行可能にしない。
- SQLite Online Backupとrestore後のinstance/binding/clock/audit continuity検証。検証不能ならsafe-off/needs_reviewにする。旧backupで保護anchorを巻き戻さない。

実operator認可・transport evidence・runtime接続は共有基盤の内部authority callbackの存在だけで供給済みと扱わない。統合先は`integration/issue-26-supervisor-approval`であり、mainへの統合とproduction gateはIssue #25に残す。
