# Worker Messaging protocol v1

## 目的と境界

Worker Messaging は、worker と dona-main の途中経過・質問・判断を durable に交換する transport-neutral protocol である。`progress.json` は引き続き最新 phase の snapshot、Job Result と `dona_job` event は terminal outcome の正本であり、この ledger から backfill しない。

本protocolは message の型、SQLite ledger、receipt、delivery、Dispatcher API／MCP、内部eventの安全な投影、およびworker向けtyped instructionを既存Herdr steer経路へ渡すbridgeを所有する。dona-mainの意味判断、Slack文面と投稿は所有しない。

## Contract

- `schema_version` は `1` 固定。
- worker report kind は `checkpoint`、`question`、`risk`、`decision_request` のclosed enum。
- dona-main instruction operation は `answer`、`add_condition`、`change_priority` のclosed enum。
- message全体は UTF-8 で16 KiB以下。本文は4,000文字以下、decision optionは各1,000文字・最大8件。
- unknown fieldは拒否する。job ID、message ID、thread IDの所持だけでは認可せず、永続化済み`job_id`と`source_event_id`のbindingを照合する。worker-facing report／claim／ACKは、さらにDispatcherがprompt時に発行するjob固有`runtime_identity`をcurrent `job_live_session_identities`へ照合し、同一ownerのsibling worker間も分離する。worker reportのread-only reconcileだけは、commit済みreportと同じruntime identityのSHA-256をretention期間中保持してterminal cleanup後も照合できるようにする。current runtimeであってもmessage固有の履歴hash一致を必須とし、raw identityは履歴へ保存しない。
- instructionはtyped operationであり、raw shell、path、URL、environment、credentialをcommand capabilityとして受け付けない。
- instructionはworkerへsteer可能なjob状態だけで新規受理し、`needs_review`等の配送不能状態では未回答questionを維持して拒否する。受理済みsteer operationはjobの最新slotとは別のdurable receiptで照合し、別のsteerで上書きされても再投入しない。
- `answer`は未回答のworker `question`／`decision_request`への`correlation_message_id`を必須とし、`conversation_revision`は相関元の直後でなければならない。同じ質問への2件目のanswerは拒否する。
- `producer_sequence`はjob・producerごとに1から単調増加する。gapは`worker_message_sequence_gap`、未記録の巻き戻しは`worker_message_sequence_rollback`。
- `idempotency_key`はjob・producerごとに一意。`source_event_id`、`producer_sequence`、key、payload、`correlation_message_id`、`conversation_revision`、`occurred_at`がすべて同一なら`reused`、いずれかが異なるcanonical messageは`worker_message_idempotency_conflict`。
- jobが`completed`、`failed`、`cancelled`になった後の新規messageは`worker_message_terminal_fence`で拒否する。terminal前にqueuedとなったreport eventも本文read時にterminal fenceで拒否し、完了済みjobについて質問を再通知しない。既にcommit済みのmessageとreceiptはread-only reconcileできる。
- retentionは30日。terminal jobに属し、pending／leased deliveryを持たないmessageだけを削除できる。

## Durable delivery

message、accepted receipt、delivery、cadence更新は1 transactionでcommitする。APIはcommit後だけacceptedを返す。応答喪失時は同じwriteを再送せず、producerと`idempotency_key`でreconcileする。

deliveryは`pending`、`leased`、`delivered`、`superseded`を持つ。claimごとにfenceを増加させ、lease owner、秘密tokenのSHA-256、expiryを保存する。ACKはcurrent owner・token・fence・expiryがすべて一致した場合だけ受理する。期限切れleaseはrestart後も`pending`へ戻せる。

worker reportはPublisherがboundedな`dona_message`内部eventへ変換する。event payloadは`message_id`、`job_id`、`source_event_id`、kindだけで、本文は含めない。dona-mainは現在eventとのbindingを伴うread APIで本文を取得する。message commit後のpublish失敗はjob実行・Result保存・terminal notificationを失敗させず、pending deliveryとhealthのdegraded stateとして残す。

通常reportはjobごと・workspaceごとのminimum intervalで抑制し、未配送の古い通常reportを`superseded`にする。`question`、`decision_request`、high riskは即時対象である。最後のreportからsilence intervalを超えた場合はgeneration-boundな`worker_message_silence` eventを一意に生成する。期限はwall-clockの絶対UTC値として保存するため、restartやclockの前後移動で同じgenerationを重複生成しない。新しいreportを受理した時点で未処理の旧generation silence eventは失効させる。

## APIとMCP

- `POST /v1/jobs/{job_id}/messages/reports`: worker reportをcommitする。
- `POST /v1/jobs/{job_id}/messages/instructions`: dona-main instructionをcommitする。worker runtime credentialでは認可せず、Dona内部processだけが読めるprivate internal credentialを必須とする。
- `GET /v1/jobs/{job_id}/messages/{message_id}`: binding確認後にbounded本文を読む。
- `GET /v1/jobs/{job_id}/messages/reconcile`: receiptとdelivery stateをread-only照合する。
- delivery claim／ACK routeはworker bridge用。lease情報をlog、health、Resultへ出さない。
- worker-facing report／claim／ACK／reconcileはpromptの`runtime_identity`を`x-dona-worker-runtime` headerで渡す。body、query、log、Resultへ複製しない。
- MCPは`send_worker_instruction`、`get_worker_message`、Donaからworkerへのwrite専用`reconcile_worker_message`を公開する。worker reportの照合はjob固有runtime identityを伴うworker HTTP経路だけに限定する。
- worker向けdeliveryはproduction bridgeがleaseし、typed envelopeを既存のjob steer経路へ渡してからACKする。bridgeはsteer可能な`queued`、`retryable_failed`、`running`、`blocked`だけを対象にし、同じjobの先行instructionがpendingまたはleasedなら後続を追い越さない。process停止後もpending ledgerから再開し、message IDをsteer operation identityとして使うため、同じsource eventの複数instructionを区別しつつaccept済みpromptを重複投入しない。blocked workerがanswerを受理した場合はrunningへ戻して監視を再開し、queuedまたは処理中のattention eventとそのjob/group pointerをsupersedeして古い質問通知を出さない。
- `list_thread_jobs`は未回答のquestion／decision requestがある場合だけ、boundedな`pending_worker_question`を返す。一意なら相関message ID、次のproducer sequence、conversation revisionを返し、複数なら`ambiguous: true`と`pending_count_at_least: 2`だけを返して相関先を推測させない。後続の人間回答はcurrent event bindingで`answer`へ変換し、成功後はAgent Sessionを`processing`へ戻す。通常のfree-form steerへ落とさない。

## 障害対応

1. write timeout／disconnectではblind retryせずreconcileする。
2. `not_found`なら受理を確認できていない。自動再送せずcaller判断へ返す。
3. `matched`ならmessage ID、accepted receipt、delivery stateを正本とする。
4. `/health/ready`と`/health/version`の`worker_messaging`でpending、expired lease、silence deadline、degradedを確認する。raw payloadは出ない。
5. Publisher再起動後はpending／expired leaseを再取得する。eventは`worker-message:{message_id}`のexternal IDでduplicate suppressionされる。
