# Web trust boundary decision / deployment / failure fixtures

[ADR 0002](../0002-web-trust-boundary.md)の実装・review用fixture。すべて架空値であり、実行可能な認証設定・production credentialではない。文書fixtureの存在だけではruntime test成功を意味しない。

## 固定context

`instance_a` は `tenant_a` だけを所有する。`principal_a` はrequester、`principal_b` はobserver、`principal_s` はsupervisor。`job_a` のownerはa、`job_b` のownerは別principal。observer bのgrantはjob_aだけ。supervisor sのbindingは `workspace_a/revision=3`、requester aもworkspace_aへの明示mappingとcurrent membershipを持つ。別 `instance_b/tenant_b`、別workspace、未登録principalには全てdefault deny。

## Principal・tenant・role decision table

| ID | principal / scope | target / 条件 | 期待HTTP・outcome | 外部作用 |
| --- | --- | --- | --- | --- |
| P01 | 未認証 | list/submit | 401 `session_invalid` | なし |
| P02 | a requester | own job_a read | 200、safe projection | なし |
| P03 | a requester | `analysis.read_only.v1` submit、current認可/profile gate成功 | 202、durable event/receipt一件 | 隔離snapshot解析のみ、外部writeなし |
| P04 | a requester | own job_a cancel | 202、既存cancel receipt | cancel requestのみ。外部作用rollbackなし |
| P05 | a requester | job_b read/cancel/receipt | 404 `resource_not_visible` | なし |
| P06 | b observer | explicit grantのjob_a read | 200 | なし |
| P07 | b observer | job_a cancel/submit | 403 `scope_denied` | なし |
| P08 | s supervisorのみ | job一覧、own-read scopeなし | 403 `scope_denied` | なし |
| P09 | s supervisor | bound inbox、current visibilityあり | 200、許可projectionだけ | なし |
| P10 | s supervisor | supported reply approve、全proof一致 | 200、decision/outbox一件 | この段階ではなし |
| P11 | a requester | approve | 403 `scope_denied` | なし |
| P12 | 任意の有効role | tenant_b / instance_bのIDまたはcursor | 404 `resource_not_visible` | なし |
| P13 | s supervisor | workspace_bのapproval | 404 `resource_not_visible` | なし |
| P14 | a+s両role | 他人のjob cancel | 404 `resource_not_visible` | なし |
| P15 | operatorを名乗るheader | role/binding変更API | 403 `scope_denied`、browser APIなし | なし |
| P16 | s + valid step-up | self-update/production/high-risk | 422 `operation_unsupported` | なし |
| P17 | a requester | read-only profile未接続のWeb submit | 503 `execution_safe_off` | なし |
| P18 | a requester | commit/push/PR作成、任意shell/未知job kindをsubmit | 422 `job_kind_unsupported` | なし |
| P19 | a requester | read-only jobからnetwork/credential/外部file/write toolへ到達 | sandbox/capability deny、job failed | external call 0、host secret読取0 |
| P20 | a requester | 一意commandを繰り返しprincipal/global nonterminal slot超過 | 429 `quota_exceeded` | 新event/worker 0、同keyは元receipt |
| P21 | a requester | token/day、disk、retained metadata枠のいずれか超過 | 429 `quota_exceeded`、単体oversizeは413 | 起動/推論送信0 |
| P22 | a requester | restart、日跨ぎ、clock rollback、cleanup失敗 | reservation保持、当日枠再予約、時刻不明はfail closed | reset/refundで上限回避不可 |
| P23 | a requester | jobの15分/30,000 token/32 MiB超過、inference応答不明 | runtime/broker停止、unknown最大token debit維持 | 追加callなし、disk削除前予約解放なし |

全拒否は本文やcandidate IDをechoせず、認証済みactorまたは未認証、operation、safe error code、sequenceをauditへ残す。resource認可を通らないIDはauditにもraw転載せず、bounded keyed referenceにする。

## Deployment config fixture

値の組合せ全体を起動時検証する。unknown key/mode、空origin、複数origin、無効cert、trusted peer不明は `deployment_invalid` でready=false、HTTP受付なし。

| ID | mode | browser origin / listener | backend / trust | cookie | 期待 |
| --- | --- | --- | --- | --- | --- |
| D01 | loopback | `https://localhost:7443`、loopbackのみ、trusted cert | BFF直接TLS、proxyなし | `__Host-dona_session; Secure; HttpOnly; SameSite=Strict; Path=/` | 起動可 |
| D02 | private | `https://dona.internal.example`、private proxy TLS | same-host UDS、登録proxy peer | D01と同じ | 起動可 |
| D03 | internet opt-in | `https://dona.example`、public proxy TLS/HSTS | same-host UDS、backend非公開 | D01と同じ | rate/body/connection limitを伴い起動可 |
| D04 | loopback | `http://localhost:7443` | proxyなし | Secureなし | 起動拒否 |
| D05 | private | HTTPS | `trust all proxies` / remote proxy | Secureあり | 起動拒否 |
| D06 | internet | HTTPS | backendも0.0.0.0へ公開 | Secureあり | 起動拒否 |
| D07 | 任意 | wildcard origin / Host由来origin | 任意 | Domain指定 | 起動拒否 |
| D08 | private | D02 | 外部header `X-User=s`, `X-Forwarded-Host=evil.example` | D01 | proxyが除去、BFF identity不変。除去できない構成は拒否 |
| D09 | loopback | Host `evil.example`、loopback宛 | proxyなし | valid cookie | 403 `origin_invalid`、情報/作用なし |
| D10 | 任意 | 固定OIDC issuer | introspection未対応/disable反映不能 | 任意 | readiness拒否、local loginへfallbackなし |

## Auth・CSRF・privacy failure fixture

| ID | 入力・障害 | 期待error / durable outcome | audit・作用 |
| --- | --- | --- | --- |
| F01 | 盗難cookie、まだ有効、own read | 通常認可どおり。盗難を自動検知したと偽らない | actor=aとして記録、残留risk |
| F02 | F01のcookieでapprove、独立credentialなし | 403 `step_up_required` | decisionなし |
| F03 | cookie/session/principal revoke後に再利用 | 401 `session_revoked` | deny、作用なし |
| F04 | SSE接続中role/grant revoke | 次batch前に拒否、最大15秒heartbeatで切断 | revoke以後の再認可失敗時データなし |
| F05 | valid session、CSRF欠落/不一致/Originなし/null/別port | 403 `csrf_invalid` または `origin_invalid` | writeなし、deny |
| F06 | state/nonce/PKCE/issuer/audience不一致のcallback | 401 `identity_invalid`、login transaction無効 | session発行なし |
| F07 | login前cookieを固定してcallback | successなら新cookieのみ有効 | old session revoke、一回限り |
| F08 | IdP timeout、既存sessionあり、resource API | 503 `identity_unavailable`、SSE閉鎖 | resource read/writeなし、別identityなし |
| F09 | IdP introspection inactive/subject/client不一致 | 401 `session_revoked` / `identity_invalid` | session revoke、deny |
| F10 | HTML/script/credential/private URLを含むResult | allowlist projection、literal text/redaction。raw HTML/SVGへの直接navigationもattachment/octet-stream/nosniff/CSP強制 | script/fetchなし、same-origin API呼出0、raw値をlogしない |
| F11 | 別principalのreceipt key/cursorを推測 | 404 `resource_not_visible` | read/controlなし |
| F12 | 8時間/idle30分/token expiryの最小期限超過 | 401 `session_expired` | 延長なし、SSE/pollで延命しない |
| F13 | cookie valid、authz revision stale | 401 `session_revoked` | transactionのcurrent revision優先 |
| F14 | 未認証headerのactor/email | 401 `identity_invalid` | trusted actor=null、PII raw記録なし |
| F15 | IdP timeout/inactive、valid local session/Origin/CSRFでlogout | 204、durable revoke+audit、cookie削除 | IdP復旧後も旧cookie拒否 |
| F16 | F15でCSRF/Origin不正 | 403 `csrf_invalid` / `origin_invalid` | revokeなし、権限昇格なし |
| F17 | logout中DB/audit commit失敗 | 503 `durability_unavailable`、cookie保持・削除Set-Cookieなし | durable revoke read-back成功後だけ削除 |
| F18 | logoutでcommit応答喪失 | cookie保持、local失効状態GETでread-only reconcile | 自動再POSTなし、確定したrevoke後だけcookie削除 |
| F19 | IdPからStrict cookie発行→cross-site 303、redirectにcookieが付かないbrowser | cookie不要の固定案内200→利用者の新しいsame-site link navigation | dashboardで認証成功、手動reload不要、案内にprivate情報なし |
| F20 | private API/receipt/artifactを取得後logout・別principalに切替、同じURL取得 | 全response no-store、proxy cacheなし、304なし、current認可 | 前principalのresponse再利用0 |
| F21 | history/bfcache復帰、offlineまたはsession revoke | private viewを隠し再認可失敗表示、in-memory/cache storage再表示なし | 前principal情報非表示 |
| F22 | IdP障害中にpage reload後logout | local専用CSRF取得と失効状態readがIdP不要で利用可能 | 同一cookie/Originのみ、他resource公開なし |
| F23 | callback queryにcode/state、同origin完了pageへ303 | redirect response自身のno-referrer、次requestにRefererなし | BFF/proxy access log/traceにquery/code/state/header 0 |
| F24 | requester+observerがgrant経由snapshotをsubmit後、queue中にgrant revoke | manifestの全source revision照合でjob failed | worker起動/inference送信0 |
| F25 | resume前/source改訂後、混在snapshotの一sourceのみgrant失効 | snapshot invalidate、暗黙再生成なし | worker/resume 0、Result非表示 |
| F26 | running中またはResult保存後にsource grant revoke | broker送信前permit失効、job停止、Result read拒否 | 新規推論/private Result公開0、既送信分を取消成功としない |
| F27 | sibling hostがloginのparent-domain cookieを植える | __Host-dona_login・Path=/・Domainなしをbrowser/server設定で強制 | 植えたidentityでcallback成功しない |
| F28 | login/session同名cookieを二つ送る（同値/異値）、malformed cookie | 400 `cookie_ambiguous` / `cookie_invalid` | cookie選択/session発行なし、raw header非記録 |
| F29 | raw subject削除後に同じissuer/subを再登録、新index keyへrotation | tombstone lookupで同principal/revoke/quotaを継承、local再承認必須 | 新principal割当/quota resetなし |
| F30 | 旧identity index key欠落/失効/漏えい、複数digest一致、anchor不一致 | identity registration fail closed | 新IDで再登録を迂回しない |

## Approval・receipt・restart fixture

正常例は `approval_a`, operation `slack.post_thread_reply.v1`, policy=1, binding=3, presentation=4, credential=`credential_s`、instance_a/tenant_a/workspace_a。typed hashはBrokerが保存した値、表示fingerprintは非秘密projectionから別計算する。すべてcore gate成功後の期待値であり、現時点のruntime状態ではない。

| ID | 変更・競合・fault | 期待HTTP / durable outcome | consume / execution |
| --- | --- | --- | --- |
| A01 | 全binding一致、valid UV署名、2分以内 | 200、challenge used、decision+receipt+outbox各一件 | execution未開始 |
| A02 | A01と同じcommand key/payloadを再送 | current認可後に同じreceipt | 追加decision/consumeなし |
| A03 | 使用済challengeを別keyへreplay | 409 `challenge_consumed`、audit deny | なし |
| A04 | action hash / decision / target差替え | 409 `action_binding_mismatch`、audit deny | なし |
| A05 | presentation/display fingerprint drift | 409 `presentation_stale` | 新projection/ceremonyが必要 |
| A06 | 別origin/RP ID、UVなし、別credential、backup credential | 403 `proof_invalid` | なし |
| A07 | signature成功、binding/credential revoke | 403 `binding_revoked`、未consume request invalidation | なし |
| A08 | 2分challenge期限 / 15分request期限超過 | 410 `approval_expired`、challenge失効 / request expired | なし |
| A09 | approveとrequester cancelが競合 | 先着decision一件、後着409 `decision_conflict` | 既存core規則のみ |
| A10 | decision後5分consume期限超過 | `consume_expired`、audit | 外部callなし |
| A11 | 同時consume、同じrequest | attempt一件、loserは既存結果 | 最大一回 |
| A12 | decision response loss | UIは結果不明、元keyのreceipt GETで確認 | 0件でも再writeしない |
| A13 | 同じkey、異なるpayload | 409 `idempotency_conflict` | なし |
| A14 | BFF crash/restart | login transaction/challenge失効、durable receipt read | decision再発行なし |
| A15 | consume後external-call fenceでcrash | `executing -> acceptance_unknown` | read-only reconcile、再送なし |
| A16 | boot変更/clock巻戻り/経過証明不能 | session全失効、既存approval ADRどおりneeds_review/expire | 未開始callなし、unknown再送なし |
| A17 | DB restoreでconsume/audit anchor巻戻り | ready=false、`audit_integrity_failed` | restore承認再利用なし |
| A18 | audit append失敗 / DB unavailable | 503 `durability_unavailable` | decision/consume commitなし |
| A19 | supervisor visibility喪失 / target shared化 | `needs_review`、安全なUIを作らない | 外部callなし |
| A20 | requesterのworkspace mapping/membership喪失 | `needs_review` | 外部callなし |
| A21 | valid step-up、self-update plan/hashあり | 422 `operation_unsupported` | apply/updater呼出数0 |
| A22 | #18/#23またはbypass gate未達 | 503 `approval_safe_off` | broker実行接続なし |
| A23 | hardware登録のattestation検証不能 / local二者不足 | `credential_registration_denied` | binding/credential変更なし |
| A24 | 保存signCount=7、受信7/6/0のvalid signature | 403 `credential_counter_invalid`、credential revoke/deny audit | decision/outbox/consume追加0 |
| A25 | counter保存7→受信8の2 challengeが競合 | counter CASのwinner一件、stale loser拒否 | 同じcounterでdecision二件を作らない |
| A26 | 保存/受信counter=0、登録allowlistの非対応credential | 他proof成立時のみ許可、clone検知済みとは扱わない | challenge一回限りは保持 |
| A27 | Web event受付10秒後にIdP disable、queue起動 | internal revalidation inactiveでjob failed | worker起動/外部call0 |
| A28 | approve後・consume前にWeb requesterまたはapproverのIdP revoke | `needs_review`、decisionを実行許可として使わない | consume/外部call0 |
| A29 | consume後・外部call前にBFF/IdP unavailable、session token欠落/期限切れ | `needs_review`、stage proof発行なし | 外部call0、tokenをworkerへ渡さない |
| A30 | proofのnonce/stage/action/attempt差替え、再使用、10秒超過 | `authorization_proof_invalid` | gate進行/外部call0 |
| A31 | BFF restart後durable session再読、同じstageを再認可 | current IdP activeと同一bindingを再確認した一回限りproofだけ許可 | 旧proof/unknown attemptは再実行しない |
| A32 | draft/target/mentionにU+202E、U+2066、U+200B、U+034F、variation selector、LF/TAB | 可視escape codecで表示し、decode後UTF-8がtyped payloadとexact一致 | bidi再解釈/strip/normalizeなし、署名は元actionだけにbind |
| A33 | literalなbackslash-u列と実control文字、display codec version変更、不正UTF-8 | backslash escapeで区別。version変更はchallenge失効、不正UTF-8はpresentation拒否 | 表示とbyte列不一致でdecision/outbox追加0 |

## 下流testの判定方法

FakeClock、固定IdP response、登録済みtest公開鍵、in-memory browserではなくdurable storeを再openするfault harnessを使う。成功caseは一意receipt/owner/sequence、否定caseはsafe error/auditと外部call数0、競合caseはwinner一件、unknown caseは追加attempt/送信0をassertする。WebAuthnは実credentialをrepoへ置かずtest keyで署名し、RP/origin/UV/challenge/counterを一つずつ改変する。worker profileはnetwork、shell、ambient credential、snapshot外fileへの実際の到達を否定testし、prompt文の存在だけを隔離証拠にしない。browser E2Eではframe、CSRF、cookie flag、SSE cross-principal、再login/切断、Strict cookieのcross-site callback後遷移、artifact直接navigation、logout/principal切替/history復帰時のcache不使用、不可視文字を含む承認表示を検証する。quota testは一意Web Eventの並列submit、UTC日跨ぎ、broker timeout/restart、disk cleanup失敗を使い、受付数・予約/実消費・外部call数をassertする。snapshot testは一つだけ失効した混在grantと、queue/resume/inference/Result各stageでのrevokeを含める。

provider適合試験はaccount disableがintrospectionへ反映されることを独立確認し、署名済tokenがvalidというfixtureだけでrevocationを証明しない。live provider/production作用はこの文書PRでは実施しない。
