# External event ingress contract

外部providerの受信処理は、provider固有のHTTP署名やpayloadをDispatcherの通常event APIへ直接混在させず、次の境界で登録します。

```text
raw request bytes + raw headers + raw request target + receivedAt
  -> authenticate
  -> verified connection/principal
  -> provider strict normalize
  -> EventEnvelope v1
  -> SQLite transaction + PersistReceipt
  -> provider acknowledgement
```

実装は[`dispatcher/src/ingress.ts`](../dispatcher/src/ingress.ts)の`ExternalEventSourceRegistration`、`ExternalIngressRegistry`、`ExternalIngressProcessor`にあります。DispatcherのUDS routeは`POST /v1/ingress/:source`です。実providerの公開HTTPS listener、secret取得、subscriptionは各provider adapterが所有し、同じcontractを利用します。

## 登録contract

登録ごとに次を指定します。

- `source`: `^[a-z][a-z0-9._-]{0,63}$`。`slack`、`dona_job`、`dona_update`は予約済みで、外部登録できません。
- `maxBodyBytes`、`bodyTimeoutMs`、`processingTimeoutMs`: raw bodyと認証・正規化の有限な上限です。認証と正規化は単一のprocessing deadlineを共有し、body timeout、size超過、またはbody受信前のroute / source拒否時はHTTP connectionを閉じます。globalの`DONA_REQUEST_MAX_BYTES`も同時に適用されます。
- `authenticate`: JSON parseより先に、受信したものと同じ`Buffer`、raw header列、queryを含むraw `requestTarget`で署名等を検証します。payload自己申告ではなく、永続設定から選んだstable `connectionId`と認証済みprincipalだけを返します。
- `normalize` / `parseNormalized`: 認証後だけ実行します。provider固有schemaはtop-level、`subject`、`payload`、`replyTarget`をstrictにし、unknown fieldや別provider fieldを拒否します。永続化前に値ツリー全体を検査し、BigInt、循環参照、undefined、非有限numberなどJSONへ正確に表現できない値を拒否します。
- `buildAcknowledgement`: `PersistReceipt`を受けるpure formatterです。SQLite transactionが返る前には呼ばれません。JSON bodyを送れる2xxだけを許可し、204 / 205、Node HTTPが拒否するheader、serialize不能なbodyはcontract errorになります。検証時に生成したbody bytesをそのまま送信します。

raw body、signature header、credential、raw principalはEvent Envelope、Result、通常logへ自動転記されません。normalizerもsecret、private callback URL、raw payloadを出力してはいけません。

## identity・dedup・ACK gate

providerのevent IDは、認証済み`connectionId`と`source`を含むSHA-256 identityへ変換してから既存の`UNIQUE (source, external_event_id)`へ投入します。このため、同じprovider IDでも別connectionは衝突せず、connection名やprovider ID自体もDBへ露出しません。

永続化結果は次の3種類です。

| outcome | HTTP / ACK | 意味 |
| --- | --- | --- |
| `created` | provider formatterの2xx（通常202） | 新しいrowのcommitとread-backが完了 |
| `duplicate_same` | provider formatterの2xx（通常200） | 同じcanonical envelopeが既存rowへ収束 |
| `duplicate_conflict` | 409、provider ACK formatterは呼ばない | 同一identityの内容が異なるため既存rowを維持して停止 |

認証、validation、body受信、SQLite commitが失敗した場合もprovider ACK formatterは呼びません。commit後にACK生成やresponse deliveryが失敗した場合、再送は`duplicate_same`として同じ`event_id`へ収束します。acceptance unknown時は同一event IDでread-only照合し、別IDによるblind retryをしません。

Slack payloadのtimestampが不正でreceive timeへfallbackした場合は、その由来を`trace.occurred_at_source`へ記録します。同じSlack event IDの再送で両方がfallbackの場合だけ、変化するreceive timeをcanonical比較から除外し、最初に永続化した時刻を保持します。

## compatibility matrix

Event Envelopeは`schema_version: 1`、Dispatcher SQLiteは`PRAGMA user_version = 2`を維持します。`events.source`は既に`TEXT`で、`reply_target_json`はnullable、dedup indexも既存のため、この共通contractにDB migrationは不要です。

| producer / row | write route | read compatibility |
| --- | --- | --- |
| Slack Socket Mode | `POST /v1/events` | 維持 |
| `dona_job` | Dispatcher内部enqueue | 維持 |
| `dona_update` | token認証済み`POST /v1/internal/update-events`のみ | 維持。外部routeから登録不可 |
| registered external source | `POST /v1/ingress/:source` | source identifierを検証して通常queueから読める |

multi-jobの`job_key`、quota/fair scheduling、job group seal・Agent Session集約はこのcontractの責務外です。job schema migrationやjob lifecycleを外部source追加の条件にしません。

## provider追加手順

1. provider adapter側でpublic HTTPS、secret/connection設定、resource allowlistを用意する。
2. raw bytesを再serializeせず検証する`authenticate`を実装する。
3. provider eventごとのstrict schemaとnormalizerを実装し、`replyTarget: null`をtrigger-onlyの正規形として扱う。
4. `ExternalIngressRegistry`へ一意なsourceを登録する。
5. signed golden fixture、unknown/extra field、invalid UTF-8/JSON、oversize/timeout、同時duplicate/conflict、DB/ACK faultをtestする。
6. 隔離した公開HTTPS endpointでsigned delivery、persist receipt、ACK、redelivery dedup、redacted logを照合する。

このリポジトリ内のfake provider integration testは手順5までを検証します。手順6と各provider本番pilotは、provider実装と認証情報を伴うため別途実施します。
