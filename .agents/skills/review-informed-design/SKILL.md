---
name: review-informed-design
description: "Donaの認可境界、永続状態、非同期処理、外部連携を設計・実装するとき、直近のCodex Cloud reviewで繰り返し見つかった失敗条件と事前対策を参照する静的な知識Skill。PR提出後のreview cycleやIssue設計手順は置き換えない。"
---

# Reviewで見つかった設計・実装パターン

2026-09-10〜24 UTCに蓄積されたreview指摘を、旧headへの再指摘を独立件数として数えずに統合した知識。変更する責務に関係する項目だけを使う。代表的なPR、comment、時刻、適用範囲は[根拠](references/review-evidence.md)にまとめた。過去の指摘は現在の欠陥や要件の証明ではない。採用前に現在の状態遷移、call site、契約、テストを確認する。

## 派生データでも現在の認可を評価する

**失敗条件:** 作成時には正当に得た一覧項目・通知・cursor・UI詳細を、その後のbinding失効やaccess取消後も表示する。認可前に候補数を切り、許可された項目が後続pageに埋もれる。scopeをprincipal IDだけで照合し、tenant、workspace、resource、operation、開示先の違いを見落とす。

**設計方針:** 永続化されたowner情報は履歴とし、readや通知の時点で必要なauthorityを再評価する。認可filterとpaginationの順序、cursorのscope、上限到達時のfail-closedまたは継続手段を契約として決める。path、query、bodyなど複数の対象指定がある場合は、信頼できるcontextと照合する。

**実装確認:** revoke後の一覧・stream・再接続、他tenant/別resource、許可外候補がpage先頭を占める場合、cursor再利用を検証する。DMなど外部APIが返すfieldが異なる経路では、欠落fieldの意味をAPI契約ごとに確認する。

## 受理と結果を別の段階として永続化する

**失敗条件:** 外部writeが成功した後のreadやresponseだけが失敗し、成功を受付不明へ戻す。terminal遷移後の同一Resultやdecision再送を拒否して、受理済みかどうか確認できなくする。単なるidempotency key一致で、内容やrevisionが変わった操作を同一とみなす。

**設計方針:** request、side effect、receipt、応答の境界ごとにdurable stateを決める。timeoutや切断では新規writeをblind retryせず、同じ対象・内容・世代の保存済み結果をread-onlyで照合できるようにする。terminal guardより前に同一要求の再生が必要か検討し、異なる要求はconflictにする。

**実装確認:** write直後の応答喪失、receipt後のread失敗、process再起動、terminal後の同一/異内容再送、古いrevisionの再試行をテストする。UIには受理済みと結果未取得を別に表示する。

## 競合検査と副作用を同じ境界で考える

**失敗条件:** 認可やCASを先に読んでからwriter lock取得までに失効・更新される。競合が判明する前に外部監査reserveや通知を行い、DBだけrollbackして外部副作用が残る。非同期query後に開始時のgenerationやsnapshotでreceiptを作る。

**設計方針:** 誰がいつ変更できるかを列挙し、最終的な失効・revision検査をcommit可能な境界内に置く。外部side effectをtransactionで戻せないなら、reserve前のprecondition、再照合、補償または曖昧状態の扱いを定義する。snapshot、cursor、receiptは同じ状態世代へ束縛する。

**実装確認:** 別connectionでの同時失効/更新、side effect成功後のDB失敗、query中の世代変更、sequence退行を挿入して結果を確かめる。単一writer前提の場所へ不要な分散機構を追加しない。

## 移行と復旧を通常の経路に含める

**失敗条件:** 関連tableの一方だけが移行済みになる。旧schema互換writeの記録が次版で失われる。kill後の一時ファイルやsocketが残る、または別processが所有する資源をcleanupする。retention処理を実装しても起動時にしか呼ばれない。

**設計方針:** 互換期間の読み書きとrollback境界を明記する。永続資源は所有者とgenerationを識別し、再起動時に安全に回収・再利用・隔離できるようにする。期限処理の呼び出し主体と頻度も設計に含める。

**実装確認:** 旧DBからのupgrade、旧binaryへのrollback、migration途中の失敗、kill/restart、別process稼働中のcleanup、期限到達後の常駐動作を検証する。migrationがない変更にはこの節を形式的に適用しない。

## 非同期UIと通知で古い結果を混ぜない

**失敗条件:** 遅れたAの詳細応答が選択済みBを上書きする。権限喪失後もprivateな旧表示を残す。terminal jobへstreamを再接続し続ける。通常reportが未配送の高優先通知を上書きする。snapshot取得後の別時点でcursorを発行し、更新を読み飛ばす。

**設計方針:** 応答を選択IDとgenerationに結び付け、表示時にcurrent identityを照合する。通知の優先度、pending参照、配送完了、supersede条件を状態機械で決める。snapshotとcursorは同じtransactionまたは同等の整合境界から作る。

**実装確認:** 応答順逆転、access取消、terminal直後、publisher障害中の複数report、snapshotとcursor発行の間の更新を検証する。同期画面へ不要なstream管理を持ち込まない。

## テストは契約の入力から出口まで通す

**失敗条件:** fixtureに書いた期待decisionを数えるだけで実際の認可判定を呼ばない。新eventを生成しても変換側のallowlistを更新せず実運用で落とす。外部APIへ見た目の合う未サポート値を渡す。

**設計方針:** 重要な不変条件を入力、状態遷移、出口の具体例に落とし、生成側から受信・変換・表示側まで辿る。platform APIの値は公式契約や実機で確認する。

**実装確認:** 正常系に加え、欠落field、境界値、失効、再起動、競合、別経路を通す。platform固有の定数や一PRの事情を全領域の規則にしない。

対処が現在の要件と衝突するときは指摘を絶対視せず、具体的な反証と未検証境界を記録する。提出時は別途`$code-submission-review-cycle`を使う。
