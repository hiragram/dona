# Web job read model・SSE運用契約

## 境界

Web job read modelは、認証済みBFFがDispatcherのprincipal-scoped UDSを介して利用するread projectionである。browserが送るjob ID、cursor、`Last-Event-ID`、header内のactor情報はauthorityにしない。BFFがonline identity確認後に署名したingress contextをDispatcherのcurrent Web sessionへ再照合し、`job:read:own`ではpersisted ownerが一致する`source=web` job、`job:read:granted`ではcurrentな明示grantが一致するjobだけをfilterしてからpaginationする。両scopeがあるprincipalには両集合のunionを返す。grantはjob・instance・tenant・principal・revision・active/revoked状態・期限へ結合し、失効・期限切れ・別principalのgrantを未知jobと同じく不可視にする。

明示grantのissue/regrant/revokeはbrowser routeやBFF credentialへ公開しない。Web auth repositoryとjob read brokerが接続され、BFFへ渡さないoperator専用HMAC keyを設定したowner-only internal gatewayの固定local-operator routeだけが受け付ける。issue/regrantは保護audit commitmentで検証したcurrent Web registry上のactive observer、`job:read:granted` scope、granteeの`identity_binding_revision`・`authz_revision`を照合してから、Dispatcher DBのpersisted Web job owner、期待grant revision、30日以内の期限を同じgrant transactionで照合する。server生成grant ID、CAS更新、idempotency receipt、immutable mutation auditは同じimmediate transactionで確定し、応答喪失時は同じ`operation_id`とcanonical payloadでread-backする。不存在・失効済み・scope不一致のgrantee、future/stale revision、別payloadでの再利用、stale grant revision、owner不一致は拒否する。revokeは保存済みgrant bindingとCASを照合するため、grantee失効やregistry read障害後もactive grantをfail-closedで閉じられる。

本実装はjob submit/cancel、session/auth core、CSRF/origin、approval、artifact content downloadを変更しない。production listenerの有効化やlive provider検証も行わない。

## 公開projection

- 一覧は最大50件、`created_at DESC, job_id DESC`のstable orderingと15分のopaque cursorを使う。cursorはprincipal、owner/grantedのauthorization kind、snapshot high-water、次page境界へ永続bindし、別principal・別authorization kindへの持ち替え、改変、期限切れを拒否する。granted jobのevent cursorは発行時の`grant_id`・`grant_revision`にもbindし、revoke後に新revisionで再付与されても旧cursorを復活させない。
- 詳細はstatus、時刻、標準化済みprogress、terminal Resultの固定summary、安全なartifact metadata、cancel eligibilityだけを返す。
- `objective`、raw Result summary/output/actions、DB row、workspace/result path、runtime identity、private URLは返さない。terminal summaryはResult statusから`完了`または`失敗`だけを生成する。artifact名は入力値を公開せずordinalな`artifact-N`へ置換し、固定`kind`、妥当なmedia type、sizeだけをallowlistする。
- 別owner jobと未知jobは同じ`not_found`として扱い、不可視件数をpage size、cursor、error差へ反映しない。

## durable cursorとSSE

`web_job_projection_events`はjob INSERTと、status・公開時刻が変わるUPDATEを同じSQLite transactionのtriggerでmonotonic sequenceへ記録する。通常のjob遷移では`updated_at`を既存値より必ず進めるため、wall clockが同一millisecondでも公開projectionの変更を欠落させない。非公開Result本文や内部errorだけの変更はevent有無のside channelへしない。progressは既存のdurable progress storeのsequenceを`web_job_progress_versions`へ単調にreconcileし、再起動後もcurrent snapshotへ収束できる。worker由来のprogress時刻は表示用に限り、event retention時刻にはDispatcherが認証transactionで確定した受信時刻を使う。cursorはrandom 256-bit tokenのdigestだけをDBへ保存する。

`GET /api/jobs/:id/events`はboundedなone-shot SSE responseを返して接続を閉じる。変更があれば`event: job`、なければ`event: heartbeat`、retention gapなら`event: reset`を返し、各responseのopaque `id`を次の`Last-Event-ID`に使う。同じcursorの再送は同じ範囲を安全に再読できるため、応答喪失、disconnect、duplicate deliveryでmemory-only stateを正本にしない。Web process restart後もcursorとevent ledgerはDispatcher DBから復元される。

one-shotかつbody上限付きなので、slow consumerはTLS listenerの既存接続上限・secure lifetime・socket closeで隔離される。接続切断をjob mutationとして扱わず、再接続時はdurable snapshotを再取得する。

## retention・障害時の扱い

- event ledgerはDispatcher runtimeが起動時と1時間ごとにmaintenanceし、24時間を超えた対象を1 transaction 1000件まで削除する。対象が残る間はevent loopへyieldしてbatchを反復し、通常流量を上回るbacklogも解消する。存在するWeb jobはlist cursor用の最初のanchorだけを保持し、削除済みjobのanchor/tombstoneはwatermark更新後に削除する。cursor期限切れはmaintenanceに加え、新しいcursorを発行する通常runtime経路でもexpiry indexから固定上限ずつ回収する。
- cursorが保持するsequenceより古いeventがretentionで失われた場合は、欠落を成功扱いせず`reset_required`を返す。clientは完全snapshotを再取得し、新しいdetail cursorから再開する。
- Dispatcher UDS、署名response、current access確認、DB query、最終auditのいずれかが失敗した場合、BFFはstale cacheや旧APIへfallbackせず`identity_unavailable`にする。list/detail/SSEはsession auditに加えて専用operationでsuccess・resource不可視・cursor拒否・内部失敗の最終outcomeを記録し、応答直前にもcurrent session revisionを再照合する。
- grant・cursorの期限判定とprogressの受信時刻にはsession ingressが確定したrollback-protectedな`effective_utc`を使い、OS wall clock巻戻りで失効済みauthorityを復活させない。未知のprojection schema versionはtriggerや`jobs` tableへDDLを行う前に拒否する。
- grant mutation時刻はDispatcher DB内の単調watermarkから後退させず、issue/revoke記録は更新・削除不可のaudit rowとしてgrant変更と同時commitする。revision binding導入時はprojection schemaをversion 4へ上げ、revision evidenceを持たないversion 3 grantと既存cursorをfail-closedで破棄するため、旧binaryへのrollbackもversion markerで拒否される。local operator routeは通常のbrowser session、principal header、CSRF tokenをgrant authorityへ昇格させない。
- event件数、cursor件数、最古event時刻、reset発生数を運用metric候補とする。private identity、job本文、Result summary、cursor token自体はlog/metricへ出さない。

## 検証

contract testはprincipal filter-before-pagination、ownerとcurrent明示grant、grant失効、snapshot境界、cursor tamper/cross-owner、同一millisecondを含むconcurrent update、期限切れcursor回収、duplicate reconnect、retention gap、Result/artifact allowlist、progress sequenceを検証する。TLS integrationは実UDSとSQLiteを通し、Web listener restart後のSSE再接続、別owner enumeration拒否、large page、slow consumer中の分離、Dispatcher unavailable時のfail-closedを検証する。

production activation、live SSE接続、live credential/provider、長時間ネットワーク上のslow-consumer計測は未実施であり、この変更の完了証拠には含めない。
