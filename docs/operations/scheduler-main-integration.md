# Schedulerとcurrent mainの統合検証

Epic #4のfeature完成と、main採用・本番起動は別の完了点として扱う。#132の実装PRは`feature/durable-scheduler`へ統合し、integration PR #43のcurrent head/main pairでもCIとCodex reviewを確認する。#43のmerge、self-update、live Slack送信はこの検証では行わない。

## 合成した契約

- core schema v3と独立scheduler schemaを同一DBで保持する。既存v2はrelease manifestなしでv3 writeへ切り替えず、明示した移行ではjob key、group claim、legacy worker停止記録を保持する。
- 通常jobは作成時のcanonical payloadとobjective byteでidempotency・quotaを判定し、後続steerは作成時fingerprintを変更せず、連結後の実サイズを別途transaction内で制限する。後続jobのadmissionでも実サイズ上限を検査する。fingerprintのないlegacy jobは保存payloadの完全一致時だけreuseし、不一致やsteer後の元payloadを確認できない場合はconflictとして拒否する。read-only照合は`unverified_legacy`のまま扱い、fingerprintを推測しない。
- scheduled workは保存したobjectiveを空白も含めて維持し、owner/run/source、read-only workspace、expiry、access receiptを検証する。通常groupとscheduled runのterminal経路を分離する。
- 通常jobの公平性、per-event concurrency、bounded prompt reconcileと進捗通知を保持する。scheduled jobのprompt受理不明は`needs_review`としてResult回収・取消・期限処理へ送り、promptを再送しない。通常progress経由のSlack送信と進捗directoryのwrite grantはscheduled jobに与えない。
- 通常groupの最終通知をclaimした後は残りjobを同じ通知へ結び付け、追加通知を生成しない。取消時は未送信の旧attentionを無効化し、送信中ならreconcileを要求する。
- scheduleの9ツールと既存owner/access/notification toolをMCP設定へ登録し、150秒のtool timeoutを維持する。設定の存在は本番での提供・送信成功の証拠にはならない。

## 再現と証拠

各packageで`npm ci`後、rootで`npm run verify`を実行する。schedulerの既存gateは49件・failure 0・skip 0を固定して検査する。Dispatcherの各test fileは逐次実行し、nonce付きcheckpointで失敗箇所を記録する。テスト数が増えても15分のpre-activation上限と1,000 byteの永続診断上限は延長しない。

| 契約 | 主な検証 |
| --- | --- |
| fresh/v2から通常2件とscheduled 1件のdispatch | `mixed-owner-completion.test.ts`のUDS・supervisor matrix |
| completed/failed/blocked、missing/invalid Result | 同matrixをfresh/v2の両方で実行 |
| commit前failure、duplicate、reopen、owner/run改変 | 同testと既存scheduler integration gate |
| 通常group・fairness・caller識別 | `database.test.ts`、`job-supervisor.test.ts`、`caller-contract.test.ts` |
| 全9ツールの登録・許可・転送・revision | `caller-contract.test.ts`のMCP→UDS→repository test |
| scheduled progressの遮断・grant制限 | `job-progress.test.ts`、`job-runtime.test.ts` |
| receipt・redaction・expiry/cancel・曖昧write | 既存scheduler、notification、Slack connector suites |

local macOSの全検証とGitHub CIを区別する。Linux CIではUpdaterのmacOS固有2件がplatform skipになるため、CIの成功をskip 0とは表現しない。fake runtime/providerの呼び出し回数は検証できるが、本番Slack/providerの受理、production activationのterminal結果は未検証である。

非互換なschema transitionのplanは`rollback_compatible: false`を明示する。target異常時は`rollback_not_safe_or_circuit_open`の`needs_review`へ移り、schema v3を読めない旧runtimeを自動起動しない。復旧可能なrollbackを保証するplanとは区別し、承認済みplan以外の本番移行は行わない。

失敗したmigration後にv2 runtimeが処理を再開してbackupと乖離した場合、健全なv2 DB同士かつreceipt不在を確認して古いbackupを退避し、現在DBからOnline Backupを再取得する。receiptが存在する不一致やv3 DBの不一致は自動置換せず照合エラーを維持する。通常jobの取得にも現在source_event_idのowner確認を必須とする。
