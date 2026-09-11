# Supervisor approval decision / contract fixtures

この文書は[ADR 0001](../0001-supervisor-approval.md)の実装・review用fixtureです。値は説明用であり、production ID、credential、Slack本文ではありません。

## Decision transition table

| Case | Initial | Input / current condition | Expected | External write |
| --- | --- | --- | --- | --- |
| approve | `sent` | binding、coordinates、期限が一致 | `approved` | なし |
| reject | `sent` | supervisorがreject | `rejected` | なし |
| requester cancel | `requested` / `sent` | decision未確定 | `cancelled` | なし |
| expire | nonterminal | request TTL超過 | `expired` | なし |
| duplicate approve | `approved` | 同じproof再送 | 元decisionを返す | なし |
| replay from another message | `sent` | message/action不一致 | 状態不変、audit | なし |
| non-supervisor | `sent` | actor binding不一致 | 状態不変、audit | なし |
| cross-workspace | `sent` | team/instance不一致 | 状態不変、audit | なし |
| approve vs cancel | `sent` | 同時transaction | 一方だけterminal | なし |
| binding rotation | nonterminal / `approved` | revision変更 | `needs_review` | なし |
| policy risk increase | nonterminal / `approved` | policy revision変更 | `needs_review` | なし |
| model-only update | nonterminal | enforcement revision不変 | 状態維持 | なし |
| cancel after approve | `approved` | consume claim前 | `execution_cancelled` | なし |
| expire after approve | `approved` | consume TTL超過 | `consume_expired` | なし |
| clock rewind after restart | nonterminal / `approved` | wall clockがdurable high-water markより前 | `expired`または`needs_review` | なし |

## Consume / execution transition table

| Case | Preconditions | Expected attempt/result | Retry rule |
| --- | --- | --- | --- |
| normal consume | approved、consume TTL内、全binding一致 | `claimed -> executing`、consumeは一回 | 同じapprovalで再claim不可 |
| concurrent consume | 2 workerが同時claim | 1件だけattempt作成 | loserは既存attemptを参照 |
| snapshot tamper | hashまたはcodec不一致 | `needs_review`、attemptなし | 再生成した別requestが必要 |
| resource drift | thread/resource revision不一致 | `needs_review`、attemptなし | 自動retry不可 |
| consume expiry | consume TTL超過 | attemptなし、expired扱い | 再承認が必要 |
| known rejection | APIが決定的拒否 | `failed` | 同じwriteを再送しない |
| timeout after send | acceptanceを証明不能 | `acceptance_unknown` | read-only reconcileのみ |
| reconciled accepted | exact idempotency key/resultを発見 | 同じattemptを`succeeded`へ更新 | 新attemptを作らない |
| reconciled rejected | exact rejection receiptを発見 | 同じattemptを`failed`へ更新 | 新attemptを作らない |

## Delivery attempt transition table

| Case | Initial | Observation | Expected |
| --- | --- | --- | --- |
| post accepted | `pending` | exact message identityを取得 | `sent` |
| post rejected | `pending` | Slackの決定的error | `failed` |
| post timeout | `pending` | acceptanceを証明不能 | `acceptance_unknown`、再投稿禁止 |
| unknown reconciled sent | `acceptance_unknown` | saved presentation identityがexactly 1件 | 同じattemptを`sent`へ更新 |
| unknown reconciled absent | `acceptance_unknown` | bounded全page確認で不存在を証明 | 同じattemptを`failed`へ更新、別送信は新しい明示操作 |

## Typed action fixture: `slack.post_thread_reply.v1`

```json
{
  "codec_version": 1,
  "operation_kind": "slack.post_thread_reply.v1",
  "instance_id": "instance_example",
  "workspace_id": "workspace_example",
  "target": {
    "channel_id": "channel_example",
    "thread_ts": "1700000000.000001"
  },
  "policy": {
    "reply_broadcast": false,
    "special_mentions": "deny_all",
    "allowed_user_mentions": ["user_example"],
    "max_user_mentions": 3
  },
  "encrypted_content_ref": "payload-store:content_example",
  "content_hmac_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "preconditions": {
    "thread_exists": true,
    "root_message_revision": {
      "edited_ts": "1700000001.000001",
      "content_hmac_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "workspace_binding_revision": 3
  }
}
```

CanonicalizationはUTF-8、field名の辞書順、整数/boolean/string/nullの型維持、未知field拒否、codec version必須とします。action hashはcanonical byte列のSHA-256です。本文そのものはsnapshot、audit、button valueへ含めず、最大20分の暗号化payload storeからexecutor直前に取得してserver-side HMACを再検証します。content HMACとroot message HMACはUIへ表示しません。rootが未編集なら`edited_ts`の明示的なnullと内容HMACを保存し、consume時に両方を再取得します。

期待する否定fixture:

- `operation_kind`を任意のtool名へ変更するとunknown operationで拒否
- `workspace_id`、channel、thread、broadcast flag、mention policy、content HMAC、root revisionのどれか一つでも変更するとhash不一致
- 別instance、別binding revision、別requestのdecisionを転用するとconsume拒否
- DM/private thread由来contextをpresentationへ追加するとdata-classification test失敗
- `<!channel>`、`<!here>`、user group、allowlist外または4名以上のuser mentionはgatewayとexecutorの両方で拒否

## Threat review scenarios

| Scenario | Presentation | Required proof | Expected |
| --- | --- | --- | --- |
| public thread、安全なprojection | policyが明示許可すればthread可 | supervisor membership、same team、exact coordinates | valid decisionのみ記録 |
| private channel | supervisor DMのみ、exact stable target ID/nameを表示 | same team/user/app、supervisorのcurrent channel visibility、saved DM coordinates | visibilityまたは安全なtarget表示がなければUIを作らない |
| DM / group DM | supervisor DMのみ、exact targetを表示 | sourceとdecisionのworkspace binding、supervisorが対象conversationを現在閲覧可能 | 参加者一覧・本文は非開示、visibility不明なら拒否 |
| cross-workspace actor | 表示済みでも無効 | team不一致 | ACK後拒否・audit |
| non-supervisor actor | 表示済みでも無効 | user/revision不一致 | ACK後拒否・audit |
| high-impact operation | UIを作らない | 独立second factor/二者承認contractなし | unsupportedでfail closed |

## Release-gate inventory fixture

実装IssueはMVP operationについて、次のinventoryをmachine-readable test fixtureへ移す必要があります。

1. Slack MCPのthread reply entry point
2. DispatcherからSlack outboxへ到達する内部entry point
3. background job結果からのreply entry point
4. recovery/reconcile経路からの再送entry point
5. test/admin/legacy CLIに残るwrite entry point

各entry pointは「typed gateway経由」または「approval-required時は決定的拒否」のどちらかを証明します。unknown/unclassified entry pointがあればrelease gateは失敗します。
