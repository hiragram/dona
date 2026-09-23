# Worker Messaging protocol v1

## 目的と境界

Worker Messaging は、worker と dona-main の途中経過・質問・判断を durable に交換する transport-neutral protocol である。`progress.json` は引き続き最新 phase の snapshot、Job Result と `dona_job` event は terminal outcome の正本であり、この ledger から backfill しない。

本protocolは message の型、SQLite ledger、receipt、delivery、Dispatcher API／MCP、内部eventの安全な投影、およびworker向けtyped instructionを既存Herdr steer経路へ渡すbridgeを所有する。dona-mainの意味判断、Slack文面と投稿は所有しない。

## Contract

- `schema_version` は `1` 固定。
- worker report kind は `checkpoint`、`question`、`risk`、`decision_request` のclosed enum。
- dona-main instruction operation は `answer`、`add_condition`、`change_priority` のclosed enum。
- message全体は UTF-8 で16 KiB以下。本文は4,000文字以下、decision optionは各1,000文字・最大8件。
- unknown fieldは拒否する。job ID、message ID、thread IDの所持だけでは認可せず、永続化済み`job_id`と`source_event_id`のbindingを照合する。worker-facing reportは、さらにDispatcherがprompt時に発行するjob固有`runtime_identity`をcurrent `job_live_session_identities`へ照合し、同一ownerのsibling worker間も分離する。worker reportのread-only reconcileだけは、commit済みreportと同じruntime identityのSHA-256をretention期間中保持してterminal cleanup後も照合できるようにする。current runtimeであってもmessage固有の履歴hash一致を必須とし、raw identityは履歴へ保存しない。
- instructionはtyped operationであり、raw shell、path、URL、environment、credentialをcommand capabilityとして受け付けない。
- instructionはworkerへsteer可能なjob状態だけで新規受理し、`needs_review`等の配送不能状態では未回答questionを維持して拒否する。受理済みsteer operationはjobの最新slotとは別のdurable receiptで照合し、別のsteerで上書きされても再投入しない。
- `question`／`decision_request`は後続answerを配送可能なjob状態だけで受理する。running jobではmessage commitと同じtransactionでblockedへ遷移して回答待ちを維持し、遅延reportが`needs_review`等へ回答不能な質問を追加することを拒否する。
- `answer`は未回答のworker `question`／`decision_request`への`correlation_message_id`を必須とし、`conversation_revision`は相関元の直後でなければならない。同じ質問への2件目のanswerは拒否する。
- `producer_sequence`はjob・producerごとに1から単調増加する。gapは`worker_message_sequence_gap`、未記録の巻き戻しは`worker_message_sequence_rollback`。
- `idempotency_key`はjob・producerごとに一意。`source_event_id`、`producer_sequence`、key、payload、`correlation_message_id`、`conversation_revision`、`occurred_at`がすべて同一なら`reused`、いずれかが異なるcanonical messageは`worker_message_idempotency_conflict`。
- jobが`completed`、`failed`、`cancelled`になった後の新規messageは`worker_message_terminal_fence`で拒否する。terminal前にqueuedとなったreport eventも本文read時にterminal fenceで拒否し、完了済みjobについて質問を再通知しない。既にcommit済みのmessageとreceiptはread-only reconcileできる。
- retentionは30日。terminal jobに属し、pending／leased deliveryを持たないmessageだけを削除できる。

## Durable delivery

message、accepted receipt、delivery、cadence更新は1 transactionでcommitする。APIはcommit後だけacceptedを返す。応答喪失時は同じwriteを再送せず、producerと`idempotency_key`でreconcileする。

deliveryは`pending`、`leased`、`delivered`、`superseded`を持つ。claimごとにfenceを増加させ、lease owner、秘密tokenのSHA-256、expiryを保存する。ACKはcurrent owner・token・fence・expiryがすべて一致した場合だけ受理する。期限切れleaseはrestart後も`pending`へ戻せる。

worker reportはPublisherがboundedな`dona_message`内部eventへ変換する。event payloadは`message_id`、`job_id`、`source_event_id`、kindだけで、本文は含めない。dona-mainは現在eventとのbindingを伴うread APIで本文を取得する。message commit後のpublish失敗はjob実行・Result保存・terminal notificationを失敗させず、pending deliveryとして残す。安全にdispatch前と確認できた失敗が試行上限に達した場合は旧eventをdead letterにし、deliveryを再びpendingにして新しいgenerationのeventを発行できるようにする。再armした通常reportは新しいreportを優先して失効させ、`needs_review`の未配送reportもPublisherが失効させる。dispatch開始後に受理が不明な失敗や質問通知eventの確定失敗では再発行せず、jobをneeds_reviewへ移して通常通知で顕在化する。期限を60秒以上過ぎたpending deliveryまたはexpired leaseはhealthのdegraded stateにする。

通常reportはjobごと・workspaceごとのminimum intervalで抑制し、未配送の古い通常reportを`superseded`にする。`question`、`decision_request`、high riskは即時対象である。最後のreportからsilence intervalを超えた場合はgeneration-boundな`worker_message_silence` eventを一意に生成する。期限はwall-clockの絶対UTC値として保存するため、restartやclockの前後移動で同じgenerationを重複生成しない。新しいreportを受理した時点で、queue待ちだけでなくdispatch中・人間待ちを含む未完了の旧generation silence eventも失効させる。質問への回答待ちで`blocked`の間はsilenceを発行せず、既存eventもcurrentと判定しない。dona-mainはSlack write直前の`get_job_status`でevent generationがcurrentであることを再検証し、falseまたは照会不能なら投稿しない。question解除時はgenerationを進めて新しいsilence deadlineを設定し、再開後の無通信を別世代として監視する。

## APIとMCP

- `POST /v1/jobs/{job_id}/messages/reports`: worker reportをcommitする。
- `POST /v1/jobs/{job_id}/messages/instructions`: dona-main instructionをcommitする。worker runtime credentialでは認可せず、Dona内部processだけが読めるprivate internal credentialを必須とする。
- `GET /v1/jobs/{job_id}/messages/{message_id}`: binding確認後にbounded本文を読む。
- `GET /v1/jobs/{job_id}/messages/reconcile`: receiptとdelivery stateをread-only照合する。
- delivery claim／ACKはDispatcher process内のbridge専用で、worker専用socketには公開しない。lease情報をlog、health、Resultへ出さない。
- worker-facing report／reconcileはpromptの`runtime_identity`を`x-dona-worker-runtime` headerで渡す。body、query、log、Resultへ複製しない。
- 通常のGitHub／scratch workerにはpromptの`worker_messaging`でworker専用Unix socket、report／reconcile endpoint、認証header参照、closed payload variants、サイズ上限を渡す。socketはread可能な既存pathとして参照させ、共有する親directoryを`--add-dir`でwritableにはしない。worker専用socketはmain Dispatcher socketとはcanonical pathで相互に包含しない別directoryに置き、親directoryから実体パスの祖先まで所有者と書き換え可能性を検証し、reportとworker reconcileだけを公開する。schedule workerのread-only sandboxにはこのtransportを公開しない。
- worker reportは1 jobあたり256件を上限とし、未回答の`question`／`decision_request`がある間は次の質問を受理しない。idempotentな同一reportのreconcileは上限到達後も再利用できる。
- MCPは`send_worker_instruction`、`get_worker_message`、Donaからworkerへのwrite専用`reconcile_worker_message`を公開する。worker reportの照合はjob固有runtime identityを伴うworker HTTP経路だけに限定する。
- worker向けdeliveryはproduction bridgeがleaseし、typed envelopeを既存のjob steer経路へ渡してからACKする。bridgeはsteer可能な`queued`、`retryable_failed`、`running`、`blocked`だけを対象にし、同じjobの先行instructionがpendingまたはleasedなら後続を追い越さない。process停止後もpending ledgerから再開し、message IDをsteer operation identityとして使うため、同じsource eventの複数instructionを区別しつつaccept済みpromptを重複投入しない。queued jobでも最新slotだけでなくdurable receiptを照合する。blocked workerではsteer receiptのcommit、running復帰、既存attentionのsupersedeを1 transactionで行い、receiptは復帰要否と完了時刻を保持するため旧operationのretryが後の別blocked状態を解除しない。受理後、claim前またはrestart時の曖昧なsteerによりjobが`needs_review`へ遷移したinstructionはpending／leasedを問わずsupersedeし、未配送answerなら相関questionを再公開する。
- `list_thread_jobs`は回答を配送できるjob状態に未回答のquestion／decision requestがある場合だけ、boundedな`pending_worker_question`を返す。一意なら相関message ID、次のproducer sequence、conversation revisionを返す。新規reportでは未回答質問を1件に制限し、既存DBに複数残る場合だけ最大4件のmessage ID、kind、question、次のsequence／revisionを候補として返して明示選択できるようにする。後続の人間回答はcurrent event bindingで`answer`へ変換し、成功後はAgent Sessionを`processing`へ戻す。通常のfree-form steerへ落とさない。

## 障害対応

1. write timeout／disconnectではblind retryせずreconcileする。
2. `not_found`なら受理を確認できていない。自動再送せずcaller判断へ返す。
3. `matched`ならmessage ID、accepted receipt、delivery stateを正本とする。
4. `/health/ready`と`/health/version`の`worker_messaging`でpending、expired lease、silence deadline、degradedを確認する。raw payloadは出ない。
5. Publisher再起動後はpending／expired leaseを再取得する。eventは`worker-message:{message_id}`のexternal IDでduplicate suppressionされる。
