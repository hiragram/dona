# 無効なJob Resultのoperator解決

通常jobのResultが検証に失敗した場合、Dispatcherは`needs_review`へ隔離する。実作業や外部操作が済んでいる可能性があるため、同じjobを再投入しない。

1. `job show <job_id> --live-session`で最新のreceiptを取得する。`not_addressable`はworker停止の証明ではない。利用できる運用手段でworkerの終了を別途確認する。
2. 既存branch、Pull Request、Issue、外部操作の証跡を照合し、未記録の副作用と残作業を確認する。
3. 確認できた場合だけ、表示された`receipt_id`とjobの`updated_at`を使い、`job resolve-invalid-result <job_id> <receipt_id> <expected_updated_at> --worker-stopped-reviewed --side-effects-reviewed`を実行する。これは旧jobを`failed`へ確定し、未配送の旧通知を抑止して確定状態の通知を作る。Resultの修復、再実行、Project担当の変更は行わない。
4. `job show <job_id>`で`failed`と`invalid_result_operator_resolved`を再読する。Projectの担当引継ぎは、既存成果と明示指示を確認してからIssue lifecycle手順に従って別途行う。

状態、最新receipt、Result有無、更新時刻が一致しなければ操作は失敗する。worker停止または副作用を確認できない場合は`needs_review`を維持する。schedule所有jobは専用のreconciliation経路を使用する。

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
