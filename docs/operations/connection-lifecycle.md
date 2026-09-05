# 外部connection・subscription・cursorの運用

Issue #51の共通registry。provider固有の署名検証・resource取得・実API driverは各pilotが供給する。#48の `VerifiedIngressPrincipal.connectionId`、`ExternalIngressRegistry`、`PersistReceipt`、`scopedExternalEventId` を再利用する。queue fairness、job ownership、scheduler、任意のbusiness outboundは変更しない。

## 保存と認証境界

`connections` はprovider・account・resource/event allowlist・credential reference/capability revision・設定revisionを保持する。設定はstrict schemaで未知fieldを拒否する。credentialは `cred_...` の参照だけを登録し、secret本体、passcode、verification/channel token、private callback URLは渡さない。参照を解決するのはdriver/認証adapterだけで、CLI・healthには参照をredactして返す。provider ID/resourceも安全な識別子だけを渡す。checkpointはproviderの継続tokenとしてDB内に保持するが、CLI/logへ表示しない。

認証adapterはraw bytesを検証した後、永続設定と認証済みtransportから `VerifiedIngressPrincipal.connection` に `account / revision / credentialRevision / resource / generation` を設定する。payloadの自己申告から作らない。現在のsecret-store capabilityを認証時に検証し、失効時は拒否する。Dispatcherは同じtransactionで永続設定・generation・期限・allowlistを再検証しeventを保存する。bindingをEnvelope/Resultへコピーしない。driverはnormalizerのresourceと認証対象resourceの一致も保証する。

registryへ1件でも登録されたsourceはmanaged sourceになり、そのsourceのbindingなしの受信を拒否する。登録前の未binding queued eventも自動dispatchしない。未登録sourceの#48 contractは互換維持する。connectionごとのevent bindingを追加tableに保存し、disableまたはrevision不一致のeventはqueue選択とdispatch開始の両方で拒否する。dispatch開始が先にcommitしたeventを取り消す機能ではない。event/result/job/auditは削除しない。

event bindingはresource/generationも保持し、dispatch開始時にsubscriptionの検証状態と期限を再検査する。新generationから同一eventが再送された場合は、同じrevisionのbindingだけを新generationへ進める。Driverはprovider/source discriminatorを持ち、capabilityとproviderの両方がconnectionと一致することを外部call前に検査する。

## capabilityと状態

| capability | 登録・検証 | renewal |
| --- | --- | --- |
| `manual` | UI/installation等で既に存在するprovider IDをattachしread-only inspect | create/renew/stopを提供しない |
| `managed`, `renewal: none` | 明示認可後にtyped create、inspect | 再createしない |
| `managed`, `renewal: replace` | create、inspect、generation overlap | expiry-window以降に次generationをclaim |

NotionのUI型、GitHubのinstallation設定、FigmaのAPI管理、Driveの期限付きchannelのような差を、各pilotがこのcapabilityへ明示mappingする。すべてのproviderへrenewalを強制しない。windowはsubscriptionごとに保存する。

- register → `verification_pending`。inspectで認証・provider IDを確認すると `active`。
- 未解決のcreate/stopまたはstop_candidateがある間はrevision更新を拒否する。まずlookupや認可済みstopで既存操作・停止候補を解消する。緊急停止にはrevision更新を待たずdisableを使う。
- allowlist/credential revision更新 → `degraded`。旧revisionの通知/queued event/cursor commitは拒否する。更新前のgenerationを新credentialでread-only verifyし、新revisionへ再bindingできる。provider/accountは変更不可。初期cursorも登録時に保存し、未commitの場合も含めて `rebindCursor` に旧checkpoint/versionを指定し、tokenを保持したまま明示再bindingする。
- resourceのinspect失敗は、そのsubscriptionのverifiedAtを消してquarantineする。他resourceの成功でconnectionがactiveへ戻っても、失敗resourceのdelivery/dispatchは再開しない。
- 最新generationがquarantineされ、未解決operationがない場合は、`createOrRenew`の明示認可を取り直して次generationを作成できる。自動置換は行わない。
- verifyはallowlist・遷移可否を確認し、provider read前にpending状態とverification epochを保存する。期限切れやprovider ID不一致のobservationも失敗として隔離する。再起動時もpendingを保持し、並行verifyの遅延結果はepochで拒否する。healthはquarantine/pendingのresourceも集計する。
- expiry-window内はinspection/healthで `expiring`。期限切れ通知は拒否する。
- claimは `BEGIN IMMEDIATE` 内でgenerationとoperation ID/leaseを永続化する。driverへoperation IDをidempotency/lookup keyとして渡す。1 resourceの未解決操作がある間は次操作を作らない。
- timeout、create成功後response loss、claim後crashは `renewal_unknown` / operation `unknown`。lease expiryはlookup権限だけを与え、再create権限を与えない。driverの遅延responseを追って二度commitしない。
- lookupがgeneration/provider IDを確定した後だけ状態を復元する。createのlookupがnot-foundでも元の要求が遅延中の可能性があるため自動再createしない。stopのlookupの `null` はdriverが権威あるreadで停止を確定できた場合だけ返す。不確実なreadは例外にする。
- overlap中は検証済みold/newからの通知を同じconnection-scoped IDでdedupする。新generationの `cutoverConfirmed` が得られて初めてoldを `stop_candidate` にする。実stopは別の明示認可を必要とする。停止応答不明も再stopせずlookupする。
- stopのclaim時は旧generationのqueued/retryable eventを、同revisionの検証済み・期限内の新generationへ原子的に移す。外部stop待ちに届いた旧channelの通知も新generationへbindingする。有効な移行先がなければstopを開始しない。再verifyで設定revisionを採用するとrenewal windowも更新し、表示とclaim判定に同じ保存値を使う。
- binding移行はcompleted以外の全状態を対象にし、blocked/needs_review/dead_letterや進行中eventが後で失敗した場合も、運用者による明示retryの経路を保つ。eventの状態・結果自体は変更しない。healthのpendingは、allowlist内にsubscription未作成または現revisionで未検証のresourceがある場合も検出する。
- disable → `disabled`。自動enable/delete/recreateはない。時計後退時もdisableはでき、監査時刻は後退させない。他の更新は `clock_skew` で拒否する。

`ConnectionLifecycle` は `Driver` と `OperationAuthority` をconstructorで受ける。authorityはexact connection/revision/resource/kindの運用許可を確認する。一般MCPやpayloadのbooleanをauthorityにしない。credential availabilityを確認した後、認可中の設定変更をclaimで再検証する。renewalは運用側が対象を選んで `createOrRenew` を呼ぶ。自動常駐schedulerやprovider固有CLI/credential設定はこの共通層には追加しない。

## cursor batch

`pollConnectionBatch` は各page前にbindingを検査し、最終pageまで成功した場合だけ `DispatcherDatabase.commitConnectionBatch` を呼ぶ。途中page失敗、timeout、page循環、page/event上限超過ではeventとcheckpointをcommitしない。checkpointは同じSQLite handle上でbatch内eventのdurable enqueueと原子的に進める。ここでの処理完了はingress batchのdurable commitであり、後続jobのbusiness処理完了ではない。

cursor revision不一致は最初のfetch前に拒否する。workerのpreflight中にconnectionがdisable/reviseされたり期限が切れたりした場合、dispatch開始の条件不一致はそのeventのskipとして処理し、後続eventを止めない。

compare対象は `{revision, version, checkpoint}`。duplicate conflictやSQLite例外でbatch全体をrollbackする。commit直後response lossでは保存済みversion/event receiptをread-only照合し、古いbatchをblind再送しない。空の最終pageも認証/allowlist/期限を検査する。fetch driverは秘密を含まない正規化済みeventと、generationに依存しないprovider event IDを返す。

## CLIとhealth

リポジトリrootで `npm --prefix dispatcher run build` 後に利用する。`DONA_DATABASE_PATH` は運用者が選んだ隔離DBを指定する。

```sh
DONA_DATABASE_PATH=/path/to/isolated.sqlite node dispatcher/dist/cli.js connection register /path/to/connection.json --confirm
DONA_DATABASE_PATH=/path/to/isolated.sqlite node dispatcher/dist/cli.js connection list
DONA_DATABASE_PATH=/path/to/isolated.sqlite node dispatcher/dist/cli.js connection show pilot
DONA_DATABASE_PATH=/path/to/isolated.sqlite node dispatcher/dist/cli.js connection health
DONA_DATABASE_PATH=/path/to/isolated.sqlite node dispatcher/dist/cli.js connection disable pilot 1 --confirm
```

register/revise/attach/disableはローカルregistryへの明示write。provider resourceを作成しない。`list/show/health` はSQLite readonlyで開き、migration/chmodを行わない。attachは `connection attach <id> <revision> <subscription.json> --confirm`、reviseは `connection revise <id> <revision> <config.json> --confirm`。attach JSONは `resource / providerId / expiresAt`、config例は次のとおり。

```json
{"id":"pilot","provider":"drive","account":"account1","allowlist":[{"resource":"folder1","events":["changed"]}],"credentialRef":"cred_fixture","credentialRevision":1,"capability":{"kind":"managed","cursor":true,"renewal":"replace","windowMs":1000}}
```

`show` にgeneration、provider ID、created/verified/expiry、renewalWindowMs、lastDeliveryAt、lastReconcileAt、error、operation状態/lease、cursor versionを表示する。`health` と `/health/ready` の `connections` は `ready / degraded / pending / expiring / unknown / disabled / staleLeases` を返す。これらはconnectionの集計gaugeで、既存Dispatcher process readinessとは区別する。無効なconnectionの詳細やsecretをmetric labelへ入れない。

## migration・rollback

専用 `connection_schema.version=1` とadditive table/index/FKを1 transactionで作る。現行queue schemaの `PRAGMA user_version=4`、events/jobs schemaとrowは変更しない。二度目の起動はcomponent versionを確認する。将来versionは拒否する。

旧版は既存event/jobとDBを読めるが、connection binding/disableを認識しない。**旧版へのrollbackはprovider受信・provider eventのdispatchを停止した状態でのみ可能**。data read互換とprovider運用互換を同一視しない。稼働中の旧版へこのDBを差し替えない。バックアップは停止中またはSQLite backup APIでWALを含む整合snapshotを取り、rollback時も追加tableを消さない。delete/recreateを復旧手順にしない。

## 検証とlive smokeの境界

`npm --prefix dispatcher test` はfake driver/clock、HTTP ingress、別processのlease/cursor/disable競合、response loss、timeout、credential unavailable、clock rewind、partial page、DB busy、checkpoint前のSQL abortとcommit後の再読、migration rollback/FK、event/job row不変を検証する。

実providerのtest connection・credential・認可済みdriverはこの変更では用意しないため、live smokeは未実施。pilotごとに以下を実行する。

1. 認可済みtest accountと既存subscription/channelの識別子、resource/event allowlist、secret-store reference、typed capabilityを運用者が確定する。
2. 隔離DBへCLI登録し、`list/show/health` でredactionとpending状態を確認する。manual型は既存provider IDをattachする。
3. pilot driverのread-only `verify` / `reconcile` を `ConnectionLifecycle` 経由で実行し、verified/expiry/lastReconcileAtを再読する。共通CLIは任意module/commandを読み込まず、provider固有read adapterの配線はpilotが担当する。
4. 明示許可されたtest deliveryでpersist receipt/dedup/lastDeliveryAtを照合し、private token/raw payloadがResult/logへ出ないことを確認する。
5. create/renew/stopが必要なら、exact connection/revision/resource/kindの別途運用許可を取り、pilotのtyped driver/authorityだけで実施する。曖昧な応答はlookupへ送る。

この手順はproduction deploy/self-updateや実認証・allowlistの変更を許可するものではない。
