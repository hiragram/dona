# 無効なJob Resultのoperator解決

現在、以下のoperator解決コマンドは、独立したhost/supervisorのmaintenance fence receiptを検証する経路が未実装のため、`maintenance_fence_receipt_required`で停止する。DB内のidentity generationと`session_absent` receiptはrollback可能で、worker停止の十分な証明にはならない。以下の手順は外部フェンス実装後の照合要件として維持する。必要な契約は[旧job復旧gate](legacy-job-recovery-gate.md)を参照する。

## 遅れて公開された正常なfinal Resultの単一job照合

`needs_review`の原因が`result_missing`、`invalid_result`、`invalid_result_agent_stopped`で、DBにResultが未受理の場合だけ使用する。schedule所有jobや過去のjob群を一括処理しない。

1. `job inspect-late-result <job_id>`で現在の`updated_at`、原因、final ResultのSHA-256、通知証跡のSHA-256を読む。invalid final、欠落、symlink、1 MiB超過は受理対象にしない。
2. 独立したmaintenance fence receiptでworkerの停止を確認し、`job show <job_id> --live-session`で同一jobの最新receiptを保存する。受理時には識別済みagentの現在のidentity generationに束縛された`session_absent`の最新receiptも必要となる。`not_addressable`、timeout、稼働中、古いreceipt、rollback前のidentityに対するreceiptは停止証明にならない。
3. branch、PR、Issue、外部操作の副作用を確認し、その証跡文書のSHA-256を`side_effects_evidence_sha256`として保管する。通知についても既存eventの配送有無と曖昧なwriteがないことを確認する。`inspect-late-result`の通知digestは現在のDB投影へのCASであり、operatorの確認を代替しない。
4. 確認済みの値だけで`job accept-late-result <job_id> <expected_updated_at> <expected_cause> <result_sha256> <stop_receipt_id> <side_effects_evidence_sha256> <notification_evidence_sha256> --worker-stopped-reviewed --side-effects-reviewed --notification-reviewed`を一度呼ぶ。応答喪失時は`job show`と`inspect-late-result`で状態を再読し、同一引数以外のwriteを行わない。

受理は単一DB transactionでjobの状態・原因・更新時刻、最新停止receipt、Result bytesのdigest、通知状態を照合する。未配送通知だけを抑止し、配送済みのattentionは確認済みの場合だけ保持して解決記録を追加する。外部操作のない完了済みprogress通知も保持する。曖昧な通知や既存のall-terminal通知がある場合は拒否する。元のResult fileと通知event IDを書き換えず、確定状態の通知を作る。受理記録はappend-onlyで、参照された停止receiptは外部キーで削除を禁止する。旧jobの自動受理、Result修復、worker再実行、Project担当変更は行わない。

通常jobのResultが検証に失敗した場合、Dispatcherは`needs_review`へ隔離する。実作業や外部操作が済んでいる可能性があるため、同じjobを再投入しない。

1. `job show <job_id> --live-session`で最新のreceiptを取得する。`not_addressable`はworker停止の証明ではない。利用できる運用手段でworkerの終了を別途確認する。
2. 既存branch、Pull Request、Issue、外部操作の証跡を照合し、未記録の副作用と残作業を確認する。
3. 確認できた場合だけ、表示された`receipt_id`とjobの`updated_at`を使い、`job resolve-invalid-result <job_id> <receipt_id> <expected_updated_at> --worker-stopped-reviewed --side-effects-reviewed`を実行する。これは旧jobを`failed`へ確定し、未配送の旧通知を抑止して確定状態の通知を作る。Resultの修復、再実行、Project担当の変更は行わない。
4. `job show <job_id>`で`failed`と`invalid_result_operator_resolved`を再読する。Projectの担当引継ぎは、既存成果と明示指示を確認してからIssue lifecycle手順に従って別途行う。

状態、現在のidentity generation、最新receipt、Result有無、更新時刻が一致しなければ操作は失敗する。worker停止または副作用を確認できない場合は`needs_review`を維持する。schedule所有jobは専用のreconciliation経路を使用する。

## 旧方式Resultの生成・公開前検証

`completed_at`は末尾`Z`のUTC RFC 3339とする。秒のみ、または1桁以上の小数秒（3・6・9桁を含む）を受理し、文字列の精度を保存する。Pythonの6桁精度は拒否理由ではない。数値offsetの`+00:00`、`-00:00`、非UTC offset、timezone欠落は拒否する。

- Node: `new Date().toISOString()`
- Python: `datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')`

この置換はUTCを指定して生成した値だけに適用する。任意文字列や非UTC offsetを機械的に`Z`へ付け替えない。共有validatorは年0000〜9999のGregorian暦日と時刻00:00:00〜23:59:59を検証し、閏秒・24時・存在しない日付を拒否する。`Date.parse`だけでは2月30日などが正規化されるため妥当性検証にならない。小数秒の丸めや不正値の救済は行わない。この共有検証はJob Resultに加え、Event（internal update/scheduleを含む）の`occurred_at`とEvent Resultの`completed_at`にも適用される。

新規candidateは契約のresult_pathと同じディレクトリのtmpへmode 600で書き、稼働Dispatcherと同じbuildのread-onlyコマンドで検証する。promptにはそのbuildのコマンド位置が含まれる。開発checkoutではdispatcherで`npm ci`と`npm run build`後に次を実行できる。引数は信頼できるjob契約と自分で作成したtmpから指定する。

```sh
node dist/job-result-validate.js "$candidate_path" "$dispatcher_job_id"
```

exit code 0の場合だけ同一filesystem内でatomic renameし、finalを同じコマンドでread-backする。JSON parse成功・JSON往復一致だけをschema検証と呼ばない。コマンドはreaderと同じサイズ制限、JSON parse、`parseJobResultEnvelope`、job ID照合を使用し、書き込みを行わない。検証失敗時はrenameせず、既存finalを上書きしない。利用不能時も未検証の公開へ進まない。公開先が既に存在する場合は新規公開手順を止め、以下の照合へ進む。

## invalid / 曖昧publishのread-only照合

file有無、共通schemaの検証結果、DBのstatus・last_error_code・result_json有無・completed_at、最新receiptを区別して照合する。診断にはfield名と固定reasonだけを使い、raw Result、自由入力日時、秘密情報、private URL、local pathを転載しない。DBのResult未保存はfile不在や実作業未実行を意味しない。

- tmpが観測できない場合、当時のtmp bytesを推定しない。
- rename後の応答喪失は公開受理不明であり、同じwriteをretryせずfinalとDB/receiptを読む。
- schema正常でもDispatcherの受理・DB保存完了とは限らない。外部副作用は別の証跡で確認する。
- invalid finalは`invalid_result` / `needs_review`とResult未保存を維持する。診断や正しい生成例だけでcompletedへ進めない。

公開済みfile/DBを修正せず、旧jobを再投入せず、needs_reviewを自動解除しない。operator解決は上記の別途承認されたworker停止・副作用照合・receipt/CAS gateを引き続き必要とする。この検証コマンドは新publish API、migration gate、recovery protocolを置き換えない。

schedule workerでは固定PATHに依存せず、稼働Nodeの絶対パスとbuild時に同じreader/schemaから生成した単一bundleを使う。sandboxにはその2つとNodeのロード済み共有ライブラリの実体ディレクトリだけをread許可し、releaseディレクトリやnode_modules全体は許可しない。macOSでは検証コマンド内だけの`DYLD_LIBRARY_PATH`をその実体ディレクトリへ固定し、許可外のHomebrew opt symlink走査を避ける。OpenSSL設定は`--openssl-config=/dev/null`へ固定し、ホスト設定のread許可は追加しない。共有ライブラリの実体が`lib`/`lib32`/`lib64`以外に置かれている環境ではfail-closedとする。既存のroot deny・network無効・workspace read-onlyを維持する。起動前probeは同じsandboxで正常fixtureの受理と不正fixtureの拒否も確認し、検証経路が利用不能ならworkerを開始しない。開発時もschedule利用前には`npm run build`が必要である。
