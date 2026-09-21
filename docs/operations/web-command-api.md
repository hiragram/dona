# Web command API運用契約

## 境界

Web Adapterは`POST /api/jobs`と`POST /api/jobs/:job_id/cancel`だけをcommand routeとして公開する。browser本文の`source`、principal、tenant、workspace path、token、callback URLは受理しない。principalとtenantは、online IdP照合後の現行sessionをDispatcherが再検証した結果だけから取得する。

command requestはCSRF、same-origin、固定route、署名済みingress context、owner-only UDS、BFF service proofを順に通る。UDSのMAC検証だけでは権限にならず、Dispatcherの`WebAuthRepository`が現行revisionと一回限りnonceを監査transactionで確定してからcommand brokerへprincipalを渡す。

## submitとreceipt

browserは256-bitの`request_id`を送るが、これをjob keyとして保存しない。Web Adapterが検証済みinstance・tenant・principal・sessionと保護されたcontext keyから64桁のidempotency keyを導出する。Dispatcherはobjectiveとworkspaceのcanonical payload digestをdurable receiptへ保存し、同じkey・同じpayloadを`reused`、同じkey・異なるpayloadを`idempotency_conflict`にする。

成功したsubmitはreply targetを持たない`source=web`の内部event、既存`jobs` table、既存worker admission、既存Result pathを使う。Web用のin-memory queueや別job engineは作らない。terminal jobはSlack/Dona通知eventを作らず、元のreply-free eventをcompletion fenceとして記録する。read modelとSSEは別Issueの責務である。

ownerごとのactive job上限は既存のjob admission上限を使う。idempotent reuseはquota判定より先に行うため、応答喪失後の照合がquotaによって拒否されない。

## cancelと応答喪失

cancelはexact job IDに加えて、永続化されたsource eventのinstance・tenant・principalを同時に照合する。別ownerは`owner_mismatch`、Web以外のjobはschedule等のpolicy境界として`scheduled_policy`、完了済みjobは`terminal`、不存在は`not_found`となる。成功時はcancel receiptを永続化し、同じrequestの再照合は`already_cancelled`を返す。

AdapterはUDS timeoutや切断後に自動再送しない。利用者が同じbrowser requestを明示的に再実行した場合は、同じserver-derived keyでdurable submit/cancel receiptを照合し、新しいjobやcancelを作らない。cancellation acceptanceが不明な場合は`acceptance_unknown`を返し、再writeしない。

public errorは固定codeだけを返し、objective、Result、workspace path、provider error、token、private URLを含めない。

## 未検証・非対象

この変更はfixture IdP、実TLS、owner-only UDS、実SQLite、既存queueを接続したintegration testまでを対象とする。production activation、live credential、live provider write、UI、read/SSE、approval、schedule CRUD、Slack routingは行わない。
