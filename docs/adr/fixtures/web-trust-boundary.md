# Web trust boundary decision / deployment / failure fixtures

[ADR 0002](../0002-web-trust-boundary.md)の実装・review用fixture。すべて架空値であり、実行可能な認証設定・production credentialではない。文書fixtureの存在だけではruntime test成功を意味しない。

## 固定context

`instance_a` は `tenant_a` だけを所有する。`principal_a` はrequester、`principal_b` はobserver、`principal_s` はsupervisor。`job_a` のownerはa、`job_b` のownerは別principal。observer bのgrantはjob_aだけ。supervisor sのbindingは `workspace_a/revision=3`、requester aもworkspace_aへの明示mappingとcurrent membershipを持つ。別 `instance_b/tenant_b`、別workspace、未登録principalには全てdefault deny。

## Principal・tenant・role decision table

| ID | principal / scope | target / 条件 | 期待HTTP・outcome | 外部作用 |
| --- | --- | --- | --- | --- |
| P01 | 未認証 | list/submit | 401 `session_invalid` | なし |
| P02 | a requester | own job_a read | 200、safe projection | なし |
| P03 | a requester | submit、current認可あり | 202、durable event/receipt一件 | 受付のみ。作用は別gate |
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
| P17 | a requester | approval対象writeを含むjob、bypass未遮断 | 503 `execution_safe_off` | なし |

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
| F08 | IdP timeout、既存sessionあり | 503 `identity_unavailable`、SSE閉鎖 | read/writeなし、別identityなし |
| F09 | IdP introspection inactive/subject/client不一致 | 401 `session_revoked` / `identity_invalid` | session revoke、deny |
| F10 | HTML/script/credential/private URLを含むResult | allowlist projection、literal text/redaction | script/fetchなし、raw値をlogしない |
| F11 | 別principalのreceipt key/cursorを推測 | 404 `resource_not_visible` | read/controlなし |
| F12 | 8時間/idle30分/token expiryの最小期限超過 | 401 `session_expired` | 延長なし、SSE/pollで延命しない |
| F13 | cookie valid、authz revision stale | 401 `session_revoked` | transactionのcurrent revision優先 |
| F14 | 未認証headerのactor/email | 401 `identity_invalid` | trusted actor=null、PII raw記録なし |

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

## 下流testの判定方法

FakeClock、固定IdP response、登録済みtest公開鍵、in-memory browserではなくdurable storeを再openするfault harnessを使う。成功caseは一意receipt/owner/sequence、否定caseはsafe error/auditと外部call数0、競合caseはwinner一件、unknown caseは追加attempt/送信0をassertする。WebAuthnは実credentialをrepoへ置かずtest keyで署名し、RP/origin/UV/challengeを一つずつ改変する。browser E2Eではframe、CSRF、cookie flag、SSE cross-principal、再login/切断を検証する。

provider適合試験はaccount disableがintrospectionへ反映されることを独立確認し、署名済tokenがvalidというfixtureだけでrevocationを証明しない。live provider/production作用はこの文書PRでは実施しない。
