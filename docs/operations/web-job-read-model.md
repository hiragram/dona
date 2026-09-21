# Web job read model・SSE運用契約

## 境界

Web job read modelは、認証済みBFFがDispatcherのowner-only UDSを介して利用するread projectionである。browserが送るjob ID、cursor、`Last-Event-ID`、header内のactor情報はauthorityにしない。BFFがonline identity確認後に署名したingress contextをDispatcherのcurrent Web sessionへ再照合し、`instance_id`・`tenant_id`・`principal_id`が一致する`source=web` jobだけをfilterしてからpaginationする。

本実装はjob submit/cancel、session/auth core、CSRF/origin、approval、artifact content downloadを変更しない。production listenerの有効化やlive provider検証も行わない。

## 公開projection

- 一覧は最大50件、`created_at DESC, job_id DESC`のstable orderingと15分のopaque cursorを使う。cursorはowner、snapshot high-water、次page境界へ永続bindし、別principalへの持ち替え、改変、期限切れを拒否する。
- 詳細はstatus、時刻、標準化済みprogress、terminal Resultの固定summary、安全なartifact metadata、cancel eligibilityだけを返す。
- `objective`、raw Result summary/output/actions、DB row、workspace/result path、runtime identity、private URLは返さない。terminal summaryはResult statusから`完了`または`失敗`だけを生成する。artifact名は入力値を公開せずordinalな`artifact-N`へ置換し、固定`kind`、妥当なmedia type、sizeだけをallowlistする。
- 別owner jobと未知jobは同じ`not_found`として扱い、不可視件数をpage size、cursor、error差へ反映しない。

## durable cursorとSSE

`web_job_projection_events`はjob INSERT/UPDATEと同じSQLite transactionのtriggerでmonotonic sequenceを記録する。progressは既存のdurable progress storeのsequenceを`web_job_progress_versions`へ単調にreconcileし、再起動後もcurrent snapshotへ収束できる。cursorはrandom 256-bit tokenのdigestだけをDBへ保存する。

`GET /api/jobs/:id/events`はboundedなone-shot SSE responseを返して接続を閉じる。変更があれば`event: job`、なければ`event: heartbeat`、retention gapなら`event: reset`を返し、各responseのopaque `id`を次の`Last-Event-ID`に使う。同じcursorの再送は同じ範囲を安全に再読できるため、応答喪失、disconnect、duplicate deliveryでmemory-only stateを正本にしない。Web process restart後もcursorとevent ledgerはDispatcher DBから復元される。

one-shotかつbody上限付きなので、slow consumerはTLS listenerの既存接続上限・secure lifetime・socket closeで隔離される。接続切断をjob mutationとして扱わず、再接続時はdurable snapshotを再取得する。

## retention・障害時の扱い

- event ledgerの削除は`pruneWebJobProjection`で時刻境界を明示して行う。存在するWeb jobはlist cursor用の最初のanchorだけを保持し、削除済みjobのanchor/tombstoneはwatermark更新後に削除する。cursor期限切れも同じmaintenanceで削除できる。
- cursorが保持するsequenceより古いeventがretentionで失われた場合は、欠落を成功扱いせず`reset_required`を返す。clientは完全snapshotを再取得し、新しいdetail cursorから再開する。
- Dispatcher UDS、署名response、current access確認、DB queryのいずれかが失敗した場合、BFFはstale cacheや旧APIへfallbackせず`identity_unavailable`にする。
- event件数、cursor件数、最古event時刻、reset発生数を運用metric候補とする。private identity、job本文、Result summary、cursor token自体はlog/metricへ出さない。

## 検証

contract testはprincipal filter-before-pagination、snapshot境界、cursor tamper/cross-owner、concurrent update、duplicate reconnect、retention gap、Result/artifact allowlist、progress sequenceを検証する。TLS integrationは実UDSとSQLiteを通し、Web listener restart後のSSE再接続、別owner enumeration拒否、large page、slow consumer中の分離、Dispatcher unavailable時のfail-closedを検証する。

production activation、live SSE接続、live credential/provider、長時間ネットワーク上のslow-consumer計測は未実施であり、この変更の完了証拠には含めない。
