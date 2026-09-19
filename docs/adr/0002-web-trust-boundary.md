# ADR 0002: Webのidentity・tenant・deployment・approval境界

- 状態: 採用（設計契約。runtimeの有効化を意味しない）
- 決定日: 2026-09-19
- 対象: [Issue #140](https://github.com/hiragram/dona/issues/140)、[Epic #139](https://github.com/hiragram/dona/issues/139)
- 実装・review用入力: [decision / deployment / failure fixtures](./fixtures/web-trust-boundary.md)

## 前提と既存契約の優先順位

Webは `browser -> Web Adapter / BFF -> Dispatcher -> 既存worker / scheduler / updater` に接続する。BFFは認証・session・CSRFと安全な表示を所有し、job engine、approval broker、executor、DBへの直接writeを持たない。Dispatcherは認可、durable receipt、owner、auditとexecutionの正本を所有する。

[承認ADR 0001](https://github.com/hiragram/dona/blob/0c4a1a451cbeb6962da1d49033948e6fd0f57c46/docs/adr/0001-supervisor-approval.md)と[承認fixture](https://github.com/hiragram/dona/blob/0c4a1a451cbeb6962da1d49033948e6fd0f57c46/docs/adr/fixtures/supervisor-approval-contracts.md)を優先する。参照元は[PR #126](https://github.com/hiragram/dona/pull/126)のexact headで、決定時点では未mergeである。本ADRから既存branchの成果物をコピー・mergeせず、採用版が変われば整合性を再reviewする。[Epic #26](https://github.com/hiragram/dona/issues/26)、[#18](https://github.com/hiragram/dona/issues/18)のtransport-neutral API、[#23](https://github.com/hiragram/dona/issues/23)のawaiting/resumeが接続されるまでWeb decision/executionは `safe_off`。

既存ADRのMVP operationは `slack.post_thread_reply.v1` のみ。production activation、self-update、credential/権限変更、支払い、削除、広範囲通知は対象外のままにする。Web loginやstep-upでoperation allowlistを拡大しない。[Self-update architecture](../self-update-architecture.md)のexact plan承認、terminal barrier、stable updater所有権も変更しない。

## 脅威と安全側の結果

保護対象はprincipal/binding、private job/Result、外部write権限、session secret、approval hash/consume、audit continuity。攻撃者は未認証browser、別principal、盗難session所持者、悪意あるorigin/Result、偽proxy、侵害された片方のcredentialを想定する。host OS/Dispatcher/IdPの完全侵害は本境界だけで解決できず、local operatorとcredential storeの保護がdeployment前提になる。

| 脅威 | 強制する境界 | 期待結果 |
| --- | --- | --- |
| identity/header spoofing | OIDC検証と事前登録mapping。proxy headerは本人性に使わない | `identity_invalid`、認証不可 |
| fixation / stolen session | login時rotate、durable revoke、短期session、approval別credential | 失効後拒否。未失効の盗難cookieによる本人範囲の低risk操作は残留risk |
| CSRF / login CSRF | session-bound token、exact Origin、OIDC state/nonce/PKCE | writeなし、`csrf_invalid` |
| DNS rebinding / proxy spoof | exact Host/Origin、TLS、固定peer、外部からbackendへ到達不可 | 接続拒否または`origin_invalid` |
| IDOR / cross-tenant | 全query/receipt/cursorへinstance・tenant・principal・scope predicate | 存在有無を隠す404、`resource_not_visible` |
| clickjacking / XSS / artifact誘導 | frame禁止、CSP、text表示、外部URLを認可にしない | decisionを埋込不可。script/secretを表示しない |
| approval replay / hash swap | server-side presentation、action hash、credential binding、一回限りchallenge | decision/consume追加なし、audit |
| TOCTOU / revoke race | Dispatcher transactionのcurrent revision照合とexecutor直前再検証 | 未開始作用なし、`needs_review` |
| response loss / crash | durable command receipt、one-shot ledger、read-only reconcile | 不明を成功にせず再writeしない |
| DB restore / clock rewind | session全失効、approval ADRの外部anchor/時刻検証 | 証明できないexecutionを停止 |

## 採用案・却下案と変更費用

以下の期限・運用条件は本プロジェクトの決定であり、引用規格の規定値ではない。

| 境界 | 採用・理由 | 却下案と理由 | reversal / migration cost |
| --- | --- | --- | --- |
| identity | 固定issuerのOIDC Authorization Code + PKCE S256をBFFで検証。principalのrevocation/auditを集中管理 | local password/bootstrap loginは別credential lifecycleを増やす。proxy asserted user/emailは認証の正本が曖昧 | IdP変更は新旧subject mappingをlocalで再承認、全session失効。emailによる自動移行なし |
| local運用 | local/self-hosted IdPも同じOIDC contractを満たす場合のみ可。bootstrapは設定専用 | loopbackだから匿名owner、共有固定token、障害時local loginへのfallbackは拒否 | IdPなしのoffline UIは利用不可。追加するなら別ADRと独立security gate |
| tenancy | 一つのDispatcher instanceに一つのtenant、複数の事前登録principal。deployment間でDB/鍵を分離 | workspace/organizationをclientが切替えるmulti-tenant hostingはMVP対象外 | 将来は全unique key/index/outbox/receipt/cursorを複合化し、分離E2E後に段階移行。費用大 |
| deployment | loopback / private / internetの全modeでbrowser側HTTPS、exact origin一つ、同一hostのBFF/Dispatcher UDS | private networkやlocalhostをTLS/認証の免除理由にしない。cross-origin SPA/token storageは拒否 | origin/RP ID変更はsession失効とcredential再登録、proxy構成変更はfixture再実行 |
| role | local登録の明示scope、owner-only default、supervisorとoperator分離 | IdP group/email、初回loginをadminへ自動昇格しない | role変更でauthz revision増加、既存sessionと未consume approvalを失効 |
| approval | supervisor binding + actionごとの独立hardware WebAuthn step-up。coreのtyped hash/one-shotへ結合 | loginのみ・fresh OIDCのみ・画面clickのみではstolen session対策にならない | credential再登録は既存bindingの二者operator手順、pendingをinvalidate |
| high-risk | 現行MVPでは常にunsupported。将来も独立factor、typed operation/runbook/全gateを必須 | generic self-updateボタン、任意tool proxy、host approval代用は拒否 | 既存ADRの明示改訂とexecutorごとの実装が必要。UIだけの解除不可 |

## Canonical identity・権限

`WebPrincipalV1` は以下をserver-sideで生成し、browserから同名fieldが来た場合はschema errorにする。

| field | 正本・規則 |
| --- | --- |
| `instance_id` / `tenant_id` | install時生成の不変IDと一対一tenant mapping。Host/query/headerから選ばない |
| `principal_id` | opaque内部ID。保護されたregistryでexact `(issuer, sub)` へ一意にmapping。subjectはcase-sensitive |
| `identity_binding_revision` | issuer/subject mappingのrevision。mapping未登録・disabledならlogin拒否 |
| `role_ids` / `scopes` / `authz_revision` | Dispatcherのcurrent registry。token内group/roleをそのまま採用しない |
| `session_ref` / `session_generation` | durable sessionの非bearer内部参照と世代。cookieそのものではない |
| `authenticated_at` / `expires_at` | server検証済み時刻と絶対期限 |
| `supervisor_binding_id/revision` | decision時のみ。既存instance/workspace/supervisorへの明示cross-transport mapping |

roleは加算的だが、scopeとresource predicateの両方を要求する。`requester` は `job:submit` / `job:read:own` / `job:cancel:own`、`observer` は明示resource grantへの `job:read:granted` のみ、`supervisor` はbinding済みworkspaceの `approval:read:bound` / `approval:decide:bound` のみ。supervisorに全job read/cancelを暗黙付与しない。`operator` はbrowser roleではなくlocal保守identityであり、通常sessionからprincipal作成・role変更・binding変更はできない。

`job:submit` のMVP job kindは `analysis.read_only.v1` だけとし、自由文からjob kind/capabilityを増やせない。入力は認可済みresourceのserver生成read-only snapshot、capabilityはそのsnapshot読取と専用scratchへのResult生成だけ。既存workerを起動する際にOS sandboxでnetwork、任意shell/child process、snapshot外のfile、Git/GitHub/Slack/MCPなどのambient credentialと汎用write toolを遮断する。モデル推論に必要な通信だけはtrusted runtime側の固定inference brokerを通し、workerへprovider credentialや汎用network proxyを公開しない。brokerは固定model endpointへの推論だけを許し、任意URL/tool/外部作用への中継を拒否する。credentialを含むhome/environment/configを継承しない。これはLLMへの禁止文ではなくworker起動profileの決定論的enforcementであり、証明できるprofileが既存runtimeに接続されるまでWeb job admission全体を `safe_off` とする。

外部作用を起こすjob kind、commit/push/PR作成、任意command、未知capabilityは `job_kind_unsupported` で拒否する。allowlist拡大には全downstream effectの分類、typed gateway/approval/実行直前認可、ambient credential遮断のnegative testとADR改訂が必要で、既存workerの通常権限をそのまま継承しない。read-only jobが生成した提案も実行許可にはならない。Web approval inboxは既存coreのrequestを別の認可境界で扱い、read-only workerにexecutor権限を渡さない。job cancelはown jobへの既存cancel receiptであり、すでに開始済み外部作用の取消ではない。

全read/write、artifact取得、list pagination、SSE、receipt lookupはcurrent principalとscopeを再認可する。`job:read:own` はpersisted ownerと一致する行のみ。明示grantはresource IDとrevisionへ結合し、grant revocationを再確認する。tenant内でも他principalの存在・件数・cursorを返さない。Slack等からの既存jobをWebへ一括公開しない。cross-transport mappingと明示grantがなければ見えない。


### Snapshot provenanceとdurable quota

snapshotはopaque snapshot IDとdigestに加え、全sourceの `resource_id/resource_revision/owner_instance/owner_tenant/authorization_kind/grant_id/grant_revision`、要求principal/authz revision、作成時刻をimmutable manifestへ保存する。own resourceならgrant fieldを明示nullとしowner一致を要求する。混在snapshotもsourceを省略せず、clientがmanifestを生成しない。snapshot作成、worker起動/resume、各inference送信、Result公開/取得の前にDispatcherが全sourceをcurrent resource/owner/grantへ照合する。削除・revision変更・grant revoke/expiry・可視性不明はsnapshotをinvalidateし、未起動jobは `failed` / `snapshot_authorization_revoked` としてworkerを起動しない。既に動作中なら新規inference/Result公開を拒否して既存job停止経路へ送り、snapshot/scratchを削除する。既に許可して送った推論を取り消せるとは主張しない。IdP/session proofだけでresource grantの再検証を代用しない。

grant照合と使用許可は同じDispatcher transactionでcurrent grant revisionへ結合した一回限りstage permitを作り、inference brokerは送信直前にpermitとcurrent revocation generationを再照合する。queued時のmanifestを古いgrantで更新したり、別snapshotへ暗黙置換したりしない。再認可不能なら新しい利用者依頼が必要。Resultにもsource manifestを結合しておき、ownerが同じでもsource grant失効後は以前のprivate Resultを再表示しない。

Web admissionは全modeで次の上限を強制する。globalは全Web principalの合計であり、既存Dispatcherの全source concurrency制限も併用して厳しい方を採用する。source_event_idごとの既存上限だけに依存しない。

| 資源 | job単位 | principal単位 | Web全体 |
| --- | --- | --- | --- |
| nonterminal job予約 | 1 slot | 4 slots | 16 slots |
| 推論input+output token | 累積30,000 | UTC日ごと300,000 | UTC日ごと3,000,000 |
| 実行時間 | 起動から15分、resumeでも累積 | slot制限を併用 | 既存concurrency以下 |
| snapshot / scratch（Resultを含む） | snapshot 1 MiB、scratch 32 MiB、Result 64 KiB | 128 MiB | 512 MiB |
| retained Web event/job/receipt集合 | 1 command分を予約 | 1,000 commands | 10,000 commands |

正本はDispatcherのdurable quota ledger。dedup lookupを先に行い、同key/payloadは元receiptへ収束、新規commandはevent作成と同じtransactionでprincipal/global slot・最大token・最大disk・metadata枠を予約する。枠不足は429 `quota_exceeded`（単体payload超過は413）でevent/worker作成前に拒否する。IdP subjectやsessionの変更で内部principalを作り直してquotaを回避させない。operatorの新principal追加もglobal枠を共有する。

inference brokerは固定model/tokenizerと最大output量から各callの最大input+output tokenを、jobの累積予約からdurably debitしてから送る。countを証明不能、残量不足、結果不明は次callを送らない。成功responseで確定したusage以外は保守的に最大値を消費済みとし、timeout/crash時にrefundしない。日跨ぎjobもcall実行日のprincipal/global枠を追加予約してから送るため、昨日の予約で今日の上限を回避できない。UTC bucketとreservation generationは既存のrollback-resistant時刻/anchorに結合し、巻戻りやstore不明ではquotaをresetせずadmissionを止める。

時間上限とdisk上限はworker/runtimeとinference broker双方で強制し、scratchはOS quota相当のhard cap、snapshotはread-onlyにする。terminalでもsnapshot/scratchの削除を確認するまでdisk予約を返さず、cleanup失敗・restartで予約を解放しない。retained event/job/receipt枠は既存retention手順で実データを削除した後だけ返す（quotaのために早期削除しない）。ledger/実体不一致はfail closed。上限の引上げはlocal policyの明示改訂とaudit/security reviewが必要で、browser指定やrestartで変更しない。

## OIDC・session・revocation

1. issuer、client ID、HTTPS redirect URI、authorization/token/JWKS/introspection endpointをlocal policyへ固定する。動的issuer/client登録、user入力URLによるdiscovery、無制限redirect取得は不可。issuerの署名key/algorithm allowlist、`iss/aud/azp/exp/iat/nonce`、codeの一回使用、PKCE S256を検証する。曖昧・未知keyは拒否する。
2. login transactionはCSPRNG state/nonce/verifierをserver側に保存し5分・一回限り。短命login cookie `__Host-dona_login`（`Secure; HttpOnly; SameSite=Lax; Path=/`、Domainなし）へbindし、callbackはcode flowのGETだけを例外としてstate/nonceで検証する。return先は固定same-origin path allowlist。callbackでsession cookieを発行した後、queryを消した固定 `/login/complete` へ303する。この遷移先はcookieを必要としないpublicな完了案内だけを返し、session確認・bootstrap・自動redirectを行わない。利用者が固定same-origin dashboard linkを選ぶ新しいtop-level navigationからStrict cookie付きsession確認を始める。cross-site redirect chainでStrict cookieが送られることに依存しない。callbackの303自体にも `Referrer-Policy: no-referrer` を付け、次requestへcode/stateを含むRefererを送らない。BFF/proxyのrequest logはroute template/status/correlation IDのallowlistだけとし、callback query、raw request target、Referer、Cookie、Authorizationをlogging/tracing前に除去する。code/state/tokenをlogしない。
3. login後は256-bit以上のrandom session cookieへrotateし、古いsession/login transactionを無効化する。cookie名 `__Host-dona_session`、`Secure; HttpOnly; SameSite=Strict; Path=/`、Domainなし。JWT/localStorage/sessionStorage/URL bearerを使わない。server DBにはcookieのkeyed digestのみ保存する。login/sessionどちらのcookieも同名cookieが複数あるrequestを `cookie_ambiguous` で拒否し、同じ値でも先勝ち/後勝ちを選ばない。malformed cookieも拒否し、headerの内容をaudit/logへ転載しない。
4. sessionは絶対8時間、idle 30分、どちらか早い方で失効し延長不可。SSE/自動poll/内部再認可をactivityに数えない。access token期限も上限とし、refresh token/offline accessは要求・保存しない。再login時は再rotateする。
5. IdPは認証済みRFC 7662 introspectionで `active` とsubject/client/audience/expiryを照合でき、account disable/revokeをactive状態へ反映するproviderを必須とする。BFFの各認可判定前（SSE各batchと15秒ごとのheartbeatも含む）にonline検証し、positive cacheは使わない。非対応providerはdeployment不可。inactiveはsession revoke、timeout/unavailableは503でresource read/writeともfail closedし、SSEを閉じる。次項のlocal logoutだけは権限縮小の例外とし、別identityへfallbackしない。
6. logoutはCSRF保護POSTでdurable revokeしてcookie削除。IdP introspectionは不要とし、IdP timeout/inactive時でもlocal cookie digest・session binding・exact Origin・CSRFを検証できれば、そのsessionだけをrevokeする。期限切れ/既失効sessionへの同じ操作は冪等に204とするが、scope付与や別session操作へ一般化しない。revokeとauditのdurable commit後に成功を返す。DB/auditのcommit失敗・受理不明では503を返し、cookieを保持する（削除用Set-Cookieを送らない）。成功したdurable revokeをread-backできた後だけcookieを削除する。受理不明ではlocal session状態をread-onlyでreconcileし、自動再POSTしない。未反映を確定できた後の利用者の明示logout、またはlocal operatorの失効を可能にする。local logout専用CSRF取得と失効状態readも、同一cookie digest/Origin/Fetch Metadataを検証しIdP不要で提供するが、他resourceを返さない。principal/role/credential/bindingのrevokeはrevisionをtransactionalに進め、全該当session/challengeを無効化する。既存connectionも次のbatchを送る前に確認する。IdP logoutだけをDona logout成功としない。
7. BFFとDispatcherは同一host、owner-only UDS、専用service credentialで相互の役割を固定する。browserに汎用Dispatcher/MCP credentialを渡さない。DispatcherはBFFだけが作る短命10秒・audience固定・nonce一回限り・method/route/body digest/identity revision結合の認証contextを検証し、local current registryを再認可する。tokenはinternal transportだけで使い永続Resultに残さない。BFFはdecisionを自分で承認済みにせず、WebAuthn proofをcoreで再検証する。

### Queue・consume・外部call直前の再認可

入口の10秒contextをdurableな実行capabilityとして保存しない。DispatcherはWeb ownerの `instance_id/tenant_id/principal_id/session_ref/session_generation` とregistry revisionをevent/job/requestへ保存する。BFFはsession/token storeをdurable保持し、Dispatcher専用の認証済みUDS `revalidate_web_authorization` を提供する。worker/browserからは呼べず、任意session/URLを照合させない。

Dispatcherはqueueからのjob起動・resume、Web requesterまたはWeb approverを持つapprovalのdecision/consume、executorの外部call直前にこのAPIを呼ぶ。入力はpersisted identity、exact job/request/attempt ID、operation/action digest、stage、current revision、source manifest ID/digestと全resource/grant revision、Dispatcher生成nonce。BFFは対応するsessionの存在・generation・idle/絶対/token expiry・revokeを再読し、そのaccess tokenでonline introspectionを実行する。clientからtokenを受けず、workerへtokenも渡さない。成功proofはaudience=Dispatcher、上記全入力・checked_at・10秒以内のexpiryへbindした署名付き一回限り証明とする。Dispatcherは同じstage/nonceに対して署名・期限・local revisionをtransactionで検証/consumeしてから当該gateを進め、外部callまでに期限を越えたproofは使用しない。未使用proofも別stageやattemptへ転用できない。

BFF/IdP unavailable、token消失、session expiry/revoke、proof不明では起動/resume/consume/callをしない。approvalは既存coreの `needs_review` へ収束させ、未起動/resume前jobは `failed` とsafe error `execution_authorization_unavailable` をdurable記録し、自動retryしない。再loginで古いjob/requestのsession bindingを置換せず、利用者による新規依頼/再承認が必要。一時unavailableであってもこの失敗を自動再開せず、`acceptance_unknown`も再実行しない。Web requesterとWeb approverの両方がある場合は双方を照合する。別transportのidentityはそのtransportの既存再認可contractを使い、Web proofで代用しない。

オンライン照合とlocal revokeが直前認可に成功した後の外部IdP側変更は分散系のraceとして残る。local revokeとcommand/decision/claimは同じDispatcher transactionのrevisionで順序付け、execution直前も再認可する。既に外部callに入った作用は自動rollbackしない。IdP障害時の可用性よりfail closedを選ぶ。

## Deployment・cookie・CSRF・proxy

| mode | listener / TLS終端 | trusted proxy | origin / cookie |
| --- | --- | --- | --- |
| `loopback`（既定） | BFFは127.0.0.1 / ::1のみ、browserが信頼するlocal証明書でHTTPS | なし、forwarded系header拒否 | 固定 `https://localhost:7443`、Secure必須 |
| `private` | 同host reverse proxyがprivate addressでTLS、BFFへowner-only UDS | 登録済みlocal proxy一つ | 固定 `https://dona.internal.example`、Secure必須 |
| `internet`（明示opt-in） | 同host reverse proxyでTLS、backend公開禁止、rate/body/connection limit | 登録済みlocal proxy一つ | 固定 `https://dona.example`、Secure必須、HSTS |

上記hostnameはfixture値であり実在環境の設定ではない。TLS秘密鍵とOIDC client/service keyはOS credential store、DBに必要なtokenは同storeの鍵によるenvelope encryption、session/token storeはbackup対象外とする。proxyはincoming `Forwarded`、`X-Forwarded-*`、`X-User` 等を除去する。BFFはproxyのUDS peerを検証し、originは外部設定の一つだけを正本にし、forwarded headerをidentity・tenant・redirect計算に使わない。remote proxy、任意CIDRのtrust、hop数推測は未対応として起動拒否する。local HTTP例外も設けない。

全APIはCORS無効、GET/HEADはread-only。writeはJSONのPOST等とsession-bound synchronizer CSRF token（custom header）を要求し、`Origin`をscheme/host/portまでexact照合する。Origin欠落/`null`、foreign origin、不正Content-Type、cross-site Fetch Metadataは拒否する。tokenはsame-origin認証endpointから取得し、session rotation時再発行する。login開始もsame-originのprelogin token付きPOSTとする。OIDC callbackだけは前節の専用検証を使い、通常writeの例外に流用しない。

Hostはconfigured host/portのみ。read/SSEもcross-originアクセスを拒否し、Originがないsame-origin GETはHost、session、Fetch Metadataとresource認可を必要とする。SSE cursorはopaqueでinstance/tenant/principal/filter revisionへbindし、接続ごと・各batchに再認可する。cursor所持をread権限にしない。idempotency key、session、CSRF tokenをSSE URLへ入れない。

HTMLはCSP `default-src 'none'` を起点に必要なself assetだけを許可、`frame-ancestors 'none'`、X-Frame-Options DENY、Referrer-Policy no-referrerを使う。Result、artifact、外部本文はescaped textで表示し、raw HTML、inline script、mention、URLの自動fetch/unfurlを行わない。downloadも毎回resource認可し、private URL/credentialをproxy表示しない。raw artifactは全種類を `Content-Disposition: attachment`、`Content-Type: application/octet-stream`、`X-Content-Type-Options: nosniff`、CSP `sandbox; default-src 'none'; frame-ancestors 'none'` で返す。filenameはserver生成の安全な固定形式で、artifact申告のMIME/filename/headerを採用しない。HTML/SVGなどを直接navigationしてもsame-origin active documentとして実行させない。inline viewerはMVP外とする。

`Cache-Control: no-store` と `Referrer-Policy: no-referrer` はHTML、login/callback/案内、CSRF/session endpoint、認証済みAPI/Result/receipt/SSE/artifactとそのerror/redirectを含む全private responseに必須。reverse proxyもこれらのcacheを無効化し、ETag/Last-Modifiedによる304再利用を行わない。Service Worker/Cache API/IndexedDB/localStorageへのprivate response保存も禁止する。UIはlogout・principal切替・失効時に既存view/query cacheを破棄し、history/bfcacheからの復帰時もprivate viewを隠してcurrent sessionとresourceを再取得するまで再表示しない。offline/revalidation failureでは過去snapshotを表示せず安全な失敗表示にする。既に人間が閲覧・保存した内容を失効で回収できるとは主張しない。

## Approvalのtransport mappingとone-shot

低riskのown read/submit/cancelにstep-upは不要。approvalはlow-impact operationでも通常sessionだけでは受理しない。登録済みOIDC principalを既存supervisorのinstance/workspace/user/revisionへlocalで明示bindする。同じemail/nameやSlack user IDのclient申告では紐付けない。登録・rotation・recoveryはADR 0001の独立二者operatorとgeneration/anchor規則をそのまま適用する。

Web approval credentialはIdP loginと独立した、hardware保護・non-backup WebAuthn credential、user verification必須とする。registrationはlocal二者手順でattestation trustとnon-backup属性を確認できるauthenticatorだけをallowlist登録する（証明不能なら登録拒否）。synced passkey、同じIdP account recoveryで復旧できるcredentialは不可。RP IDはconfigured originのhostnameへ固定、originはscheme/portもexact検証し、cross-origin ceremonyは拒否する。credential紛失はWeb経由で再登録せずlocal二者recoveryへ戻る。

1. Brokerがcurrent request、visibility、binding、policy、typed immutable actionの安全なprojectionを生成する。web presentationは `transport=web`、request ID、presentation revision、audience principal、action hashへのbindingを持つdurable recordにする。coreのdelivery/presentation contractで `synchronized sent` 相当を検証できる状態になるまでdecision不可。ブラウザに届いたというACKだけでapprovedにしない。
2. UIはoperation、exact target、許可済みexact draft/mention、risk、expiry、opaque action IDをliteral表示する。既存ADRが非表示とするcontent MAC/internal semantic hashは表示しない。Issueのhash表示要求は安全な**表示用plan fingerprint**で満たす: canonicalな非秘密projection（opaque action ID、operation、許可済みtarget、risk、expiry、presentation revision）のSHA-256。本文/PII/credential由来digestを含めず、内部hashとは別field `display_fingerprint` とする。fingerprintも権限確認済みinboxだけへ表示し、MCPの最小projectionを拡張しない。
   approvalのdraft/target表示名/mention文字列にはversionedな可逆display codecを適用する。literal backslashを `\\`、LF/TABを `\n` / `\t`、その他のUnicode `Cc` / `Cf` / `Zl` / `Zp` / ASCII SPACE以外の`Zs` / `Default_Ignorable_Code_Point`（bidi control、zero-width、U+034F、variation selector等を含む）を `\u{XXXX}` の可視ASCII列へencodeしてからHTML escapeする。decodeして元のUTF-8 byte列と一致することをserverで確認し、その表示codec versionとprojectionをpresentation revisionへ結合する。normalize/strip/並べ替えはせず、復元できない不正UTF-8はpresentationを作らない。表示上のescapeと実送信文字の対応を説明し、制御文字を解釈したraw previewは併設しない。codec変更はpending challenge/presentationを失効させる。内部typed hash/content MACは元byte列に対して検証する。
3. approve/rejectごとにCSPRNG challengeを生成し、DBへ `challenge_digest, request_id, decision, action_hash, display_fingerprint, presentation_revision, principal_id, session_ref, instance_id, tenant_id, workspace_id, supervisor_binding_revision, credential_id, policy_revision, expires_at` をimmutable保存する。TTL 2分、request expiry以内、同一requestのactive challengeは一つ。一般的な「5分間昇格session」は発行しない。
4. coreのverified Web transport endpointはsignature、challenge、RP ID hash、exact origin、type、user presence/verification、credential binding/revocation、non-backup属性を検証する。登録credentialごとにdurableな最大 `signCount` を保持し、保存値または受信値の一方でも非zeroなら受信値が保存値より大きいことを必須とする。非zero保存値以下（0への巻戻しを含む）はclone疑いとして `credential_counter_invalid` で拒否し、credentialをrevokeして未使用challengeを失効させる。両方0のcounter非対応credentialはallowlistの登録証明がある場合だけ許可し、counterによるclone検知を主張しない。成功時のcounter更新もchallenge consume/decisionと同じtransactionでCASする。session/CSRF/IdP、requesterのcurrent権限、supervisor visibility、instance/workspace、request/action hash、presentation/credential/policy revision、expiryを再検証し、challenge consume・decision・receipt・stable `dona_approval` outboxを同一transactionで一回だけcommitする。署名はserver保存challengeを介してexact action/decisionへ結合される。browserのhashを正本にしない。
5. receiptは内部にdecision ID、request/action hash、principal/approver binding、proof key version、presentation、decision、expiryを保存する。UIへはopaque receipt ID、state、時刻だけを返す。receipt IDをbearer capabilityにせず、lookupも同じowner/approver scopeで認可する。
6. `approved`、`consumed`、execution attempt/resultを分離する。decision TTL 15分、consume TTL 5分と、時刻/boot/restore規則は既存ADRのまま。consume時・外部call直前のTOCTOU、requester/approver revocation、one-shot、cancel/expiry競合、typed allowlistを既存coreが強制する。checkpointやresumeは#23のdurable pathだけを使い、元turnを保持しない。

同じdecision command keyとpayloadは同じreceiptへ収束し、異なるpayloadは409。challengeの別commandへの再利用は拒否する。応答喪失後は元keyのreceiptをread-onlyで確認し、0件でも自動再送しない。表示用fingerprintの一致はsemantic hash/credential/consumeの代替にならない。高risk actionはstep-up成功後も `operation_unsupported` であり、将来対応は別の明示ADR改訂、typed plan/hash、独立factor、runbook、bypass遮断を全て揃えてから行う。

## 永続identity・非開示・audit

| 保存先 | 保存する最小identity / binding | UI・logの扱い |
| --- | --- | --- |
| protected identity registry | instance/tenant/principal、issuer+sub、role/scope、revision、credential公開鍵/登録証明 | issuer/sub、credential IDは一般UI/SSE/logへ出さない。表示名/emailは認可に使わず既定で保存しない |
| session store | cookie keyed digest、session_ref、principal、世代、issued/idle/absolute expiry、revoked_at、暗号化access token | cookie/token/CSRF/nonce/verifier/署名rawは出力禁止。失効時token削除 |
| Web Event | `source=web`、instance/tenant/principal、identity/authz revision、非bearer session_ref/session_generation、server event ID、command key digest、認可時刻 | payloadにclient identityを混ぜない。source discriminant/versionはdownstreamで追加 |
| job / command receipt | immutable owner instance/tenant/principal、source event、session_ref/session_generation、source manifest、authorization revision、quota reservation、stable command slot/key digest、canonical payload digest | workerへ最小owner contextのみ。secretやraw idempotency keyをResultへ渡さない |
| approval / attempt | 上節のhash、requesterとapproverを別field、workspace/binding/policy/credential revision、decision/consume/attempt ID | 安全なprojectionだけ。raw typed plan、content MAC、私的context、access tokenは不可 |
| audit | sequence、UTC、instance/tenant、actor principalまたは未認証、actor kind、session_ref、role/scope revision、action、resource opaque ID、outcome/error、receipt/attempt、policy/binding revision、key version、previous MAC | 認証失敗のclient申告actorはtrusted actor fieldへ入れない。URL、IP全文、UA、email、本文、token、hash原文は通常logへ出さない |

auditはADR 0001のappend-only chain、DB外CAS anchor、retention checkpoint、key lifecycleを共有し、独自sequenceを発明しない。Web auth/deny auditも400日、approval projection/decisionは90日。通常session tombstoneは絶対期限から24時間後に削除できるが、registry revision/generationとauditは保持する。subject mappingはactive期間のみ保護保存し、revoke後は24時間以内にraw外部subjectと不要なregistration情報を削除するが、`(issuer, sub)` の一意性を失わないよう、versioned length-prefix canonical encodingへのHMAC、`identity_index_key_version`、同じopaque principal ID、revoke generation、quota/audit参照をtombstoneとしてinstanceの寿命中保持する。raw削除とtombstone確定は同じtransaction/保護anchorへ結合する。digestも仮名化されたidentity情報であり匿名とは扱わず、protected registry以外のUI/logへ出さない。再登録は現在保持する全index key versionでlookupし、一致した同じprincipalのrevoke historyとquotaを引き継いでlocal再承認する。別principalへの割当・quota初期化は禁止、複数一致はfail closedとする。

identity index keyはDB/backup外のcredential storeで用途分離する。rotation後の旧keyはtombstone lookup専用としてinstanceの寿命中保持し、新tombstone作成には使わない。再確認できたsubjectだけを同じprincipalの新key digestへ移行し、raw subjectがないtombstoneを推測で再生成しない。旧keyの欠落/失効/漏えい、anchor不一致で全versionの安全なlookupを完走できない場合は、新principal登録・再登録を停止する。local二者operatorが既存principal/quota continuityを証明した明示移行を完了するまで新IDで迂回しない。decisionの監査検証に必要なcredential公開鍵・key versionはverification-onlyとして400日のaudit保持とbackup expiryまで保護保持し、新規認証には使わない。復旧で必要なverification keyは既存ADRの保持期間を守る。

private contextの閲覧権限はsupervisor roleだけでは得られない。Slack targetのvisibility/shared状態とdraft disclosureは既存ADRを優先し、証明不能ならapproval UIを作らない。Web由来requesterも対象workspace actorへの明示mappingとcurrent membershipを要求し、Web identityでSlack権限を捏造しない。UIでhashを見せる要件と既存非開示規則の衝突は、前節の非秘密display fingerprintで解消し、内部hashの公開で解決しない。

## Failure・restart・移行

BFF restartはdurable session revoke/expiryを再読するまでreadyにしない。login transactionと未使用step-up challengeは全失効し、表示・command結果はDispatcher receiptから再取得する。通常process restartでsessionを継続する場合も同一bootとcontinuous clock/UTC high-water markを検証し、経過不明・boot変更・鍵不明・DB restoreではsession全失効。単なるcookie署名一致では復旧しない。

approval one-shot/expiry/auditはADR 0001の外部anchorまで照合する。外部write前にdurable fenceを保存し、`executing`復旧は`acceptance_unknown`、`claimed`はcurrent preconditionを再検証する。時刻証明不能・restore payload欠落時の`needs_review`とpayload削除を上書きしない。IdP unavailableではlocal logout以外の新しいread/writeを止め、DB/audit unavailableではlogout cookieを保持し、durable成功を主張せず、過去の画面を成功状態へ更新しない。audit append失敗もsecurity decisionをcommitしない。

Web schemaはversion付き追加migrationとし、既存Slack/job ownerをWeb default ownerへbackfillしない。unknown versionは起動拒否する。複数tenantへ進むときはinstanceとtenantを同義の文字列にせず、複合foreign keyとall-query isolation testを先に導入する。IdP/origin/credential変更はpending/challenge/session失効を伴う明示maintenanceとする。rollbackはWeb ingress/decisionを無効化し、receipt/consume/auditを保全する。古いbinaryが読めないDBを起動したり、snapshot復元で承認を再利用したりしない。

## Downstream checklistとrelease gate

未決定のsecurity fallbackは残さない。以下は本ADRで決めたcontractを実装・検証する作業であり、このPRのruntime実装ではない。

- [ ] 認証runtime: subject digest tombstone/key rotationを含むversioned registry/session/revocation schema、OIDC+introspection provider適合試験、cookie/CSRF/proxy、WebAuthn登録/counter CAS検証、IdP不要のlocal logout、Dispatcher専用session再認可API、local二者bootstrap/recoveryを実装する。
- [ ] Event/command API: `source=web`、verified owner context、BFF専用UDS authorization、typed submit/cancel、read-only job kind/capability allowlistとsandbox profile、source manifest/grant再認可、durable quota ledger、command key/payload mismatch/receiptを追加する。自由文からidentityを採用しない。
- [ ] read/SSE: 全query/artifact/cursor/receiptへowner/grant predicate、revoke後のbatch停止、restart snapshot、安全なprojectionを実装する。
- [ ] UI: session expiry/relogin、unknown時のread-only reconcile、attachment強制/no-store/history復帰、literal Resultと不可視文字の可逆表示、approval exact target/draft/fingerprint/expiry表示と一回限りceremonyを実装する。
- [ ] approval inbox: #18/#23とADR 0001採用版を再照合し、Web presentation/proof/receiptを既存broker/one-shot/outboxへ結合する。既存MVP allowlist外を拒否する。
- [ ] test: [fixture](./fixtures/web-trust-boundary.md)をFakeClock/IdP/credential/Dispatcherのdeterministic testとbrowser security E2Eへ移す。否定caseは外部call数0とaudit outcomeを検証する。
- [ ] runbook: mode別TLS/UDS/IdP readiness、鍵・binding二者運用、盗難session全失効、provider outage、restart/restore/clock anomaly、audit anchor不一致、receipt不明、rollbackの安全停止を記述する。
- [ ] 最終gate: 全Web reachable writeのbypass inventory、current integration head/baseのreview/CI、authz/CSRF/restart/unknown E2Eを通す。cookie click、fixture、HTTP 200だけをlive execution証拠にしない。

本Issueの成果はdecision/fixtureの確定であり、後続runtimeの完成ではない。Web decisionの依存blockerは既存#18/#23とapproval release gate、Web全体の完成はEpic #139の子実装・統合gateである。

## 外部仕様の参照

OIDCのclaimとcode flow検証は[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)、PKCEとredirect防御は[OAuth Security BCP / RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)、online token状態は[RFC 7662](https://www.rfc-editor.org/rfc/rfc7662)を参照する。本ADRはprovider適合条件を追加しており、OIDC対応だけで採用可能とはしない。

cookie/sessionとCSRFの防御は[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)と[CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、署名・RP/origin・UV検証は[WebAuthn](https://www.w3.org/TR/webauthn-3/)を参照する。hardware/non-backup制限、TTL、role、retentionはDona固有の決定である。
