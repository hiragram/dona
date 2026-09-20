# Approval execution markerの保存

`ApprovalExecutionMarkerStore`は、承認済みreplyの実行attemptを外部messageと照合するためのmarkerを、共有auditのresource rootと同じtransactionへ保存する内部componentです。#16の部分対応であり、実行workerやSlack投稿を有効にするものではありません。

## 形式と鍵

version 1はscope、request、consume、attempt、固定operation、semantic hash、初回execution fence、作成時刻、clock transaction ID、key versionへHMACを結合します。鍵の用途は`approval_execution_marker`で、contentやnotificationの鍵とは分離します。署名可能期間は最大90日で、rotation後は保存したversionのverification-only keyで検証します。revoked・未知version・用途不一致は拒否し、既存markerを新しい鍵で署名し直しません。保持鍵の保管・400日とbackup expiryに基づく破棄は、共有key lifecycleを接続する側の責務です。

`dona.ex1.<attempt_id>.<MAC>`は最大202 ASCII文字です。[Slack section blockの公式仕様](https://docs.slack.dev/reference/block-kit/blocks/section-block/)にある`block_id`の255文字上限内ですが、実Slackでの検証証拠ではありません。markerだけで送信権限や外部受理を判断せず、認証済みapp author、exact workspace/channel/thread、全pageとpagination fenceをtransport側で照合する必要があります。

## 原子的な保存

schema v5はv4からの明示migrationだけを許します。既存execution recordのcanonical wire、署名、payload、監査履歴を維持し、immutableなmarker tableを追加します。既存attemptへのmarker補完、監査rootの初期化、credentialの作成、runtime migrationは行いません。payload導入履歴によるbackup拒否も維持します。

brokerはcurrent authority、短い開始期限、binding/policy/ordered thread/requester権限/visibility、本文と鍵を検証した後、同じprepareで`claimed -> executing`のrecord mutationとmarker planを作成します。markerはcurrent markに結合し、保存済みclaimed attemptのfenceに1を加えた値だけを受け付けます。mutationではrecordを先に保存し、同じtransactionでmarkerと共有tree rootを保存します。markerだけの保存、順序逆転、差替え、削除、REPLACEは拒否します。mutation callback内の直接INSERTにも既存ledgerと同じclock provenance triggerを適用し、過去のclock参照を拒否します。codecによる構造検証とstoreによる監査root照合は、用途別鍵のMAC検証を代行しません。

SQL例外なら同時rollbackし、audit reserve/finalizeの結果不明時は同じwriteを再試行しません。durable状態を照合し、復旧したexecutingはacceptance_unknownへ進める実行workerに接続する必要があります。保存済みmarkerがない既存executing attemptを送信可能とは扱いません。

## 検証と未接続範囲

固定HMAC vector、全binding field、rotation/失効、block ID長、getter/Proxy拒否、schema移行・再open、shared root不在、SQL改変・欠落、exact audit state、fence/marker同時commit、rollbackとanchor応答喪失をfixtureで検証します。実行結果の記録、TTL sweep、read-only reconcile、配送worker、実authorityとprotected credential store、operator admission、runtime接続は後続作業です。実credential、実Slack、production activationの証拠ではありません。
