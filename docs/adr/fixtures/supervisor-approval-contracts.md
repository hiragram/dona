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
| cancel by another actor | nonterminal / `approved` | requester/instance/workspace/revision不一致 | 状態不変、audit | なし |
| restore without payload | nonterminal / `approved` | payload参照欠落またはHMAC不一致 | `needs_review` | なし |
| invalidate before delivery call | request terminal、attempt `pending` | 外部call未開始 | attempt `aborted` | なし |

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
| crash after external-call fence | durable stateが`executing` | 送信結果なしでrestart | 同じattemptを`acceptance_unknown`へ移す | read-only reconcileのみ、再送禁止 |
| claimed precondition drift | `claimed`、execution直前に期限/binding/thread/visibility不一致 | `needs_review`、外部callなし | 自動retry不可 |
| restore claimed/executing | payload欠落またはHMAC不一致 | `needs_review` | 再開・再送禁止 |
| reconciled accepted | exact idempotency key/resultを発見 | 同じattemptを`succeeded`へ更新 | 新attemptを作らない |
| reconciled rejected | exact rejection receiptを発見 | 同じattemptを`failed`へ更新 | 新attemptを作らない |

## Delivery attempt transition table

| Case | Initial | Observation | Expected |
| --- | --- | --- | --- |
| post accepted | `dispatching` | exact message identityを取得 | `sent` |
| post rejected | `dispatching` | Slackの決定的error | `failed` |
| post timeout | `dispatching` | acceptanceを証明不能 | `acceptance_unknown`、再投稿禁止 |
| crash after delivery fence | durable stateが`dispatching` | 結果なしでrestart | 同じattemptを`acceptance_unknown`へ移し、再投稿禁止 |
| request invalidated before fence | `pending` | requestがterminal | 同じtransactionで`aborted`、送信禁止 |
| unknown reconciled sent | `acceptance_unknown` | saved presentation identityがexactly 1件 | 同じattemptを`sent`へ更新 |
| unknown marker absent | `acceptance_unknown` | bounded全pageで0件 | `acceptance_unknown`のまま、再送禁止 |
| unknown marker ambiguous | `acceptance_unknown` | 複数件、pagination不完全 | `needs_review`、再送禁止 |

requestの`sent`は対応delivery attemptの`sent`と同じtransactionでだけ設定します。decisionは`synchronized sent`からだけ受理し、`delivery_failed`はterminal、`delivery_unknown`はreconcile待ちとしてapprove/reject actionを拒否します。requester cancelは`requested` / `delivery_pending` / `delivery_unknown` / `sent`からtransactionalに競合でき、cancel後に遅延deliveryが確定してもrequestを再び`sent`へ戻しません。

approval card送信前にdelivery attemptの`dispatching` fenceをdurable commitします。復旧した`dispatching`は送信済みか否かを推測せず`acceptance_unknown`へ移し、exact markerのread-only reconcileだけを行います。

binding rotation、policy risk increase、restore不整合は`requested` / `delivery_pending` / `delivery_unknown` / `sent` / `approved`のすべてから`needs_review`へ遷移でき、deliveryの遅着結果より先着したinvalid stateを維持します。全terminal/invalid stateで遅着cardが見つかった場合はdecisionを拒否し、exact cardをredactedな無効表示へ変える独立update attemptを作ります。

## Presentation update attempt transition table

| Case | Initial | Observation | Expected |
| --- | --- | --- | --- |
| update accepted | `dispatching` | decision/presentation revisionと一致 | `succeeded` |
| update rejected | `dispatching` | Slackの決定的error | `failed` |
| update timeout | `dispatching` | acceptanceを証明不能 | `acceptance_unknown`、再update禁止 |
| crash after update fence | durable stateが`dispatching` | 結果なしでrestart | `acceptance_unknown`へ移し、再update禁止 |
| stale before dispatch | `pending` | current desired revisionと不一致 | `aborted`、update禁止 |
| prior update unresolved | new `pending`、prior `dispatching` / `acceptance_unknown` | 同じmessage | 先行attemptの一意なterminalまで後続dispatch禁止 |
| update reconciled | `acceptance_unknown` | exact revisionが1件 | `succeeded` |
| update absent | `acceptance_unknown` | bounded全pageでrevision 0件 | `acceptance_unknown`のまま、後続update禁止 |
| update ambiguous | `acceptance_unknown` | revision複数件、pagination不完全 | `needs_review`、自動後続update禁止 |

presentation update attemptは初回delivery attemptと別recordにし、decision ID、presentation revision、channel/message座標へbindingします。`chat.update`直前に`dispatching`をdurable commitし、復旧した`dispatching`は無条件に`acceptance_unknown`へ移してread-only reconcileだけを行います。

## Pending notice delivery fixture

元threadのpending noticeはapproval cardとは別attemptとし、request ID、共通field `notification_attempt_id`、notification kind、server-side MACを含む認証済みmarkerへbindingします。外部call前の`dispatching` fence、復旧時の`acceptance_unknown`、全pageのexact marker reconcileはapproval card deliveryと同じ規則を使います。0件観測はunknownのままで再投稿しません。request terminal時に未開始の`pending` notice attemptは同じtransactionで`aborted`にします。

## Typed action fixture: `slack.post_thread_reply.v1`

```json
{
  "codec_version": 1,
  "operation_kind": "slack.post_thread_reply.v1",
  "instance_id": "instance_example",
  "workspace_id": "workspace_example",
  "request_source": {
    "source_event_id": "event_example",
    "owner_kind": "authenticated_event_actor",
    "owner_id": "user_requester_example",
    "operation_slot": "reply_1",
    "creation_key": "server-derived-instance-workspace-source-slot"
  },
  "target": {
    "channel_id": "channel_example",
    "thread_ts": "1700000000.000001"
  },
  "policy": {
    "reply_broadcast": false,
    "special_mentions": "deny_all",
    "allowed_user_mentions": ["user_example"],
    "max_user_mentions": 3,
    "shared_channel": "deny",
    "reconcile_marker": "block_id_attempt_id_mac_v1"
  },
  "encrypted_content_ref": "payload-store:content_example",
  "content_hmac_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "preconditions": {
    "thread_exists": true,
    "channel_is_shared": false,
    "root_message_revision": {
      "edited_ts": "1700000001.000001",
      "content_hmac_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "ordered_thread_revision": {
      "complete": true,
      "items": [
        {"message_ts": "1700000000.000001", "edited_ts": "1700000001.000001", "content_hmac_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
        {"message_ts": "1700000002.000001", "edited_ts": null, "content_hmac_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
      ]
    },
    "workspace_binding_revision": 3,
    "requester_authorization_revision": 7
  }
}
```

CanonicalizationはUTF-8、field名の辞書順、整数/boolean/string/nullの型維持、未知field拒否、codec version必須とします。semantic action hashはcanonical byte列のSHA-256です。requesterとsource ownershipは認証済みEvent Envelope actorまたはDispatcherの永続job ownerから導出してimmutableに結合し、外部本文やLLM出力から受け取りません。creation keyはinstance、workspace、source event/job、stable operation slotからserver-sideで導出し、同じkey/action hashは既存requestへ収束、hash不一致はconflictにします。instance、workspace、request source/owner、operation、target、policy、precondition、content HMACはsemantic action hashへ含めます。`encrypted_content_ref`、暗号nonce、ciphertextだけを対象外とし、creation key lookupをpayload allocationより先に行います。本文そのものはsnapshot、audit、button valueへ含めず、request中は最大20分の暗号化payload store、claim後はattempt専用の暗号化payloadからexecutor直前に取得してserver-side HMACを再検証します。content HMACとthread message HMACはUIへ表示しません。draft生成に使ったrootと全replyを、`message_ts`順の完全な集合、各`edited_ts`（未編集は明示的なnull）、content HMACとして保存します。consume時と`executing` fence直前に全pageを再取得し、追加・削除・並べ替え・編集のどれか一つでもあれば`needs_review`へ遷移します。認証済みapp author、request ID、共通の`notification_attempt_id`、notification kind、server-side MACが一致するDonaのpending/approval markerだけは会話context集合から除外し、本文やauthorだけでは除外しません。

request作成・decision・consumeの各時点で、supervisorのtarget visibilityと`channel_is_shared: false`を再取得します。approval cardにはexact target ID/表示名、復号したexact draft、解決済みmention対象を、mention/link/unfurlを発火しないescaped `plain_text`として表示し、表示内容のHMACがsnapshotと一致する場合だけactionを有効にします。claim時は暗号化payloadをattempt専用recordへ原子的に移し、外部送信のdurable terminal結果まで保持します。

送信時はexecution attempt IDとserver-side MACから一意な`block_id` markerを作り、Slack messageの本文を変えずblockへ保存します。送信前とtimeout後のread-backはchannel/threadの全pageを完走し、同marker 0件、exactly 1件、複数件を区別します。timeout後の0件は不在確定ではなくunknownのままです。pagination cursor欠落・反復、別Bot author、marker MAC不一致はreconcile成功にしません。

期待する否定fixture:

- `operation_kind`を任意のtool名へ変更するとunknown operationで拒否
- `workspace_id`、channel、thread、broadcast flag、mention policy、content HMAC、root revisionのどれか一つでも変更するとhash不一致
- 別instance、別binding revision、別requestのdecisionを転用するとconsume拒否
- DM/private thread由来contextをpresentationへ追加するとdata-classification test失敗
- `<!channel>`、`<!here>`、user group、allowlist外または4名以上のuser mentionはgatewayとexecutorの両方で拒否
- Slack Connectを含むshared channel、または承認後にshared化されたchannelはrequest/decision/consumeで拒否
- supervisorがprivate targetから外れた場合はdecision/consumeを`needs_review`へ遷移
- claim直後のcrashでもattempt専用暗号化payloadから同じ本文を復元し、別attemptは作らない
- external-call開始fence後のcrashでは復旧時に同じattemptをunknownへ移し、marker 0件でも再送しない
- claim復旧後もexecution期限と全preconditionを`executing`直前に再検証し、drift時は外部callなしで`needs_review`
- approval decisionとstable `dona_approval` outbox rowを同じtransactionで一度だけ作り、restart後はoutboxからresume
- requester/source ownerを認証済み起点から導出し、別actorを指定したsnapshotを作成拒否
- 同じmessageのpresentation updateを直列化し、stale pendingをabort、先行unknown中は後続dispatch禁止
- Dona自身の認証済みpending/approval markerだけをthread revision比較から除外
- 同じsource/operation slotの作成retryは同じrequestへ収束し、action hash不一致はconflict
- pending noticeも専用attemptと開始fenceを持ち、timeout後0件では再投稿しない
- restoreしたbinding/policy generationが保護されたhigh-water mark未満なら二者再承認までfail closed
- high-water markの欠落、読取不能、integrity不明も二者再承認までfail closed
- policy緩和はexact digestと次generationに対する独立actor二人のauthorizationが必須
- 時刻high-water markはbackup外へ保存し、restore/restart時の欠落や巻戻しで全未完了requestをfail closed
- approval cardのdispatching直前にvisibility/shared状態を再検証し、不一致なら送信せずpayload削除
- 本文不要となる全terminal/invalid request transitionでpayloadを同一transaction削除
- credential storeへ時刻mark reservationをDBより先にdurable commitし、失敗/不明ではDB writeを開始しない
- 時刻mark reservationは直前markを条件とするCASで直列化し、stale/競合/小さい遅着writeを拒否
- binding/policy次generationも二者承認済みdigestとともにDB前のCASでreserveし、未使用reservationはreconcileまでfail closed
- request作成、decision、consume、executing直前にrequesterのcurrent membership/operation authorizationを再検証
- approval deliveryのdispatching transactionでTTL、binding/policy、requester、visibility、shared状態を再検証
- pending noticeのdispatching transactionでもcurrent request state/revisionとTTLを再検証
- 同一boot IDのcontinuous clockだけをprocess再起動後の経過証明に使い、boot変更/証明不能なら未完了requestを失効
- boot変更/経過証明不能ではclaimed attemptを外部callなしでneeds_review、executingをunknown経由のneeds_reviewとしてpayload削除
- restore current binding/policyはgenerationに加えて予約済みcanonical digestとcommit transaction IDも完全一致必須
- audit sequence/previous MACのhash chainをDB外のCAS末尾anchorまで検証し、欠落・切断・未finalizeをfail closed
- terminal requestへ遅着したpending noticeはstateを戻さず、直列化したupdate attemptでterminal表示へ変更
- retained auditはrecordの`key_version`でverification-only keyを選び、保持期間中の欠落/不明keyを検証成功にしない
- execution attemptが`needs_review`へ収束した時点でattempt専用暗号化payloadを即時削除し、全状態を通じた最大保持を24時間に制限
- interactive commandはenvelope ID、connection provenance、actor proofとともにdurable inboxへ保存してからACKし、duplicateは一件へ収束

## Threat review scenarios

| Scenario | Presentation | Required proof | Expected |
| --- | --- | --- | --- |
| public thread、安全なprojection | policyが明示許可すればthread可 | supervisor membership、same team、exact coordinates | valid decisionのみ記録 |
| private channel | supervisor DMにexact target、draft、mention対象を表示 | same team/user/app、supervisorのcurrent channel visibility、saved DM coordinates | visibilityまたは安全な内容表示がなければUIを作らない |
| DM / group DM | supervisor DMにexact target、draft、mention対象を表示 | sourceとdecisionのworkspace binding、supervisorが対象conversationを現在閲覧可能 | 不要な参加者一覧は非開示、visibility不明なら拒否 |
| Slack Connect / shared channel | UIを作らない | request/decision/consumeでshared状態を再取得 | MVPでは常に拒否 |
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
