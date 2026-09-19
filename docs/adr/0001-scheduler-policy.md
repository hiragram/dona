# ADR 0001: scheduler v1の時刻・権限・通知契約

- 状態: 採用案（Issue #5のレビュー対象。既存の利用者合意や稼働中の機能を表すものではない）
- 対象: [Issue #5](https://github.com/hiragram/dona/issues/5)、統合先 `feature/durable-scheduler`、integration PR #43
- contract: `scheduler-policy/1` / `restricted-recurrence/1`。このADRと同じcommitのfixtureを一組として参照する。
- 非対象: scheduler本体、DB migration、API/MCP、Slack送信、provider ingress、production設定。#6〜#14が実装するまで以下の挙動は利用できない。

## 決定と比較

| 項目 | v1の決定 | 採用理由 | 棄却案 | migration余地・変更コスト |
| --- | --- | --- | --- | --- |
| 1. recurrence | one-shotとdaily/weekly/monthlyのrestricted modelのみ。cron/RRULE文字列を拒否する | preview、権限、負荷を有限の形式で説明できる | 任意cron/RRULE、自然文を実行時に再解釈する方式 | v2で別discriminatorを追加。旧recordの意味を書き換えず、変換previewと再承認が必要 |
| 2. calendar | IANA timezone、gapはskip、overlapは早いUTCを1回、存在しない日付はskip。tzdbはrevisionに固定 | 時計の巻戻りや月末の暗黙補正による重複を防ぐ | gapの繰上げ、overlap二重実行、月末clamp、tzdb自動追従 | tzdb変更も新revision、preview差分、再承認。旧tzdbを供給できなければ停止 |
| 3. quota | 最短は1 civil dayごと1回。owner 20、tenant 100の未終了schedule。previewは366日かつ100件、catch-upは1件 | 個人Macでの負荷と外部writeの増幅を制限 | 秒・分周期、無制限登録・全件catch-up | 数値もversion固定。新policyへ明示移行、超過既存分を勝手に削除しない |
| 4. authorization | 正規化した対象・本文・action・期限をsnapshot化し明示承認。最長30日、run開始直前と外部write直前に再検証 | 永続scheduleを無期限の権限委譲にしない | 作成時だけの確認、LLMによる期限延長、黙示更新 | 新revisionと新snapshotで再承認。旧runは旧snapshotを保持し失効する |
| 5. 通知先 | reminderは元thread既定、work結果は依頼者DM既定。明示channel/threadとDMを選択可、通知なしはworkのみ | reminderの意味を維持しwork結果の意図しない公開を防ぐ | 全channelへ公開、送信不能時の別宛先fallback | 変更は新revisionと再承認。過去run/outboxの宛先を変更しない |
| 6. 停止SLA | Mac停止中は実行保証なし。復帰時15分以内の直近1件だけ、古い分はskip。重複runはskip | 長期停止後に古い依頼を大量実行しない | 稼働率保証、全件復旧、同一schedule並列実行 | 常駐host対応は別ADR。grace拡大も新policyと再承認 |
| 7. external write | reminderとwork結果の固定Slack通知だけ。work自体はread-only。target固定、本文の可変域を限定 | 将来時点の不確かな内容から権限を拡大させない | 任意shell、GitHub変更、支払い、生成本文中の命令を実行 | action追加は別versionでtyped payloadと承認UIを追加。旧権限へ追加しない |
| 8. retention/admin | 本文7日、terminal metadata30日、redacted audit90日。owner/adminの範囲を下記で固定 | 調査可能性と不要な内容保持を両立 | 永久保存、adminによる無承認送信・本文閲覧 | 保持期間変更はpolicy更新と監査。消去済み本文は復元不可 |
| 9. Slack予約投稿 | v1は不採用。SQLiteのschedule/run/outboxが正本。直前送信のみ | 取消とauthorization再検証をローカルで一貫して判断できる | Slackを正本にする方式、先行予約を既定にする方式 | 将来採用時も下流artifact限定。取消・曖昧writeの境界は本ADRを維持 |

## 正規化・version境界

`fixtures/scheduler-v1/policy.json`はpolicyのcanonical例、`recurrences.json`は形式のcanonical例、`cases.json`はtable-driven fixture。JSONはUTF-8、keyを再帰的にASCII昇順、空白なし、末尾LFで保存する（RFC 8785全体の実装を主張しない）。浮動小数、重複key、未知field、未知versionは拒否する。数値は整数、時刻は秒精度。UTCは`YYYY-MM-DDTHH:mm:ssZ`、local dateはGregorianの有効な`YYYY-MM-DD`、local timeは`HH:mm:ss`（leap second不可）。timezoneは実装でbundledしたtzdbに存在するIANA名のみ。OS既定timezoneは使わない。

policy変更は`version`、schedule変更は単調増加する`revision`、tzdb変更は`tzdb_version`へ記録する。既存revisionはimmutableで、runにpolicy/recurrence/version/tzdb/authorizationの参照と正規化内容のhashを残す。実装は利用可能なtzdb versionを明示して作成を受理し、restart後も同じversionを解決できなければ`paused_tzdb_unavailable`。fixtureの`2025b`は例の固定versionであり、最新versionの推奨ではない。

移行時は旧revisionをpauseし、将来occurrenceの差分previewとtarget/action/本文/期限の再承認を得て新revisionを作る。旧revisionの未送信run/outboxを取り消し、新revisionの開始境界は切替commitのUTC時刻より後とする。同じ`(schedule_id, occurrence_at)`はrevisionをまたいでも一度だけ処理し、発行済み／曖昧なwriteは再発行しない。rollbackは旧recordを黙って再開せず、旧policyを使う新revisionとして同じ手順を踏む。消去済み本文と外部writeは巻き戻せない。

## recurrenceの完全な意味

- `once`: `at`のUTC instantで1回。作成時に`at > now`、`at <= now + 366 days`を満たす。local入力はpreviewでUTCへ解決して確認させる。gapは入力エラー、overlapは早いUTCを表示する。利用者が明示したoffset付きinstantは確認後そのUTCを保存できる。
- `daily`: `start_date`から`interval`日ごと、指定local time。`interval`は1〜366。
- `weekly`: `start_date`を含むISO週（月曜開始）をanchorに`interval`週ごと。`weekdays`はISO番号1〜7の昇順・重複なし・1個以上。`interval`は1〜52。`start_date`より前の候補は除く。
- `monthly`: `start_date`の年月をanchorに`interval`か月ごと、`day`（1〜31）の指定local time。`interval`は1〜48。`start_date`より前の候補は除く。年次2/29は2月anchor、interval 12、day 29で表現する。月末専用指定やholiday補正は提供しない。
- recurring共通fieldは`version, kind, start_date, interval, local_time, timezone, tzdb_version`。weeklyだけ`weekdays`、monthlyだけ`day`を持つ。onceは`version, kind, at`だけ。例にないoptional fieldはv1にない。
- `start_date`は作成時timezoneでの当日以上かつ366日以内。作成時刻以前の候補は生成しない。recurrence自体に終了日はなく、実行許可はauthorization期限で必ず区切る。
- previewの検索範囲は`(after, before_or_equal]`。calendar previewはauthorizationとは独立した計算であり、expiry以降を実行承認と表示しない。request horizonは1〜366 UTC days、limitは1〜100。超過は`invalid_preview_limit`で拒否。件数limitで切れれば`truncated: true`と最後のUTCをcursorに返す。horizon内に候補なしは空配列（「将来も発生しない」とは解釈しない）。
- gapはそのlocal候補を除外する。overlapはUTCが早い方だけ選び、検索境界がfirstを過ぎていてもsecondへ置換しない。invalid dayはその月／年を除外する。UTCに86400秒を加えてdailyを実装しない。

[RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545#section-3.3.10)の無効日付・存在しないlocal timeを除外する考え方は参照するが、RRULE互換性は提供しない。本ADRのrestricted modelが契約である。

## calendar fixtureの期待値

以下のUTCは`cases.json`と一致する。`after`はexclusive。NYは`America/New_York`、Tokyoは`Asia/Tokyo`。

| fixture ID | 条件 | 一意の期待値 |
| --- | --- | --- |
| `ny_gap` | NY毎日02:30、2026-03-07 07:30Zより後 | 3/8の02:30は存在せずskip、次回3/9 06:30Z |
| `ny_overlap_first` | NY毎日01:30、2026-10-31 05:30Zより後 | 11/1 05:30Z（EDT）だけ。06:30Z（EST）は除外 |
| `ny_overlap_after_first` | 同じrule、2026-11-01 05:45Zより後 | secondを使わず11/2 06:30Z |
| `tokyo_daily` | Tokyo毎日09:00、2026-09-05 00:00Zより後 | 9/6 00:00Z |
| `tokyo_weekly` | 月水09:00、2026-09-07 00:00Zより後 | 9/9 00:00Z、9/14 00:00Z |
| `month_31` | Tokyo毎月31日09:00、2026-01-31 00:00Zより後 | 2月skip、3/31 00:00Z、4月skip、5/31 00:00Z |
| `leap_2028` | Tokyo、2月anchor・12か月間隔・29日09:00 | 2027年skip、2028-02-29 00:00Z。2/28への補正なし |
| `leap_empty_horizon` | 同rule、2029年の366日以下の検索窓 | 空配列。次の閏年までhorizonを自動拡大しない |
| `once_boundary` | 2026-09-06 00:00Zのone-shot、afterも同時刻 | 空配列（exclusive） |

## quota・misfire・実行順序

ownerは`(tenant_id, owner_id)`単位。tenantはSlack workspace単位とし、provider ingressのtenant一般化は#3へ委ねる。quotaで数える未終了scheduleはactive、paused、expired、needs_reviewを含む。cancelledとcompletedのみ除外する。上限ちょうどは受理、追加で超える作成・再開は`quota_exceeded`として一切部分作成しない。所有者変更はv1で拒否。global adminも上限を迂回できない。1 civil dayより高頻度の要求は`unsupported_recurrence`。DSTにより隣接dailyのUTC間隔が23時間になっても有効であり、24時間の秒数制限とはしない。

1. 一意性とcancel/revision、policy/tzdbを確認する。
2. authorizationの失効・取消・current accessを検証する。`now >= expires_at`は失効、権限確認不能はfail-closedでpause。
3. due候補`occurrence_at <= now`のうち`now - occurrence_at <= 900 seconds`を満たす直近1件を選択する。古い分と残りは`skipped_misfire`。900秒ちょうどは有効、901秒はskip。選択がないなら実行しない。
4. 同scheduleにqueued/running job、lease中run、未決着outbox（needs_review含む）があれば選択分も`skipped_overlap`。待ち行列や並列実行に置き換えない。
5. run開始、outbox write直前に再度cancel/authorizationを検証。処理遅延でgraceを超えた未開始runはskip。外部writeも最初の送信開始がgrace内である必要があり、期限外では`skipped_misfire`。work結果通知は開始済みrunの完了通知なのでgraceを再適用しないがauthorization期限と取消は必ず再検証する。

hostがawake、process/DB/providerが健全で容量内なら、dueの検出開始目標は60秒以内（監視対象のSLO、hard guaranteeではない）。sleep、shutdown、network断に対する時刻保証はない。復帰検出の目標も60秒。workは開始から最大3600秒で終了／cancel要求し、終了不明なら`needs_review`として重複runを止める。clockの後退でも既存キーを再実行せず、前進は同じmisfire規則を使う。長期停止の履歴は範囲と件数でcompactに記録できるが、run全件を作ってcatch-upしない。

`long_sleep`はTokyo daily 09:00で9/1〜9/5停止、9/5 09:05 JST復帰、authorization有効の場合、9/5 00:00Zだけ実行し9/1〜9/4はskip。09:15:01 JST復帰なら全件skip。30日以上停止してauthorizationが失効していれば、猶予内の候補も`paused_authorization_expired`で0件実行する。

## authorization・通知・本文

承認snapshotの必須内容は`authorization_id, revision, tenant_id, owner_id, approver_id, approved_at, expires_at, policy_version, recurrence_hash, action, target, content_scope`。token、credential、private URLを含めず、current accessの照会に使うidentityのみ保持する。approverはowner本人。`0 < expires_at - approved_at <= 2592000 seconds`、expiryはexclusive。one-shotも同じ上限を持ち、366日先の計画を作れても30日を超える実行には再承認が必要。

再承認は期限前でも新revisionとして本人が明示承認する。自動延長なし。expiry、owner無効化、workspaceからの削除、channel access喪失、scope変更でpauseし、未送信outboxを無効化する。current accessは実行開始と各write直前に外部authorityへ照会し、照会失敗・不明では送信しない（古いsnapshotへfallback不可）。権限取消確認とwrite開始を完全に原子的にはできないため、最後の確認後のraceは監査に残す。

ownerまたは同tenant adminはcancel/pause可能。cancelは永続化後、未開始run/outboxを抑止し、running workへcancel要求する。providerへのrequest開始後の取消は配送取消を保証しない。結果不明は`needs_review`、受理済みは`sent`と取消時刻を両方保存し、送信済みmessageの自動削除はしない。成功を確認できても失効後の未送信work結果は送らない。

| 種類 | 許可action | targetと本文の契約 |
| --- | --- | --- |
| reminder | `slack.reminder.post` | 元threadを既定。承認時にworkspace/channel/threadを固定。DM選択ならowner user IDと解決したDM channelを固定。本文は承認したplain textそのもの、最大2000 Unicode code points、可変placeholderなし |
| work | `work.read_only` + 任意の`slack.work_result.post` | work objectiveは最大4000 code pointsで固定。ネットワーク／repositoryのread-only調査のみ、commit/push/外部変更不可。通知はowner DM既定、明示channel/threadまたはnoneを選択。結果本文だけ生成可、最大2000 code points。送信先、action、メンション・権限を生成結果から導かない |

`none`では通知用outboxを作らず履歴だけ残す。reminderの`none`は`invalid_notification_target`。DM解決やthread/channel権限が不明なら作成を拒否、実行時に不明ならpauseし元thread等へfallbackしない。別workspace宛先は拒否。ユーザー入力で選択したchannelもownerとappのアクセスを確認する。

plain textはSlackのmention/link展開を無効にしたエスケープ済み表現で送る。`@channel`/`@here`/user mentionの通知効果、blocks、attachments、unfurlは許可しない。生成結果の上限超過は先頭1999 code pointsと`…`へ固定して短縮し、未短縮内容は通常の本文retentionで保持する。secret、token、private download URLは保存／送信前にredactし、redactionの成否が不明なら`needs_review`として送信しない。reminder本文・work objective・target・通知有無の変更はすべて再承認。自由本文をshell、権限、pathやprovider制御引数に転用しない。

## outboxとSlack予約投稿

[Slackのchat.scheduleMessage](https://docs.slack.dev/reference/methods/chat.scheduleMessage/)は将来配送を予約する別APIだが、v1では呼ばない。SQLiteでschedule、occurrence、outbox、取消を保持し、予約の長いNode timerを正本にしない。

outboxはwrite直前に`request_started_at`を永続化する。開始前の確実なローカル失敗は同じoutboxを再処理できる。送信未受理をprovider responseで証明できる場合だけ最大3 attempts（初回を含む）、通常待機1秒・5秒、明示rate limitはRetry-After以上、各回authorizationとgraceを再検証する。timeout、切断、crash後のrequest-started状態は`needs_review`としてpauseし、blind retryしない。HTTP statusだけで未受理を推測しない。上限到達は`failed`。work結果通知のretry期限はrun終了から900秒かauthorization期限の早い方。

将来予約投稿を採用する場合も、provider scheduled IDはSQLite outboxに紐づく下流artifactでしかない。取消はlocal fenceを先に確定し、provider取消結果を照合する。予約・取消とも受理が曖昧なら自動再送せず`needs_review`。配送済みか不明な予約を新予約で置換しない。これを満たす別ADRとfixtureなしに有効化しない。

## retention・redaction・admin

- active/paused scheduleの実行に必要な承認本文は有効revisionの間だけ保持。失効・取消・置換等で実行不能になってから7日以内に本文・objective・生成結果を削除。run/outbox本文もterminalから7日。未決着needs_reviewの本文もその状態へ移行してから7日で削除し、調査のために無期限延長しない。
- terminal schedule/run/outboxのmetadataはterminalから30日、redacted auditはevent時刻から90日。未決着の一意性・取消・request-started fenceは本文なしで決着まで保持し、決着後30日保持する。active scheduleについては最後の処理済みUTC high-watermarkと未決着キーを保持し、古いrunの削除後も過去発生分を再作成しない。
- purgeは起動時と24時間ごと。期限に達した内容は読取／送信でも利用不可とし、Mac停止中の物理消去は次回起動時になる。この遅延をhealthへ表示する。backup対象はredacted metadataのみとし本文を含めない。auditの新イベントで元データの保持期限を延長しない。
- ownerは自分のpreview/history/pause/cancel/再承認が可能。同tenant adminはredacted metadata参照、pause/cancel、retention purge、needs_review reconcileのみ可能。adminはowner本文を閲覧・変更・再承認・任意retryできない。tenantを跨ぐ操作は禁止。
- reconcileはproviderの受理証拠がある場合`sent`、未受理の確証がある場合`failed`へ移す。証拠なしならneeds_reviewを維持。再実行はownerが新revisionまたは新one-shotを明示承認し、二重配送リスクを確認する。admin単独で再送しない。
- auditはactor、tenant、schedule/revision/run ID、action、時刻、decision code、policy/tzdb version、content hash、provider receipt IDだけ。本文、token、credential、private URLなし。secretをauditへ転記せず、redaction件数と種別だけ記録する。

## 後続Issueへの反映checklist

これは実装済みチェックではなく、各Issueの受け入れ時に確認する契約である。Issue本文や他Issueの担当はこのPRから変更しない。

- [ ] #6: versioned domain、strict recurrence validation、Clock、calendar fixture全件、unknown version拒否、tzdb固定とexclusive previewを実装する。
- [ ] #7: revision/snapshot/hash、run一意キー、request-started fence、high-watermark、redacted auditとretentionを永続化しmigration/rollbackで保持する。
- [ ] #8: owner/tenant quota、preview上限、expiry表示、target固定、変更時の新revisionと再承認、cancel fenceをAPI/MCPへ反映する。
- [ ] #9: 900秒境界、直近1件、clock前進／後退、lease/recovery、長期停止compact skip、overlap停止を実装する。
- [ ] #10: reminderのtyped outbox、plain text制限、直前authorization、3 attempts、曖昧writeと取消raceを実装。予約投稿は呼ばない。
- [ ] #11: read-only work ownership、3600秒timeout、DM既定／none、固定routing、結果redaction・長さ・通知期限を実装する。
- [ ] #12: quota全状態、expiry/revocation/revalidation、misfire優先順位、tzdb移行と再承認を実装する。
- [ ] #13: adminの権限境界、purgeと遅延health、receipt reconcile、監査、SLOを運用手順とCLIへ反映する。
- [ ] #14: 全fixtureを実calculator/API/DB/outboxへ接続し、crash、cancel/expiry race、DST、tzdb欠落、quota同時作成、redaction失敗、long sleepをfake clockで検証する。

## このPRの検証境界

`node --test test/scheduler-policy-fixtures.test.mjs`でcanonical encoding、fixture参照、UTC/local変換、DST first/second、無効日付と長期停止の数値境界を検査する。これはfixtureの内部整合性検査であり、recurrence calculatorやschedulerの実装ではない。列挙器が全候補を網羅すること、bundled tzdb 2025bの配布、実DB、authorization照会、Slackの実配送、SLAの達成は#6〜#14で検証する。ここではhost ICUのtimezone規則を補助的に照合し、2025bをロードしたと偽らない。
