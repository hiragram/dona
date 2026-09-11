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
| confidential disclosure | private本文を権限のないsupervisorへ開示 | exact targetのcurrent visibilityを確認し、権限確認済みsupervisorにはexact draft/mentionを表示し、暗号化短期payloadを使う | targetとdraftを安全に表示できなければrequest作成拒否 |
| legacy bypass | approval-required writeを旧経路が直接実行 | typed gatewayとexecutor allowlistへ集約し、全entry point遮断をrelease gate化 | feature `safe_off` |
| operator compromise | bootstrap/rotationで自己昇格 | local operator専用経路、明示確認、revision、二者監査、期限付きbreak-glass | binding不明時はfail closed |
| host approval confusion | Codex側のYesをDona承認へ流用 | approval ID、actor proof、action hashをapplication DBで独立検証 | host許可だけでは実行不可 |

## 決定事項

### 1. MVP typed operation

採用: 最初のoperationは`slack.post_thread_reply.v1`とします。保存対象はworkspace、channel、thread、reply policy、mention policy、server-side content MAC、reconcile marker policyで、executorへは暗号化短期payload storeから復号した本文を渡します。`<!channel>`、`<!here>`、`<!everyone>`、user group mentionは拒否し、明示user mentionはsnapshotのallowlistにある最大3名だけを許可します。Slack Connectを含むshared channelはMVP対象外で、request作成、decision、consumeの各時点で`isShared: false`を再検証します。任意のMCP tool名、任意JSON、DM新規送信、broadcast、reaction、GitHub/Notion/Figma/Drive write、production/self-updateは対象外です。

理由: Donaの主要経路でありながら、thread固定、broadcast禁止、workspace binding、message read-backにより作用範囲とacceptanceを狭く検証できます。安全側defaultは未知operation拒否です。operation追加はtyped schema、projection、precondition、idempotency/reconcile、bypass inventory、security fixtureを独立reviewできる場合だけです。

### 2. Supervisorへの提示場所

採用: 既定はbinding済みsupervisorへのDMです。元threadには秘密を含まないpending noticeだけを許可します。同じworkspaceの非private channelで、requesterとsupervisorが閲覧可能で、operation projectionが機密を含まず、policyが明示許可する場合だけthread内decision UIを使用できます。DM、private channel、group DM由来は常にsupervisor DMとし、supervisorのcurrent visibilityをSlack APIで証明でき、exact targetのstable ID/表示名、exact draft本文、展開後の通知対象を安全に示せる場合だけUIを作ります。request作成時だけでなくdecision transactionとconsume claimでもvisibilityとshared状態を再取得し、失われていれば`needs_review`へ遷移します。証明または表示ができなければfail closedします。

理由: 閲覧権限の推測と意図しない開示を避けます。安全側defaultはDMで、条件を証明できなければthread提示しません。将来変更はtransportごとのvisibility証明とredaction testが揃った場合だけです。

### 3. TTL

採用: request/decision TTLは15分、承認後のconsume TTLは5分です。request作成時の`expires_at`とapproval時の`consume_expires_at`はDBへ保存し、transactionごとのUTC high-water markはDB/backup外のrollback-resistant credential storeへintegrity保護して保存します。process内ではmonotonic elapsed timeとwall clockの大きい方を有効時刻とします。同じOS bootを識別する認証済みboot IDとsuspendを含むcontinuous-clock readingもrequest/markへ保存し、process再起動後はboot ID一致時だけ保存済みreadingからの経過を期限判定へ使います。boot ID変更、continuous clockの巻戻し/取得不能、または再起動を越えた経過を証明不能な場合は、既存の全nonterminal/approved requestを`expired`または`needs_review`へ固定し、再承認なしでは継続しません。時刻を伴うDB transactionの前に、transaction ID、直前mark、候補markを結合したwrite-ahead reservationを、保存済み直前markを条件とする原子的compare-and-swapでcredential storeへdurable commitし、DB rowはそのreservation IDと候補markを参照してからcommitします。stale reservation、CAS競合、mark writeの失敗・結果不明ではDB transactionを開始せずapproval経路をfail closedにします。候補markはcurrent mark未満を許さず、小さい遅着writeで上書きできません。DB commit前のcrashで未使用reservationが残った場合もmarkを巻き戻さず、安全側に時刻が進んだものとして扱います。再起動/restore後にmarkが欠落、読取不能、integrity不明、DB参照との不一致、wall clockが保存済みmarkより前、または許容driftを超える時刻異常なら、時刻とmarkが安全に回復するまで全nonterminal/approved requestをexpireまたは`needs_review`としてfail closedし、期限を延長しません。

理由: 人間の判断時間とcontext driftを分離します。安全側defaultは期限切れです。変更はoperation risk、実測応答時間、incident記録を基にversioned policyで行い、既存requestへ遡及延長しません。

### 4. Cancelと競合

採用: requesterはdecision前のrequestをcancelできます。cancel commandも認証済みtransport connection provenanceを起点にactor、instance、workspace、persisted requester、request revisionを照合し、handle所持だけでは受理しません。不一致は状態不変でauditします。approve/reject/cancel/expireは単一decision slotをtransactionで先着確定し、後着は状態を変えません。approval後は未consume requestを`execution_cancelled`、期限切れを`consume_expired`、binding/policy/snapshot driftを`needs_review`へ遷移できます。これらとconsume claimは同一transactionで競合させ、先着した一つだけを確定します。claim取得後はexecutorを強制中断せず結果を追跡します。

理由: cancelを外部実行取消と誤認させません。安全側defaultは不明な競合を`needs_review`へ送ることです。将来、operation固有の補償操作は別typed actionとして設計します。

### 5. Bootstrap・rotation・break-glass

採用: bindingはDona instance ID、Slack team ID、supervisor user ID、revision、statusへ結合し、通常event/MCPから作成・変更できないlocal operator操作とします。bootstrap、rotation、revokeは、別OS accountまたは別hardware-backed credentialへ結合した独立actor二人のauthorizationを必須とし、proposerとconfirmerを同一identityで兼任できません。rotation/revokeは旧revisionのpending/approved requestをinvalidateします。break-glassも二人のoperator確認、理由、最大30分、有効範囲、終了後reviewを必須とし、approvalを迂回せず一時supervisor bindingを発行します。

enforcement policyを緩和する変更もlocal operator専用とし、許可operation/targetの拡大、approval省略、shared channel許可、TTL延長などのexact policy digestと次generationへ結合した独立actor二人のauthorizationなしではactivateしません。単なるgeneration増加やhigh-water mark前進を緩和の承認証跡として代用しません。binding rotation/revokeとpolicy更新は、二者承認済みexact digest、次generation、transaction IDを、保存済みgenerationを条件とするCASでcredential storeへDB commit前にreserveします。stale/CAS競合/失敗/結果不明ではDBを変更せずfail closedにし、DB commit前に停止した未使用generation reservationは自動取消・再利用せず、DBとの一意なreconcileまたは新たな二者承認までapproval経路を停止します。

理由: approval経路による自己昇格を防ぎます。安全側defaultはbinding不在・競合・失効時のrequest拒否です。別IAM導入時もinstance/workspace/revision bindingと監査を弱めません。

### 6. High-impact action

採用: production activation、credential/権限変更、支払い、データ削除、広範囲通知、security boundary変更はMVP executor対象外で、単一Slack decisionでは実行できません。将来追加する場合は、Slackと独立したsecond factorまたは二者承認、かつoperation固有runbookを必須とします。

理由: 1アカウント侵害のblast radiusを限定します。安全側defaultはunsupportedです。二者承認は同一人物の複数credentialを人数として数えません。

### 7. Legacy direct-write移行

採用: (1) write entry point inventory、(2) gateway shadow assessment、(3) typed executor接続、(4)全entry pointでapproval-required operationをfail closed、(5)bypass test成功、の順で移行します。(4)まで外部自動実行は`safe_off`とし、Phase 1のrequest/decision UIを完成扱いしません。

理由: 新経路を追加するだけでは旧経路がsecurity boundaryを迂回します。安全側defaultは未棚卸しentry pointが一つでもあれば無効化です。削除ではなく明示的な拒否を先に導入し、rollback時もbypassを復活させません。

### 8. Retention・backup・暗号化

採用: request表示projectionとdecisionは90日、auditとexecution metadataは400日保持します。本文bindingにはapplication secretを使うHMACを用い、raw SHA-256 digestをUIや長期metadataへ残しません。承認待ちの生成本文だけはowner-onlyのapplication-level envelope encryption済みpayload storeへ保存し、鍵はDB/backupと分離したOS credential storeで管理します。requestが`rejected`、`cancelled`、`expired`、`delivery_failed`、`execution_cancelled`、`consume_expired`、`needs_review`など本文を今後利用しないterminal/invalid stateへ進む同じtransactionでrequest payloadを即時削除します。consume claim時は同じtransactionでrequest payloadをattempt専用の暗号化payloadへ移し、attemptがdurableな`succeeded` / `failed` / `needs_review`へ収束した時点で即時削除します。`acceptance_unknown`では最大24時間保持してreconcileし、期限後はpayloadを削除してattemptを`needs_review`へ固定し自動再実行しません。状態にかかわらずattempt payloadの最大保持は24時間です。payloadはbackup対象外です。tokenとprivate download URLは保存しません。SQLite、backup、exportはowner-onlyとします。

binding/audit HMAC signing keyは90日以内にrotationし、各recordへ用途と`key_version`を保存します。rotation済みkeyは新規MACへ使わず、OS credential store内のverification-only keyとして、そのkeyで署名した最後のrecordの400日保持とbackup expiryがともに終了するまで保護して保持します。その後はrecordを削除してからkeyを破棄します。verification keyが欠落、revoked、またはversion不明ならrecordを検証済みと扱わず、security decisionと自動実行をfail closedします。retained recordを別keyで暗黙にre-MACしません。

Dispatcher DBをbackupからrestoreするtransactionでは、全nonterminal/approved requestとattemptのpayload参照・HMACを検査します。backup対象外payloadが欠落または不一致なら、requestに加えて`claimed` / `executing`を含む全nonterminal attemptを`needs_review`へ同じtransactionで固定し、decision/claim/executionを拒否します。さらにDB/backup外の保護されたcredential storeへbinding generationとenforcement policy generationの単調high-water mark、各generationのcanonical digest、commit済みtransaction IDを保存します。markの欠落、読取不能、integrity不明、restore内容によるgeneration巻戻し、復元current recordのdigest/transaction ID不一致、または対応するcommit済みreservation不在では、新規requestを含むapproval経路全体をfail closedします。現在generation/digestへの二者operator再承認が完了するまで復元DBのbinding/policyをcurrentとして採用しません。payloadの再生成や元actionの自動再実行は行いません。

理由: incident追跡とdata minimizationを両立します。安全側defaultは保存しないことです。legal/運用要件変更時はfield別classification、削除証跡、backup expiryを同時に更新します。

### 9. Private contextの開示

採用: supervisorにはoperation kind、requester、期限、リスク理由、本文から導出できないopaque action IDを表示します。さらにsupervisorのcurrent visibilityを証明したtargetについて、exact stable target ID/表示名、exact draft本文、解決済みのuser mention対象を表示します。draftとmention対象はSlack `plain_text` blockへ文字どおりescapeして表示し、mrkdwn、link解析、mention、emoji変換、unfurlを無効化します。content MAC、不要な参加者一覧、添付、secret、private URLは表示しません。exact targetと送信内容を判断できる安全なprojectionをoperation側が作れなければrequestを作らず、人間へ安全な別経路で確認を求めます。

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
  requested -> delivery_pending
  requested|delivery_pending|delivery_unknown -> cancelled|expired|needs_review
  delivery_pending -> sent|delivery_failed|delivery_unknown
  delivery_unknown -> sent|needs_review
  sent -> approved|rejected|cancelled|expired|needs_review
  approved -> consumed|execution_cancelled|consume_expired|needs_review

delivery attempt:
  pending -> dispatching
  pending -> aborted
  dispatching -> sent|failed|acceptance_unknown
  dispatching -> acceptance_unknown (recovery only)
  acceptance_unknown -> sent|needs_review

pending notice attempt:
  pending -> dispatching
  pending -> aborted
  dispatching -> sent|failed|acceptance_unknown
  dispatching -> acceptance_unknown (recovery only)
  acceptance_unknown -> sent|needs_review

presentation update attempt:
  pending -> dispatching
  pending -> aborted
  dispatching -> succeeded|failed|acceptance_unknown
  dispatching -> acceptance_unknown (recovery only)
  acceptance_unknown -> succeeded|failed|needs_review

execution attempt:
  not_started -> claimed -> executing -> succeeded|failed|acceptance_unknown
  claimed -> needs_review (precondition failure or restore)
  executing -> acceptance_unknown (recovery only)
  executing -> needs_review (restore only)
  acceptance_unknown -> succeeded|failed|needs_review
```

- `approved`は外部実行の開始・受付・成功を意味しません。
- decisionはrequestとdelivery attemptが同じtransactionで`synchronized sent`になったpresentationだけに許可し、delivery failure/unknown中は承認できません。
- `consumed`は同じapprovalを再利用できないことだけを意味します。
- claim transactionはrequest、decision、binding、policy、snapshot/hash、expiry、operation preconditionを再検証し、consume ledgerとattemptを原子的に作ります。
- approved後の失効・取消とclaimは同じrequest revisionを条件に原子的に競合させ、失効済みapprovalをclaim可能なまま残しません。
- delivery attemptとexecution attemptの`acceptance_unknown`は独立して保存し、exact message identityまたはoperation固有receiptをread-only reconcileできた場合だけ同じattemptをterminalへ収束させます。request stateとの遷移はattempt更新と同一transactionで行います。
- delivery中のcancelはdelivery結果とtransactionalに競合させます。cancelが先着したrequestは、遅れてcardが`sent`と確認されても`cancelled`のまま維持し、interactive decisionを拒否してpresentation update対象にします。
- requestがcancel、expire、reject、またはinvalidateされる時点でdelivery attemptがまだ`pending`なら、同じtransactionで`aborted`へ収束させます。外部call未開始のattemptは以後claimせず、無効なapproval cardを新規送信しません。
- binding/policy/restore invalidationは全nonterminal stateとapprovedから`needs_review`へtransactionalに遷移でき、配送結果と競合してもinvalidated requestを`sent`へ戻しません。
- approval delivery workerはexact draftを復号する前かつ`dispatching` fenceをcommitする同じtransactionでrequest/decision TTL、current binding/policy revision、requester authorization、supervisorのcurrent target visibility、shared状態を再取得します。不一致、期限切れ、または証明不能なら外部callなしでrequestを`expired`または`needs_review`、`pending` attemptを`aborted`へ同じtransactionで収束させpayloadを削除します。成功した場合だけ`chat.postMessage`直前に`dispatching`とattempt fenceをdurable commitします。復旧時の`dispatching`は送信済みの可能性があるため無条件に同じattemptを`acceptance_unknown`へ移し、read-only reconcileだけを行い再送しません。
- 元threadのpending noticeはapproval cardと別のdelivery attemptとして、request ID、共通field `notification_attempt_id`、notification kind、server-side MACの一意markerへbindingします。`dispatching`をcommitする同じtransactionでcurrent request state/revisionとTTLを再検証し、terminal、期限切れ、不一致ならrequestを安全側のterminalへ、notice attemptを`aborted`へ収束させて送りません。成功時だけ`chat.postMessage`直前に`dispatching` fenceをdurable commitし、timeoutまたは復旧時は`acceptance_unknown`からexact markerをread-only reconcileするだけで、0件でも再投稿しません。requestがterminalになる時点でnotice attemptが`pending`なら、同じtransactionで`aborted`へ収束させて新規noticeを送りません。
- presentation update workerはdispatch直前に保存済みpresentation revisionとcurrent desired revisionを照合し、staleな`pending` attemptを`aborted`へ収束させます。同じmessageに`dispatching`または`acceptance_unknown`のattemptがある間は後続updateを送らず、先行writeがterminalに一意確定するまで直列化します。曖昧な先行writeを飛び越えて新しい表示で上書きしません。
- executorは`claimed`から外部callへ進む直前に、短いexecution期限、binding、policy、ordered thread revision、supervisor visibility、shared状態に加え、persisted requesterがcurrent targetで当該operationを要求できるmembership/authorizationを認証済みsourceから再検証します。不一致や期限切れは外部callなしで`needs_review`へ収束させます。成功した場合だけ`executing`とattempt fenceをdurable commitして送信します。復旧時に`executing`を観測したworkerは送信済みの可能性があるため、必ず同じattemptを`acceptance_unknown`へ移してread-only reconcileし、markerが0件でも再送しません。
- `acceptance_unknown`から同じwriteを自動再実行しません。read-only reconcileで一意に確定できる場合だけ既存attemptの結果を更新し、別attemptを作りません。

全transitionのdecision tableはfixtureに記載します。

## Slack transport decision proof

request作成時のrequesterは、認証済みEvent Envelopeのactor、またはDispatcherが永続化したbackground job ownerからserver-sideで導出します。source event/job ID、owner kind、actor/owner ID、instance、workspaceをimmutable requestへ結合し、会話本文、LLM出力、button valueからrequester IDを受け取りません。source ownershipが欠落または一致しなければrequestを作りません。作成keyはserver-sideで`instance + workspace + source event/job ID + stable operation slot`から導出してunique constraintを設けます。同じkeyとsemantic action hashの再送は既存requestを返し、同じkeyで異なるactionは状態を変えずconflictとして`needs_review`にします。一つのsourceで複数actionを扱う場合も、順序から変動しない明示slotをDispatcherが永続化します。creation keyを先に検索してからpayloadを割り当て、action hashにはinstance、workspace、source ownership、typed operation、target、policy、precondition、content HMACを含めます。storage locator、暗号nonce、ciphertextなどの保存時metadataだけを除外します。

button valueにはopaque request handleとpresentation revision以外を含めません。Socket ModeにはHTTP Request Signing相当の署名付きrequestがないため、workspace別の認証済みSocket接続をprovenanceの起点とします。接続確立時に認証済みteam/app identityとworkspace registry revisionを保存し、各`interactive` / `block_actions` envelopeを、その接続identity、payloadのteam、actor user、app、container channel、message timestamp、action ID、保存済みpresentationと照合します。接続identityとpayload identityが一致しなければ拒否します。3秒以内に、envelope IDをdedup keyとするdurable interactive inboxへ検証済みproofとcommandをcommitしてからACKします。ACKはapproval受理ではありません。ACK後のdecision workerは保存済みcommandだけを処理し、duplicate envelopeは同じinbox recordへ収束させます。decision確定時はstable event IDを持つ`dona_approval` outbox rowをdecisionと同じtransactionで一度だけ作成します。commit後はdurable outboxだけを配送し、process再起動時も未配送rowを回収します。`chat.update`は別のdurable attemptとして処理します。

非supervisor、別workspace、別message、古いpresentation、duplicate、期限切れもACKしてから拒否・auditします。曖昧な`chat.postMessage`結果はdelivery attempt、曖昧な`chat.update`結果は独立したpresentation update attemptの`acceptance_unknown`として保存し、どちらもblind retryしません。update attemptはdecisionとpresentation revisionへbindingし、`chat.update`直前に`dispatching` fenceをdurable commitします。復旧した`dispatching`は無条件に`acceptance_unknown`へ移し、read-backしたexact revisionが1件の場合だけ同じattemptを`succeeded`へ収束させます。0件は`acceptance_unknown`のまま維持し、決定的rejectionだけを`failed`、複数件またはpagination不完全を`needs_review`にします。0件観測後も同一messageへの後続writeを送りません。

MVP replyは、承認済み本文を変えない一意なexecution attempt IDとMACをSlack Blockの`block_id`へ埋め込みます。送信前にworkspace/channel/threadの全pageで同じmarkerが0件であることを確認し、timeoutまたは`executing`復旧後は全pageを同じpagination fenceで読み、exact markerが1件ならaccepted、0件なら`acceptance_unknown`のまま、2件以上またはpagination不完全なら`needs_review`とします。不在観測を決定的rejectionとみなさず、別の明示操作でも同じwriteを再送しません。同文、timestamp近接、message textだけではattemptを同定しません。

cancel、expire、reject、`needs_review`など全terminal/invalid stateで遅着cardを発見した場合、requestを`sent`へ戻さずinteractive decisionを恒久拒否します。exact cardをredactedな無効表示へ変えるpresentation update attemptを一度だけ作り、そのupdateが曖昧なら再送せず`acceptance_unknown`としてreconcileします。

requestがterminalになった後に`dispatching` / `acceptance_unknown`のpending noticeが遅着またはreconcileで`sent`と確定しても、request stateは戻しません。exact noticeをredactedなterminal表示へ変えるpresentation update attemptを一度だけ作り、同一messageの直列化とacceptance-unknown規則を適用します。

ordered thread revisionは利用者の会話contextだけを対象にします。Dona自身が投稿したpending noticeまたはapproval cardは、認証済みapp author、request ID、共通の`notification_attempt_id`、notification kind、server-side MACがすべて一致する専用markerで識別できる場合だけ集合から除外します。本文類似やBot authorだけでは除外しません。それ以外のreply追加・削除・編集はcontext driftです。requesterのcurrent membership/authorization revisionもsnapshotへ含め、request作成、decision、consume、`executing` fence直前に再取得します。

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
