# ADR 0003: スレッド横断認可の本人証明・管理境界・grant契約

- 状態: 採用
- 対象: Issue #161、統合先 `feature/cross-thread-authorization`
- contract: `cross-thread-authorization/1`。同じcommitのfixtureと一組で参照する。
- 非対象: production有効化、live Slack検証、既存Approval ADRの緩和。後続Issueが実装するまで本機能はsafe-offとする。

## 判断の要約

会話threadは応答先であって認可主体ではない。認可は、serverが検証したprincipal、tenant/workspace、exact resourceまたはtask grant、operation、開示先、policy revisionを入力として毎回判定する。job/thread/channel IDの所持、payloadのactor文字列、本人申告、Codex host approvalは証拠にしない。

| 項目 | 採用するv1契約 | 却下する案 | failure・reversal cost |
| --- | --- | --- | --- |
| Slack principal | workspaceごとのadapter identityで認証したingressから、event ID・attempt・tenant・Slack user・発行時刻・nonceへ束縛した署名proofを発行し、Dispatcherが120秒以内に1回だけ検証・消費して永続principal bindingを作る | payloadの`actor_id`を信用、job ID所持、共有proofの再利用 | 検証不能・replay・期限切れはdeny。鍵rotation中は旧/新key IDを明示し、未知keyを拒否する。bindingを後から別principalへ書換えない |
| transport context | agent APIはevent/attempt専用capabilityをserver-side sessionへbindする。管理APIは別socketと別credentialへ分離し、agent credentialからrouteできない | shared bearerだけでagent/adminを分岐、MCP allowlistだけでOS管理者侵害を防ぐ主張 | restartで未消費session capabilityを失効。管理面統合へ戻すには新ADRと全operationのdeny testが必要 |
| current access | query/write直前にproviderでworkspace membershipとdestination visibilityを照会。成功proofはevent・principal・workspace・destination・issued-atへ束縛し120秒で失効、1 writeにだけ消費 | stale-allow cache、channel名や過去membershipの利用、private/DM/Slack Connectの推測 | timeout、429、退会、履歴visibility不明は同じ`access_unavailable`としてfail-closed。readの短期dedupe以外へcacheしない |
| exact grant | verified principal、tenant、明示したtask/Epicの現在child集合、operation catalog、approval domain、policy revision、15分以内のexclusive expiryをsnapshot化。delegationはscope/期限/operationを縮小する場合だけ | 無期限、将来childの暗黙追加、自由文intent、承認対象operationの免除 | revoke/policy変更を次の判定へ即反映。expiry更新・child追加・operation追加は新grantと必要な再承認を要求 |
| legacy | 真正な保存済み元eventを現在のadapter/providerで再検証できる場合だけ新bindingを作る。できなければ権限者による監査付きrebindを別operationで実行するまで`unknown` | actor文字列からownerを自動推測、terminal jobだから許可 | 自動backfillしない。rollbackは新bindingを無効化するだけでlegacy rowを書換えず、外部writeや開示を巻き戻したとは扱わない |

## 証跡と永続境界

principal proofの署名対象は`version, key_id, event_id, attempt, tenant_id, workspace_id, principal_kind, principal_id, issued_at, expires_at, nonce`である。署名bytesはUTF-8 JSON、object keyを全階層でASCII昇順、空白・末尾LFなしとする。`version`と`attempt`はsafe integerの10進表記、時刻はUTC秒精度の`YYYY-MM-DDTHH:mm:ssZ`、文字列はJSON標準escapeとし、浮動小数、重複key、未知fieldを拒否する。署名はHMAC-SHA-256の32-byte digestで比較はconstant-time、key materialは32 byte以上とする。fixtureの短いsample keyはgolden vector検算専用でproductionに使わない。`principal_kind` v1は`human`だけをowner-wide操作へ許可し、bot/service/schedule/unknownはdenyする。proof本文、署名、credentialは一般auditへ残さず、検証後はdigest、key ID、decision code、consumed timestampだけを保持する。

永続bindingは元eventのimmutable identity、verified principal、proof digest、binding revision、created/revoked timestampsを持つ。eventの再送は同じattempt identityならidempotent、異なるprincipalやdigestならconflictとして隔離する。restart後もbindingとnonce消費を同じtransactionで読める必要があり、process memoryだけを正本にしない。

各判定では保存済みbindingとrequestだけでなく、現在認証されたtransport contextの`event_id`と`attempt`も三者一致させる。bindingのtenant/workspace/principal kindもrequest、grant、verified principalと一致させ、自己整合した古いevent/bindingの組を別sessionから再利用できないようにする。

grantのtyped intentは次のoperation catalogから選ぶ。`read_own_human_waits`、`read_exact_job_status`、`read_bounded_result`、`steer_exact_job`、`cancel_exact_job`、`resolve_origin_ref`は別権限であり、前者から後者を推論しない。

grantは`issued_at`とexclusiveな`expires_at`を持ち、その差は正かつ900秒以下でなければならない。catalog外operation、current resource revision不一致、`revoked`または`revoked_at`を持つgrantは、期限前でも次の判定から即時denyする。

v1ではread系と`resolve_origin_ref`は追加approval不要だが、`steer_exact_job`と`cancel_exact_job`はIssue #15のsupervisor approval domainへ接続し、次のtyped receiptを必須とする。receiptは`version, receipt_id, issuer_kind, issuer_id, tenant_id, principal_id, resource_kind, resource_id, resource_revision, operation, issued_at, expires_at, policy_revision, nonce`を上記と同じcanonical encodingで署名する。issuerは`supervisor`だけ、expiryは発行から5分以内かつexclusive、operationとresource revisionは完全一致、一度だけ消費する。missing、unknown issuer、期限切れ、revision/operation不一致、#15の実装が未提供の場合は`approval_unavailable`でdenyし、read grantから補完しない。将来、対象operationまたはissuerを変える場合は新contract versionと#15側の合意が必要である。

## 認可decision table

1. agent transportを認証し、current event/attempt専用contextを取得する。
2. principal binding、tenant/workspace、principal kind、grantのresource集合・operation・expiry・policy revisionを照合する。
3. destinationを伴う操作はcurrent access proofを直前に検証する。
4. resource revisionとdisclosure projectionを確定し、認可後の可視集合だけを返す。

どの段階でも不明ならdenyし、外部向けerrorは`not_available`または`access_unavailable`へ縮退する。restricted auditだけに`unverified_ingress`、`principal_mismatch`、`grant_expired`、`policy_revision_mismatch`、`membership_revoked`、`legacy_unknown`等を残す。存在・件数・cursor・timing・詳細errorで不可視resourceを推測できる差を作らない。

current access proofは`status, event_id, principal_id, workspace_id, destination_id, issued_at, expires_at, nonce, consumed`を持ち、requestと全identityを一致させる。寿命は正かつ120秒以下、expiryはexclusive、write用proofは一度だけ消費する。destination/principal/event不一致、期限切れ、消費済み、provider unavailable/revokedは外部へ`access_unavailable`だけを返す。それ以外の内部denyはresource ID、件数、cursor等を付けず`not_available`へ縮退する。

fixtureの主な期待値は次のとおりである。

- 古いevent差替え、偽completion、未認証enqueue、別actor、bot/service、退会、provider停止、期限境界、legacy不明はdeny。
- 同じverified human、同じtenant/workspace、exact task、許可operation、current access、未失効revisionだけがallow。
- read operationはjob/group/schedule/session/notification stateを変更しない。

## migration・recovery

schemaはversion付きで追加し、既存rowは`legacy_unknown`のまま保持する。migration/rebuildはbounded batchとcursorを使い、dry-runで件数bucketとdecision classだけを出す。snapshot revisionより新しいbinding、revoke、grantを上書きしない。write応答不明は同じwriteをblind retryせず、digest・revision・nonce消費をread-backして照合する。

rollbackは新規issue/authorization routeをsafe-offにし、新binding/grantをrevokedとして残す。既存thread-bound APIへfull Resultのcross-thread fallbackを作らない。外部開示、承認、cancel等の副作用は自動で巻き戻さない。

## downstream更新表

| Issue | 必須artifact |
| --- | --- |
| #162 | Slack adapterの署名proof、key rotation、replay/attempt/restart test |
| #163 | event/attempt専用agent context、別socket/credentialの管理API、route deny test |
| #164 | principal・exact task・resource revisionの永続binding、legacy unknown migration |
| #165 | current membership/visibility proof、120秒expiry、provider failureのfail-closed |
| #166 | 共通authorize、operation catalog、restricted audit、安全なprojection fixture |
| #244 | owner bindingを使うhuman-wait read model。自由文やdestinationを複写しない |
| #245 | `read_own_human_waits`、認可後filter、bounded pagination、opaque origin ref |
| #246 | 明示intent、safe renderer、origin再認可、曖昧Slack writeの非再試行 |

## 検証境界

`node --test test/cross-thread-authorization-policy-fixtures.test.mjs`はfixtureのcanonical bytes、必須case、allow/deny条件、expiry exclusive、deny projection、downstream mappingを検査する。署名暗号、socket分離、Slack provider、DB migration、production rolloutはこのADRでは実装・検証しない。
