# ADR 0001: Supervisor approvalのtrust boundary・lifecycle・UX・運用方針

- 状態: Accepted
- 決定日: 2026-09-11
- 対象: [Issue #15](https://github.com/hiragram/dona/issues/15)
- 関連Epic: [Issue #26](https://github.com/hiragram/dona/issues/26)

## Context

Donaは会話の文脈から操作の危険性を評価できる一方、その評価や自然言語の「承認」をsecurity proofにはできません。本ADRは、transport-neutralなapplication approval coreとSlack固有の本人性証明の境界、承認要求から外部実行結果までのlifecycle、利用者への表示、運用時の安全側defaultを決定します。

対象は設計契約です。production code、SQLite migration、Slack Block Kit、実action executorは実装しません。具体例と否定ケースは[contract fixtures](./fixtures/supervisor-approval-contracts.md)に固定します。

## Security goalsとtrust boundary

### Assets

- 外部サービスへwriteする権限と認証情報
- supervisor binding、approval request、decision、consume ledger、execution attempt、audit
- private channelやDM由来の最小化されたaction context
- immutableなtyped action snapshotとcanonical hash

### Trust boundary

```text
untrusted conversation / LLM assessment
  -> DonaActionGateway: typed operationへ閉じ、canonical snapshot/hashを生成
  -> ApprovalBroker: policy、binding、期限、状態遷移を決定論的に強制
  -> ApprovalChannel: 最小表示projectionとopaque handleだけを配送
  -> SlackApprovalTransport: team/user/app/container/message/actionを検証
  -> ApprovalBroker: decisionをtransactionalに記録
  -> dona_approval event: one-shot consumeとTOCTOU再検証を要求
  -> OperationExecutorRegistry: allowlist済みtyped executorだけを呼ぶ
  -> external system: accepted / rejected / acceptance_unknownを別結果として保存
```

LLM、Slack本文、button value、元event、Codex host approvalは境界外の入力です。coreの正本はserver-sideのinstance/workspace binding、versioned policy、immutable action snapshot、durable stateです。transportはdecision actorの証明を返しますが、policyや実行許可を決めません。

## Threat model

| 脅威 | 攻撃・障害 | 決定論的mitigation | fail-safe結果 |
| --- | --- | --- | --- |
| なりすまし | 他user、別workspace、偽payloadがapproveする | instance、team、user、app、container、message、actionをpersisted bindingと照合 | decision拒否、audit |
| replay / duplicate | button再送、Socket再配送、二重consume | opaque one-time handle、decisionの一意制約、transactional one-shot consume | 元結果を返すか拒否、再実行しない |
| action差し替え | 承認後にtarget/argumentを変更 | versioned canonical snapshot/hashへdecisionをbinding | hash不一致で`needs_review` |
| TOCTOU | permission、resource revision、policyが変化 | consume直前にoperation固有preconditionとcurrent policy/bindingを再検証 | 実行せず`needs_review` |
| cross-workspace / instance | 同じuser IDやhandleを別境界へ転用 | instance ID、workspace/team IDをrequest/decision/consumeで一致確認 | 拒否、audit |
| stale approval | 期限切れ後やpolicy更新後に実行 | decision TTLとconsume TTLを別管理し、policy/model revision規則を適用 | `expired`または`needs_review` |
| cancel race | requester cancelとapproveが競合 | 単一transactionでterminal decisionを先着一件に固定 | 後着を拒否、実行は最大一回 |
| ambiguous write | timeout後に再送して二重作用 | attempt ID/idempotency key、read-only reconcile、blind retry禁止 | `acceptance_unknown` |
| confidential disclosure | private本文をsupervisorへ過剰開示 | exact targetのcurrent visibilityを確認し、本文由来digestを表示せず、暗号化短期payloadと最小projectionを使う | targetを安全に識別できなければrequest作成拒否 |
| legacy bypass | approval-required writeを旧経路が直接実行 | typed gatewayとexecutor allowlistへ集約し、全entry point遮断をrelease gate化 | feature `safe_off` |
| operator compromise | bootstrap/rotationで自己昇格 | local operator専用経路、明示確認、revision、二者監査、期限付きbreak-glass | binding不明時はfail closed |
| host approval confusion | Codex側のYesをDona承認へ流用 | approval ID、actor proof、action hashをapplication DBで独立検証 | host許可だけでは実行不可 |

## 決定事項

### 1. MVP typed operation

採用: 最初のoperationは`slack.post_thread_reply.v1`とします。保存対象はworkspace、channel、thread、reply policy、mention policy、redacted preview、server-side content MACで、executorへは暗号化短期payload storeから復号した本文を渡します。`<!channel>`、`<!here>`、`<!everyone>`、user group mentionは拒否し、明示user mentionはsnapshotのallowlistにある最大3名だけを許可します。任意のMCP tool名、任意JSON、DM新規送信、broadcast、reaction、GitHub/Notion/Figma/Drive write、production/self-updateは対象外です。

理由: Donaの主要経路でありながら、thread固定、broadcast禁止、workspace binding、message read-backにより作用範囲とacceptanceを狭く検証できます。安全側defaultは未知operation拒否です。operation追加はtyped schema、projection、precondition、idempotency/reconcile、bypass inventory、security fixtureを独立reviewできる場合だけです。

### 2. Supervisorへの提示場所

採用: 既定はbinding済みsupervisorへのDMです。元threadには秘密を含まないpending noticeだけを許可します。同じworkspaceの非private channelで、requesterとsupervisorが閲覧可能で、operation projectionが機密を含まず、policyが明示許可する場合だけthread内decision UIを使用できます。DM、private channel、group DM由来は常にsupervisor DMとし、supervisorのcurrent visibilityをSlack APIで証明でき、exact targetのstable IDと人間が識別できる表示名を安全に示せる場合だけUIを作ります。証明または表示ができなければfail closedします。

理由: 閲覧権限の推測と意図しない開示を避けます。安全側defaultはDMで、条件を証明できなければthread提示しません。将来変更はtransportごとのvisibility証明とredaction testが揃った場合だけです。

### 3. TTL

採用: request/decision TTLは15分、承認後のconsume TTLは5分です。request作成時の`expires_at`、approval時の`consume_expires_at`、transactionごとのUTC high-water markを同じdurable storeへ保存します。process内ではmonotonic elapsed timeとwall clockの大きい方を有効時刻とし、各transactionでhigh-water markを単調増加させます。再起動後にwall clockが保存済みhigh-water markより前、または許容driftを超える時刻異常なら、時刻が回復するまで全nonterminal/approved requestをexpireまたは`needs_review`としてfail closedし、期限を延長しません。

理由: 人間の判断時間とcontext driftを分離します。安全側defaultは期限切れです。変更はoperation risk、実測応答時間、incident記録を基にversioned policyで行い、既存requestへ遡及延長しません。

### 4. Cancelと競合

採用: requesterはdecision前のrequestをcancelできます。approve/reject/cancel/expireは単一decision slotをtransactionで先着確定し、後着は状態を変えません。approval後は未consume requestを`execution_cancelled`、期限切れを`consume_expired`、binding/policy/snapshot driftを`needs_review`へ遷移できます。これらとconsume claimは同一transactionで競合させ、先着した一つだけを確定します。claim取得後はexecutorを強制中断せず結果を追跡します。

理由: cancelを外部実行取消と誤認させません。安全側defaultは不明な競合を`needs_review`へ送ることです。将来、operation固有の補償操作は別typed actionとして設計します。

### 5. Bootstrap・rotation・break-glass

採用: bindingはDona instance ID、Slack team ID、supervisor user ID、revision、statusへ結合し、通常event/MCPから作成・変更できないlocal operator操作とします。rotation/revokeは旧revisionのpending/approved requestをinvalidateします。break-glassは二人のoperator確認、理由、最大30分、有効範囲、終了後reviewを必須とし、approvalを迂回せず一時supervisor bindingを発行します。

理由: approval経路による自己昇格を防ぎます。安全側defaultはbinding不在・競合・失効時のrequest拒否です。別IAM導入時もinstance/workspace/revision bindingと監査を弱めません。

### 6. High-impact action

採用: production activation、credential/権限変更、支払い、データ削除、広範囲通知、security boundary変更はMVP executor対象外で、単一Slack decisionでは実行できません。将来追加する場合は、Slackと独立したsecond factorまたは二者承認、かつoperation固有runbookを必須とします。

理由: 1アカウント侵害のblast radiusを限定します。安全側defaultはunsupportedです。二者承認は同一人物の複数credentialを人数として数えません。

### 7. Legacy direct-write移行

採用: (1) write entry point inventory、(2) gateway shadow assessment、(3) typed executor接続、(4)全entry pointでapproval-required operationをfail closed、(5)bypass test成功、の順で移行します。(4)まで外部自動実行は`safe_off`とし、Phase 1のrequest/decision UIを完成扱いしません。

理由: 新経路を追加するだけでは旧経路がsecurity boundaryを迂回します。安全側defaultは未棚卸しentry pointが一つでもあれば無効化です。削除ではなく明示的な拒否を先に導入し、rollback時もbypassを復活させません。

### 8. Retention・backup・暗号化

採用: request表示projectionとdecisionは90日、auditとexecution metadataは400日保持します。本文bindingにはapplication secretを使うHMACを用い、raw SHA-256 digestをUIや長期metadataへ残しません。承認待ちの生成本文だけはowner-onlyのapplication-level envelope encryption済みpayload storeへ保存し、鍵はDB/backupと分離したOS credential storeで管理します。payloadはrequest TTLとconsume TTLを合わせた最大20分だけ保持し、reject/cancel/expire/consume完了時に即時削除し、backup対象外にします。tokenとprivate download URLは保存しません。SQLite、backup、exportはowner-onlyとし、binding/audit HMAC keyは90日以内にrotationします。

理由: incident追跡とdata minimizationを両立します。安全側defaultは保存しないことです。legal/運用要件変更時はfield別classification、削除証跡、backup expiryを同時に更新します。

### 9. Private contextの開示

採用: supervisorにはoperation kind、requester、期限、リスク理由、本文から導出できないopaque action IDを表示します。本文、content MAC、添付、secret、private URLは表示しません。private targetではsupervisorのcurrent visibilityを証明したうえでexact stable target IDと表示名を示し、参加者一覧など追加contextは非表示にします。exact targetを識別できる安全なprojectionをoperation側が作れなければrequestを作らず、人間へ安全な別経路で確認を求めます。

理由: supervisor権限は全conversation閲覧権限を意味しません。安全側defaultは非開示・非実行です。将来変更はSlackのcurrent membership/visibility proofとfield単位の同意を要します。

### 10. Policy/model version変更

採用: enforcement policy、operation schema、binding revision、canonical codecが変わればpending/approved requestをinvalidateします。LLM/model versionだけの変更はassessment理由を再生成せず、enforcement policy revisionが同じなら既存requestを維持します。ただしrisk tierが上がるpolicy変更は全未consume requestを`needs_review`にします。

理由: LLMを許可主体にせず、security-relevantな変更だけを決定的に扱います。安全側defaultは分類不能な変更のinvalidateです。互換性はversioned migration matrixで明示し、range推測しません。

### 11. 既存schema・migration・outbox境界

採用: #3のEvent Envelopeには`source: dona_approval`のdiscriminantとversioned payloadだけを追加し、generic ingressを複製しません。#10のtyped outboxからclaim、known-rejected、acceptance-unknown primitiveを再利用し、approval delivery kindを分離します。#11のjob owner/result routingを使い、approval専用conversation ownershipを作りません。migrationはDispatcher DBの単調なversion順、transaction、restart互換、unknown version拒否に従います。

理由: 同じdurability primitiveの別実装によるraceと復旧差異を防ぎます。安全側defaultは共有contractが利用可能になるまで接続しないことです。scheduler Issueのparent、本文、close状態は変更しません。

## State machine

decision stateとexecution stateは別のrecordとして扱います。

```text
request:
  requested -> delivery_pending -> sent
  requested|delivery_pending|sent -> approved|rejected|cancelled|expired|needs_review
  approved -> consumed|execution_cancelled|consume_expired|needs_review

delivery attempt:
  pending -> sent|failed|acceptance_unknown
  acceptance_unknown -> sent|failed

execution attempt:
  not_started -> claimed -> executing -> succeeded|failed|acceptance_unknown
  acceptance_unknown -> succeeded|failed
```

- `approved`は外部実行の開始・受付・成功を意味しません。
- `consumed`は同じapprovalを再利用できないことだけを意味します。
- claim transactionはrequest、decision、binding、policy、snapshot/hash、expiry、operation preconditionを再検証し、consume ledgerとattemptを原子的に作ります。
- approved後の失効・取消とclaimは同じrequest revisionを条件に原子的に競合させ、失効済みapprovalをclaim可能なまま残しません。
- delivery attemptとexecution attemptの`acceptance_unknown`は独立して保存し、exact message identityまたはoperation固有receiptをread-only reconcileできた場合だけ同じattemptをterminalへ収束させます。
- `acceptance_unknown`から同じwriteを自動再実行しません。read-only reconcileで一意に確定できる場合だけ既存attemptの結果を更新し、別attemptを作りません。

全transitionのdecision tableはfixtureに記載します。

## Slack transport decision proof

button valueにはopaque request handleとpresentation revision以外を含めません。Socket ModeにはHTTP Request Signing相当の署名付きrequestがないため、workspace別の認証済みSocket接続をprovenanceの起点とします。接続確立時に認証済みteam/app identityとworkspace registry revisionを保存し、各`interactive` / `block_actions` envelopeを、その接続identity、payloadのteam、actor user、app、container channel、message timestamp、action ID、保存済みpresentationと照合します。接続identityとpayload identityが一致しなければ拒否します。eventは3秒以内にACKしますが、ACKはapproval受理ではありません。decision transaction、resume event enqueue、`chat.update`はACK後に処理します。

非supervisor、別workspace、別message、古いpresentation、duplicate、期限切れもACKしてから拒否・auditします。曖昧な`chat.postMessage` / `chat.update`結果はblind retryせず、deliveryを`acceptance_unknown`としてreconcileへ送ります。

## Release gate

次のすべてが揃うまで実行機能は`safe_off`です。

- Phase 1のrequest/decision/Slack UXだけでなく、typed gateway、allowlist executor、one-shot consume、TOCTOU再検証が接続済み
- MVP operationの全legacy write entry pointが拒否またはgateway経由になり、bypass fixtureが成功
- duplicate/replay/expiry/cancel/rotation/policy change/cross-workspace/restart/race/acceptance-unknown fixtureがdeterministicに成功
- retention、backup、rotation、expiry、reconcile、incident手順が運用runbookに反映済み
- current integration head/base pairのsecurity/chaos E2E、CI、reviewが成功

## Host approvalとの非代替性

Codex host approvalは、Codexがtoolやcommandを実行してよいかをhost側で制御するものです。Dona application approvalは、binding済みsupervisorがexact typed actionを許可したかをDonaが検証するものです。一方のYes、accepted、approved、reaction、HTTP成功をもう一方の証明へ変換しません。両方が必要な操作では、それぞれ独立に成立しなければ実行しません。

## Consequences

- 自然言語だけで新operationを追加できず、typed contractとsecurity reviewが必要になります。
- approval UXが利用可能でも、安全なresume/execution完成まではwriteが無効です。
- supervisorがprivate contextを閲覧できない場合、一部requestは承認画面を作らず停止します。
- audit可能性と引き換えに永続metadataを保持するため、retentionとbackup deletionを運用対象にします。
