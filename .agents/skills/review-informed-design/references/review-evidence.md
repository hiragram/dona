# 直近Reviewの根拠と適用境界

## 収集範囲

2026-09-10 00:00:00〜2026-09-24 10:25 UTCをreview/comment時刻の範囲とした。GitHub REST APIで更新日時が開始以降のPR 106件を全page取得し、各PRのreviews、pull review comments、issue commentsを全page取得した。期間内のCodex actorによるreview 447件、inline comment 1,253件（66 PR）、issue comment 275件を観測した。issue commentには`@codex review` triggerや完了通知が含まれるため、指摘件数へ合算しない。inline comment 1,253件のうち1,203件にはdirect replyがあり、収集時点のPR headと`commit_id`が一致したものは377件、旧commitを指すものは876件だった。direct replyや旧commitは修正済みの確証ではないため、1,253件を独立した未修正欠陥数とは解釈しない。PR作成日時では除外しない。収集後の追加reviewは含まない。

## 横断的な観点

| 観点 | 具体例とUTC時刻 | 適用境界 |
| --- | --- | --- |
| 派生データへの現在認可 | [#270: 元bindingの失効を一覧で再検証](https://github.com/hiragram/dona/pull/270#discussion_r4062152904) 09-21 12:36、[#269: SSEで権限喪失時にprivate表示を消す](https://github.com/hiragram/dona/pull/269#discussion_r4061393246) 09-21 10:46、[#267: 認可filter後に候補を制限](https://github.com/hiragram/dona/pull/267#discussion_r4060462128) 09-21 08:38 | privateな派生表示・一覧に適用。公開情報の単純paginationへ同じ認可構造を要求しない。 |
| scopeの一貫性 | [#266: taskとworkspaceのrepository照合](https://github.com/hiragram/dona/pull/266#discussion_r4060094796) 09-21 07:37、[#285: guardとbrokerのscope照合](https://github.com/hiragram/dona/pull/285#discussion_r4086154241) 09-23 18:58、[#258: pathとJSON本文のeventを束縛](https://github.com/hiragram/dona/pull/258#discussion_r4059657267) 09-21 06:11 | 複数のauthorityや入力経路がある場合。単一の正規化済みscopeなら重複検証を増やさない。 |
| 曖昧な受理と再送 | [#269: 成功receipt後のread失敗](https://github.com/hiragram/dona/pull/269#discussion_r4061393232) 09-21 10:46、[#294: terminal後の同一Result再送](https://github.com/hiragram/dona/pull/294#discussion_r4090783614) 09-24 06:56、[#288: 保存済みdecisionをterminal検査より先に再生](https://github.com/hiragram/dona/pull/288#discussion_r4088832880) 09-24 01:09 | 外部writeや永続化を含む経路。read-only処理に重いreceipt機構を要求しない。 |
| 競合とside effectの順序 | [#266: CAS競合を監査reserve前に確定](https://github.com/hiragram/dona/pull/266#discussion_r4059905802) 09-21 07:02、[#266: writer lock内で失効を再検査](https://github.com/hiragram/dona/pull/266#discussion_r4060006459) 09-21 07:22、[#257: live query後の世代を再検証](https://github.com/hiragram/dona/pull/257#discussion_r4059577353) 09-21 05:55 | 複数writerや非同期queryがある場合。transaction境界と外部side effectの実際の順序で判断する。 |
| migrationと復旧 | [#266: routingとauthorization移行を同じrollback境界へ](https://github.com/hiragram/dona/pull/266#discussion_r4059905813) 09-21 07:02、[#288: v2互換期間のdecision保存](https://github.com/hiragram/dona/pull/288#discussion_r4088832882) 09-24 01:09、[#182: 中断したpartファイルの回収](https://github.com/hiragram/dona/pull/182#discussion_r4053792007) 09-19 16:22 | 永続schemaやファイルを変更する場合。移行のない純粋関数へ適用しない。 |
| 非同期表示と通知 | [#269: 古い詳細応答が選択を上書き](https://github.com/hiragram/dona/pull/269#discussion_r4061393251) 09-21 10:46、[#278: 未配送の緊急reportを通常reportで破棄](https://github.com/hiragram/dona/pull/278#discussion_r4062766455) 09-21 13:51、[#256: snapshotとcursorを同じtransactionで取得](https://github.com/hiragram/dona/pull/256#discussion_r4059603682) 09-21 06:01 | 応答の順序逆転や通知抑制があり得る経路。同期表示へstream管理を導入する理由にはならない。 |
| 契約を通る検証 | [#248: fixtureを実際の認可入力で固定](https://github.com/hiragram/dona/pull/248#discussion_r4058589372) 09-21 00:29、[#278: event生成後の変換許可リスト](https://github.com/hiragram/dona/pull/278#discussion_r4062766442) 09-21 13:51、[#283: Keychain APIの定数](https://github.com/hiragram/dona/pull/283#discussion_r4083348055) 09-23 14:07 | 該当するintegration境界に適用。個別プラットフォームの定数を一般規則へ昇格させない。 |

これらは指摘時点のreview evidenceであり、現在headの未修正問題一覧ではない。修正済み・重複・不適用の判定は各PRの後続commitとdirect replyで行う。
