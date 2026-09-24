---
name: review-informed-design
description: "Donaの設計・実装で認可境界、永続状態、非同期処理、外部連携を変更するとき、過去のCodex Cloud reviewから得た横断的な失敗パターンを設計段階で点検する。PR提出後のreview cycleやIssue設計の手順は置き換えない。"
---

# Reviewから設計へ戻す点検

変更する責務に関係する項目だけを設計・実装前に確認する。[根拠と適用境界](references/review-evidence.md)には2026-09-10〜24 UTCの実例がある。過去の指摘は現在のコードや要件の証明ではないため、採用前に対象の状態遷移、call site、契約、テストを再確認する。

- **認可と開示:** principalだけで判断せず、tenant/workspace、resource、operation、現在のaccess、開示先を結び付ける。元データやbindingの失効後にも、派生した一覧・通知・cursorから情報が見えないか確認する。候補を上限で切る前に認可filterをかけ、上限到達と継続可能性を区別する。
- **永続状態と再試行:** request受理、外部write、receipt保存、responseの各境界でtimeoutやクラッシュを想定する。成功後のread失敗で成功を取り消さず、曖昧な結果はdurable stateから照合する。idempotency keyだけでなく対象のrevision、世代、内容を比較し、terminal後の同一結果再送も扱う。
- **並行処理と移行:** authorization、CAS、外部監査、DB更新、通知の順序を追い、競合検査とside effectの間に別writerが入れるかを見る。複数tableのmigrationとrollback、旧binaryとの互換期間、process再起動を含む状態遷移を確かめる。
- **非同期UIと通知:** 遅い応答が新しい選択や状態を上書きしないよう、snapshotとcursorを同じ時点へ結び付ける。権限喪失時はprivate表示を消し、terminal時は不要なstream/retryを止める。未配送の高優先通知が通常通知で失われないか確認する。
- **検証:** テストがfixtureの期待値を数えるだけになっていないか、実際の認可入力・失効・競合・再起動・境界値を通るか確認する。新しいrouteやevent種別は生成側から受信・変換・表示側まで辿る。実行環境や外部APIの値は公式契約または実機で確認する。

該当しない項目を形式的に実装へ持ち込まない。対処が要件や既存契約と衝突する場合は、review commentを絶対視せず、具体的な反証と未検証境界を記録する。PR提出時は別途`$code-submission-review-cycle`を使用する。
