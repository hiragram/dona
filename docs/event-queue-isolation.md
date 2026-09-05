# Source event queueの隔離と復旧

Issue #50の実装範囲はevent ingress。#48 / PR #77のraw-byte認証、strict normalizer、connection scope付きexternal ID、`created | duplicate_same | duplicate_conflict`を再利用する。`QueueAdmissionContext.connectionId`は認証済みprincipalからpersist callbackへ渡し、Envelopeへ自己申告fieldを追加しない。#49のtrigger-only routing、owner、result destinationや#46のbackground job schedulerは変更しない。

## 設定と選択保証

`DONA_QUEUE_POLICY`はstrict JSON。省略時はglobal depth 4096、bytes 64 MiB、source/connection depth 256、bytes 4 MiB、rate 100/s、burst 256。未知field、負数、予約の合計がglobal容量以上となる設定は起動時に拒否する。`sources`のpolicyはsource合計にも適用し、`connections`は認証済みconnection単位の追加制限。keyは`JSON.stringify([source, connectionId])`で、delimiter衝突を防ぐ。

```json
{
  "depth": 4096,
  "bytes": 67108864,
  "defaults": {"depth":256,"bytes":4194304,"rate":100,"burst":256,"coalescing":false},
  "sources": {"fake":{"depth":1024,"bytes":8388608,"rate":1000,"burst":1024,"coalescing":true}},
  "connections": {"[\"fake\",\"tenant-a\"]":{"depth":128,"bytes":1048576,"rate":50,"burst":128,"coalescing":true}},
  "reservations": {"slack":64,"internal":64,"update":32},
  "reservedBytes": {"slack":1048576,"internal":1048576,"update":1048576},
  "weights": {"slack":2,"internal":2,"external":1},
  "maxLanes":512,
  "maxDeliveries":256
}
```

laneは`[source, authenticated connection]`のSHA-256。Slackはworkspace、internalはworkspaceまたは固定internal identityを使用する。classはsourceから固定し、providerがpriorityを自己申告することはできない。各classのlane数上限は`maxLanes`、healthのlane labelもhashに限定する。完了したlaneのIDも保持するのでconnectionを無制限に新規作成できない。

admissionは`BEGIN IMMEDIATE`内でdedup → source/connection token bucket → lane/source/global depth・bytesと他classの未使用予約 → event/metadata/delivery commitの順に処理する。coalesced deliveryも保存量をbytesへ加算する。token clockは後退させず、補充はburstまで、1回のclock差は最大60秒に制限する。clock後退ではrate制限を緩めない。認証前には登録sourceごとの固定100 burst / 10 requests/sをメモリ上で適用し、既存size/body/processing timeoutと併用する。認証失敗はapplication queueへ保存しない。

selectorは永続stepによるweighted round robin。各class内は最後に選択されたstepが古いlaneを優先する。常にeligibleなclassは`sum(weights)`回以内、同classの常時eligible laneは最大`maxLanes * sum(weights)`回以内に選択される。これは選択回数の保証であり、単一main agentの応答時間の上限ではない。providerの継続投入でSlack/internalをstarveさせない。

同laneはsequence順。`blocked`、`needs_review`、`dead_letter`とretry待ちの先頭はそのlaneだけを止める。`dispatching` / `waiting_agent`は既存main agentのone-shot処理中なので通常worker全体で同時claimを禁止する。claim transactionでselectorを再確認するため、同じcandidateを見た複数claimが二重dispatchしない。main agent自体がblockedなら別laneへのpromptも送らず、main agentの安全条件を優先する。`dona_update`は通常selector/通常waiting処理の対象外で、予約容量と既存専用notification workerを維持する。

## #49との共有引数の統合境界

並行PR #83のhead `0e6e28d17200af9341abb9b3905fa7153eedbb6e`をread-only確認した。#49もpersist callbackの第2引数へowner、`enqueue`の第3引数へbindingを追加しており、本PRのqueue contextと同じ位置を使用する。両PRを機械的に片側優先でmergeしてはいけない。integrationでは認証直後のconnection snapshotを共通化し、owner/bindingとqueue contextを別fieldへ保持するcontextへ合成して、bindingとadmissionを同一transactionで保存する必要がある。coalescingにはowner/resource/destination/execution policyの一致も必要で、owner bindingを無視した集約を許可しない。PR #83は未mergeであり、本PRから取り込み・変更していない。統合後のcallback/codec/owner-coalesce regressionとschema検証は未実施。

## Receiptとcoalescing

provider registrationが`queueSignal(normalized, verified)`から`{resourceKey, signalKey, requiresFetch:true}`を返し、policyが許可したsignalだけを集約する。同source/connection/key、schema/type/subject/payload/reply targetのfingerprintが一致する、未試行・queuedのlane末尾だけが対象。別eventをまたいだ集約、dispatch中eventへの追記、payload差分の上書きはしない。異なるpayloadの新deliveryは通常admissionへ進み、容量不足なら明示拒否する。同じdelivery IDの不一致は従来どおり`duplicate_conflict`。

追加delivery IDとtimestamp、fingerprintはleaderへの外部キー付き`queue_deliveries`へ保存する。commit直後のcrash後も同deliveryは`duplicate_same`へ収束する。従来のpersist outcomeを保持し、receiptの`admission: coalesced`と`ackAllowed`で意味を補足する。receiptのexternal IDは受信delivery自身、event ID/sequenceはleader。`committedAt`は当該deliveryの保存時刻。ACK formatterはcommit成功後だけ呼ぶ。

fetch必要性は集約可否と別columnへ保存し、coalescing無効でも保持する。`queueDispatchMetadata(eventId)`は`requires_fetch`、delivery数、追加delivery一覧を返す。通常workerはfetchが必要なsignalのpromptへこの情報を加える。最初のdeliveryは元event rowに保持する。#49等の別routingでもこのmetadataを引き継ぎ、signal受領/集約をfetch完了とみなさない。

| code | ACK | 意味 |
|---|---|---|
| `created` / `duplicate_same` / `coalesced` | 可 | durable commitまたは保存済み一致を確認 |
| `duplicate_conflict` | 不可、409 | 同identityの内容が不一致 |
| `queue_depth` / `queue_bytes` | 不可、429 | lane/source/global容量または予約境界 |
| `queue_rate` | 不可、429 | 認証前sourceまたは認証後source/connection rate制限 |
| `queue_lanes` / `queue_deliveries` | 不可、429 | cardinality上限 |
| `queue_quiescing` | 不可 | 新規admission/claim停止 |
| `queue_identity` | 不可、400 | 認証済みconnection/keyの契約不成立 |

internal update通知の一時的なqueue拒否は503を返し、updaterの既存照合・retry経路へ送る。429を恒久拒否とするupdater契約へ流さない。

HTTP前段のshutdown判定は既存`shutting_down` / 503も保持する。DB busy等の保存失敗も既存persistence failureのnon-ACKを維持する。拒否を成功ACKやsilent dropに変換しない。provider固有retry方針はprovider側のcontractで判断する。応答喪失時は自動再送せず、`getByExternalId`とreceiptを照合する。

## 観測・dead-letter・drain

`GET /v1/queue`または`dona-dispatcher queue status`でclass/status別depth・bytes・lag、hash lane別depth/blocked/dead-letter/deferred、固定code別admission counterを確認する。認証前rate制限はメモリ上で拒否するためdurable counterには含めない。`dona-dispatcher queue deliveries <event_id>`で集約identityとfetch必要性を照合する。

既存`event list --status dead_letter` / `event show` / `event retry` / `event complete` / `event dead-letter`を使う。dead-letterも容量を占有しlaneを止める。operatorが処理結果を照合し、再試行またはcompleteで明示的に解決する。blocked/needs_reviewのretryには既存の`--force`確認が必要で、crashによるacceptance unknownを自動retryしない。再試行待ちのavailable_atは既存UTC契約を維持する。時計後退時は予定時刻まで遅延し得るが先行dispatchしない。

quiesce/shutdownは同期的にclaim gateを閉じ、await中のpreflightから戻ったworkerもclaimしない。`drain-status.queue`はin-flight、queued、blockedを別々に返す。既存self-updateの`drained`は実行中の安全性を表し、queuedがゼロであることの主張ではない。

## Migrationとrollback境界

このfeature baseはapp schema 2。event rowのsequence/status/resultを変更せずqueue tables/indexをbackfillし、全DDL/backfillと`user_version=4`を同一transactionでcommitする。旧provider rowのconnectionは復元不能なのでsource別の固定`legacy:` prefix付きlaneへ隔離する。通常laneはhex hashのみなので実在connection名と衝突しない。既存Slack/internalはworkspaceからbackfillする。既存の超過backlogは消さず、そのusageを数えて新規admissionを止める。

schema 3は別系統の#46 jobs migrationなので本実装では受理しない。#46との最終integration時には両migrationとjobs codecを統合した検証が必要であり、このPRはjobs schema 3互換を主張しない。

旧版はschema 4を拒否する。`config/release-compatibility.json`とversion healthはwrite/read 4、rollback不可を明示し、schema 2の既存self-update policyを黙って適合扱いしない。`scripts/write-release-manifest.mjs`も`non_rollback_migration_requires_release_workflow`で生成を拒否する。明示的なmigration計画・承認・復元経路を後続integrationで実装して検証するまで、このfeatureをrelease対象にしない。production deployやpolicy変更は本作業に含めない。rollbackには停止した隔離環境で取得した移行前DBの復元を含む別の移行判断が必要。migration後DBのversionだけ下げて旧版へ戻してはいけない。

## 検証と未検証のlive smoke

`npm --prefix dispatcher test`の`queue.test.ts`は400 provider + 20 Slack、有限step/FIFO/別lane進行、source/connection/global quota、reserved admission、coalescing/replay/mismatch、clock後退、DDL rollback、index/integrity/foreign key、6 producer process、競合claim、DB busy、coalesce commit直後SIGKILLを検証する。worker testはpreflight待ち中のquiesce race、ingress testは署名済みfake requestからreceipt/ACK/non-ACKまでを検証する。全processは一時DBを使用し、Herdr/Slack/production processは操作しない。

実Slack test eventを伴うlive smokeは未実施。実施には利用者が用意・許可した隔離Dispatcher DB/socket、fake provider registration、専用Slack app/workspace/test threadとそのSocket Mode接続、互換性を確認した検証用workerが必要。

1. 隔離DBのqueue statusを保存し、fake provider burstをsource quota境界まで送る。
2. 実Slack test threadからtest eventを1件送り、source側ACKとDispatcherのevent ID/sequenceを照合する。
3. `/v1/queue`のdepth/lag、selectorの処理順、Slackが有限step内に選ばれたこと、provider lane FIFOを記録する。
4. 一つのprovider laneをretry/blockedにして他lane進行を確認し、quiesce前後のin-flight/queued/blockedとclaim停止を記録する。
5. 結果をexact head/base、receipt、時刻、隔離環境条件とともにIssueへ記録する。fake試験を実Slack成功やprovider実配送E2Eの代替としない。
