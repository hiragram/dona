# Scheduler domain v1

Issue #6の純粋domain module。`index.ts`から利用する。policyの正本は[ADR 0001](../../../docs/adr/0001-scheduler-policy.md)と同じrevisionのfixtureで、DB・API・実行workerはまだ接続していない。

```ts
import { defaultPolicy, parseDefinition, previewOccurrences } from './scheduler/index.js';

const definition = parseDefinition({
  schedule_id: 'schedule_1', revision: 1, tenant_id: 'T1', owner_id: 'U1',
  recurrence: {
    version: 1, kind: 'daily', interval: 1, start_date: '2026-09-05',
    local_time: '09:00:00', timezone: 'Asia/Tokyo', tzdb_version: '2025b',
  },
  policy: defaultPolicy(),
  action: {
    kind: 'reminder', action: 'slack.reminder.post', body: '朝の確認',
    target: { kind: 'thread', workspace_id: 'T1', channel_id: 'C1', thread_ts: '1234567890.000001' },
  },
});
const preview = previewOccurrences(definition, {
  after: '2026-09-05T00:00:00Z', before_or_equal: '2026-09-12T00:00:00Z', limit: 5,
});
```

## 契約と境界

- recurrence/policyのtext入力は`decodeRecurrence` / `decodePolicy`を通す。重複key（escape表記も含む）、未知field/version、非整数number token、64 KiB超過・32階層超過を拒否する。encodeはASCII key順・末尾LFを持つcanonical JSONを返す。object入力の`parseRecurrence` / `parsePolicy`もv1を検証するが、すでに通常の`JSON.parse`で失われた重複keyは検出できない。
- policy v1の全値をADRのfixtureと固定照合する。値の変更は未知policyとして拒否し、v1の意味を変えない。APIでのquota transaction、authorization snapshot・expiry照会・権限検証、配送時のredaction/escapingは#7以降の担当。
- `ScheduleDefinition`はschedule/revision、tenant/owner、typed action、recurrence、policyを保持する。targetは解決済みの明示値を要求し、default宛先を推測しない。reminderはthread/channel/owner DM、workは固定のread-only objectiveと任意の結果通知を表す。cross tenant・他ownerのDM、本文/目的のcode point上限を検証する。型が妥当であることは実際のSlackアクセス権を保証しない。
- `validateCreation(definition, clock)`は作成時のonce未来境界とrecurring start_dateの当日〜366日を検証する。保存済みrecordの読込は`parseDefinition`を使う。`SystemClock`だけが現在時刻を取得し秒へ切り捨て、`FakeClock`は秒単位のadvance（負数でrewind）とsetを提供する。既存の非schedulerコードの時計は変更していない。
- previewは`(after, before_or_equal]`、1〜366 UTC日・1〜100件。上限超過を補正せず`invalid_preview_limit`とする。horizonのcivil dateだけを最大369日走査し、gap/無効日を除外、overlapは早いUTCだけを選択する。UTCに整列・重複除去後にlimitを適用する。
- `truncated`は指定horizon内にlimitを超える候補がある場合のみtrue。cursorはそのとき最後に返したUTC、その他はnull。続きのrequestにも1〜366日のhorizon条件を適用するため、元の終了境界まで1日未満なら新しい有効な検索窓を明示して必要な終了境界で結果を絞る。`nextOccurrence`も有限horizon内だけを返し、省略時は366日と公開範囲末尾の早い方まで（末尾の1日未満も検索）。nullは将来全体の不存在を意味しない。
- `OccurrenceKey`は`[schedule_id, UTC instant]`のJSON tuple。revisionを跨いでも同じ時刻のkeyを変えず、別fieldにrevision・local・timezone・tzdbを残す。永続high-watermark/一意制約は#7以降で必要。計算器単体は再配送抑止を実行しない。
- once codecはADRどおり`version, kind, at`だけ。`resolveOneShot`でlocal入力をpreviewする場合、gapはtyped error、overlapは早いUTC。そのUTCを確認後にonceへ保存する。onceのoccurrence local identityは保存値に基づくUTCで、元の入力timezoneを復元したと主張しない。

## tzdbの供給と実際の検証範囲

`moment-timezone@0.5.48`をexact dependency・lockfileで固定し、同梱の全量tzdb `2025b`を読む。このversionとtzdbの対応は[upstream release](https://github.com/moment/moment-timezone/releases/tag/0.5.48)、offset区間の意味は[Zone objectの公式資料](https://momentjs.com/timezone/docs/#/zone-object/)を参照。momentの日時parse/default DST補正は使わず、初期化時にzone名・遷移・offsetをprivateなsnapshotへコピーする。以後のMoment global設定・host timezone・host ICUに依存せず、offset候補をUTCへ戻して実区間と照合する。

公開する技術上の計算範囲はGregorianの0001〜2499年。2499年は同梱データの将来遷移展開の最終年であり、それ以降へ末尾offsetを黙って延長しない。instant/localの変換結果が範囲外なら`out_of_range`。未知tzdbは`tzdb_unavailable`で、最新データへfallbackしない。後続runtimeはこれをADRの`paused_tzdb_unavailable`へ対応付ける必要がある。IANA link名を含む同梱名だけを大文字小文字まで厳密に受け、入力名を保持する。

`dispatcher/test/scheduler.test.ts`はADR calendar fixture全10件を実計算器へ渡し、54通りのtimezone/recurrence/interval組合せ、Tokyo one-shot、weekly anchor、31日・閏日、30分DST、日付変更線、codec・Clock・上限を検証する。既存`test/scheduler-policy-fixtures.test.mjs`のhost ICU補助検算とは別の検証である。実DB、misfire実行、権限照会、Slack配送、Herdr、SLA、tzdb移行運用は未実装・未検証。
