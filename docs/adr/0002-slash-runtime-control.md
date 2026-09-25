# ADR 0002: Slack slash commandのruntime control contract

- 状態: 採用（設計のみ。機能は既定off）
- 対象: Issue #260 / Epic #259
- 決定日: 2026-09-25

## 決定と責務

`/dona`は認証済みSlack ingressからstable control planeへ渡す限定的な操作面とする。Slack Adapterは3秒以内に受信をACKし、構文検査と受付結果だけを返す。ACKは操作の受理・承認・成功を意味しない。Dispatcher/Updaterが永続operation、approval、quiesce、実行、照合、通知を所有する。LLM、Slack Adapter、通常のMCP、shellはprocessを直接操作しない。Socket Modeの既存message event経路へslash payloadを混入させない。

### Closed grammar v1

受信したraw UTF-8 bytesを厳密にdecodeし、正規化を行う前にASCII byte以外をすべて拒否する。最大256 byte、ASCII space 1個で区切った次の完全一致だけを受理する。NFKC等による互換文字のASCII変換は行わない。前後空白、連続空白、改行、引用、escape、Unicode類似字、追加引数、未知versionは拒否する。Slackへ登録するcommand名は`/dona`のみで、versionはserver側のcontract `runtime-control.v1`へ固定する。将来versionは明示的な別schemaとrolloutを要する。

| 入力 | typed operation | 効果 |
|---|---|---|
| `status` | `runtime.status.read.v1` | boundedな稼働・pending状態の参照 |
| `restart plan` | `runtime.restart.plan.v1` | 現稼働instanceのimmutable planを作る |
| `restart confirm <opaque-plan-id>` | `runtime.restart.confirm.v1` | 保存済みplanの承認要求を開始する |
| `update plan` | `runtime.update.plan.v1` | fixed mainのexact SHAとplan hashを提示する |
| `update confirm <opaque-plan-id>` | `runtime.update.confirm.v1` | 保存済みupdate planの承認要求を開始する |
| `operation <opaque-operation-id>` | `runtime.operation.read.v1` | 受付者のoperation状態を参照する |
| `cancel <opaque-operation-id>` | `runtime.operation.cancel.v1` | 外部mutation前の取消を要求する |

slashに表示するopaque IDはserver生成の`rc_`と32文字のbase64url tokenであり、syntaxは`rc_[A-Za-z0-9_-]{32}`に限定する。stable control planeはこのIDとoperation kind、principal、tenant、既存Updaterの`plan_<26文字ULID>` / `upd_<26文字ULID>`を永続的に一対一対応付ける。内部IDをslash parserへ直接渡さず、`update confirm`、`operation`、`cancel`は保存済み対応から解決する。対応が失われた場合は拒否し、推測で再生成しない。ID自体は権限を与えない。任意shell、Git ref、path、URL、environment、process引数、MCP tool名、JSON body、自由文は全operationで受け取らない。`confirm`は実行命令ではなくapproval要求である。

## Identity、authorization、表示

| asset / actor | trust boundaryとproof | 決定 |
|---|---|---|
| Slack request / Slack platform | Socket Mode envelopeまたは署名済みHTTP requestをtransportが検証。HTTPではraw bodyの署名・時刻を検証し、Socket Modeでは認証済み接続とenvelope IDを使用 | raw text、trigger ID、Slack表示名は命令・認可にしない |
| tenant / workspace | app ID、team ID、enterprise ID（該当時）、configured workspace aliasをserver側で完全一致 | Slack Connectやcross-workspaceを推測で統合しない |
| human principal | verified requestのactor ID、非bot性、現在のworkspace membership、管理者policy/owner bindingをserver側で照合 | user ID単体、channel、DM参加、approval code単体をcapabilityにしない |
| destination | requestのchannel IDとchannel typeを保存し、private channel/DMの現在accessを通知直前に再検証 | plan・承認詳細は既定で本人DMのephemeral表示。DM不可なら安全な最小ephemeral案内だけ。channel/threadへ秘密を出さない |
| control plane | versioned internal UDS protocol、service identity、fenced DB record | AdapterとLLMから任意operation payloadを受けない |
| approval authority | #26のtransport-neutral request、snapshot/hash、decision、one-shot consume、auditを再利用 | Codex host approval、Slack button値、code表示を人間の明示承認の代替にしない |

`status`と`operation`は本人または明示されたoperator roleだけが読める。読み取り時もverified principalとtenantを照合し、secret、private path、Result全文、token、他者のoperation詳細を投影しない。`plan`、`confirm`、`cancel`は別のoperator policyを要求し、confirm/consume/実行直前に現在のmembership、role、binding、target instance、policy revisionを再検証する。不明・失効・変更ならfail closedとし、新planと承認を要求する。承認者と申請者の分離をpolicyが要求する環境では同一人物のdecisionを拒否する。

## Immutable planと状態

serverだけが`{schema_version, operation_kind, instance_id, workspace_id, requester_principal, target_release_sha_or_current_generation, expected_generation, policy_revision, request_identity, reply_target, expires_at}`をmaterializeし、canonical bytesのSHA-256を保存する。restartはcurrent generationとexact process/service identity、updateは既存`plan_self_update`が選ぶfixed main exact SHA、CI、compatibility、rollback可否、plan hashを含む。表示するplan IDと短い要約からtargetを再生成しない。confirmはplan IDから保存済みsnapshotを取得し、hash、version、principal、instance、workspace、期限、revisionを照合する。v1のplan TTLは作成から最長10分、approval decision receipt TTLは発行から最長5分とし、server側policy revisionに値を固定する。保護されたcontrol-plane clockで`now >= expires_at`なら失効とし、Adapterの時計で判定しない。承認receiptはこのhashとoperation IDへ束縛し、one-shot consume、replay拒否を適用する。取消、失効、rotation、role変更は未消費planを無効化し、消費後の外部効果を巻き戻したことにはしない。

状態は`planned → awaiting_approval → approved → accepted → quiescing → activating → healthy → notified`。`rejected`、`cancelled`、`expired`、`failed`、`known_rejected`、`needs_review`、`rolled_back`も永続terminal/attention状態として区別する。Updaterのplanning/preparing/staged/quiescingで既知の失敗は`failed`へ写像し、terminal通知へ進めてactive leaseを解放する。外部writeの受理が不明なら`failed`へ落とさず`needs_review`を保持する。`approved`は実行権ではなく、consumeと再検証に成功して初めて`accepted`となる。`accepted`はactivation成功ではない。健康確認と通知receiptを分離し、read statusはdurable stateから得る。operation ID、request identity、delivery IDにunique制約を設け、duplicate delivery/confirmは同じrecordを返す。競合するrestart/updateはinstance単位の単一active leaseとgeneration CASで拒否し、別operationへ暗黙に乗り換えない。

ACK前に受付を永続化できない場合は一時失敗を返し、成功ACKを偽らない。3秒内に結果が未確定なら「受付照合中」とopaque request IDだけを返す。ACK後の実行はdurable queue/outboxから再開する。slash confirmには通常messageとは別のstrict `source: slack_runtime_control` eventを永続化し、server由来のverified principal、固定reply target、operation ID、plan hashだけを保持する。既存`source: slack`専用self-update APIを直接呼ばず、専用typed bridgeで同等のevent terminal barrierとUpdaterの`approval_event_id`を結ぶ。承認受付eventのResult Envelopeをatomic公開・再読してterminal化するまでUpdaterはactivationをclaimしない。barrierの照合が不明なら`needs_review`とし、approvalを再消費しない。受付応答喪失時は同じrequest identityの永続recordをread-only照合し、不明なら再実行せず`needs_review`へ送る。通知は保存済み本人destinationへboundedな定型文で行い、post応答喪失時は保存済みnotification IDとSlack上のexact receiptを照合する。照合不能なら再投稿しない。

## Quiesceとrecovery

restart/updateはstable updaterだけが実行する。Adapterの新規ingressを止めてACK/Dispatcher commitをdrainし、Dispatcherは既存job、prompt/steer/cancel、notification outbox、Agent Session、現在EventのResult公開をbarrierまで確認する。ack済みslash requestのdurable stateを先に保存し、quiesce中の新要求は明確に拒否する。in-flightのacceptance unknown、未公開Result、未確定notificationを黙って破棄しない。self-updateは既存のterminal barrier、stable pointer、rollback、typed通知を再利用する。restart controllerは同じfence/receipt/health規則を使い、restart固有のexact instance identityとgenerationを追加する。

stop/start応答喪失、process crash、identity drift、health failureでは同じ外部writeをblind retryしない。保存済みintentとprocess identity、pointer/generation、version/health、receiptをread-onlyで照合する。exact targetまたはexact rollbackを証明できた場合だけterminalに進み、それ以外は`needs_review`、safe-off、operator reconcileとする。rollbackしても既に送った通知や外部効果を消さない。manual reconcileには独立したoperator権限、観測根拠、reason、監査recordを要する。

## Threat matrixと検証fixture

| fixture / 脅威 | 入力例・条件 | 期待結果 |
|---|---|---|
| valid command | `status`、`restart plan`、`update plan` | typed unionだけを生成し、statusはbounded projection |
| invalid / injection | `restart now`、`update plan main;...`、改行・引用 | parse拒否。shell等へ転送しない |
| unknown version / extra argument | 未知schema、`status x` | side effectなしで拒否 |
| wrong actor/team/workspace/channel | 保存済みplanと別principal/tenant/宛先 | read/confirm/通知を拒否。cross-workspace漏出なし |
| replay / CSRF相当 | duplicate envelope、偽button、異なるmessage座標 | request identityとsigned proof、保存済み座標を照合し、効果は最大1回 |
| duplicate confirm / expiry | 同じplan二回、TTL境界後 | approval consumeは一回。失効後は新plan必須 |
| concurrent restart/update | 同じinstanceで両方planをconfirm | lease/generation CASで片方だけaccepted |
| ACK後crash / response loss | ACK直後のprocess停止、post/stop応答喪失 | durable stateを再読。受理不明writeを再送しない |
| identity drift | actor role、workspace binding、instance generation変化 | consume/実行を止め、旧approvalを再利用しない |
| health failure / rollback | target起動後ready不成立 | exact rollback確認または`needs_review`。通知は実証済み状態だけ |

## 実装境界とrelease gate

#26は共通approval primitive、decision proof、consume/auditを所有する。#231はexact SHA self-update、stable updater、activation/rollback、terminal通知を所有する。Epic #259はslash ingress、closed parser、runtime restart plan/controller、typed接続とE2E gateを所有する。feature branchのapproval成果をcurrent mainへ統合済みと仮定しない。

機能は既定off。まずfake transportと全fixture、crash/restart、duplicate、timing、permission driftを決定的に検証する。次にisolated instanceだけで3秒ACK、quiesce、healthy/rollback、通知照合をlive smokeする。Slack App manifestのcommand登録、必要最小scope、workspace再install、運用/incident/retention runbook、auditとredactionを確認する。production enablement、App設定変更、restart/updateはそれぞれ別の明示承認を要し、段階的にtenant allowlistで有効化する。break-glassではfeature flagをoffにし、未解決operationを保存したままoperatorがreconcileする。監査metadataは最小化し、未解決fence/receiptは解決まで保持する。terminal後は本文・destinationを30日以内に消去し、request/delivery identityのhash、operation kind、最終decisionだけのtombstoneを90日保持する。Slack retryの最大許容期間を90日以内に制限し、期間外の署名済みdeliveryも時刻で拒否する。未解決fenceは解決まで消去せず、tombstone purge後の古いdeliveryが再実行にならないよう保護されたclockとdelivery時刻を照合する。
