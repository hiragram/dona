# Job Result 公開の段階導入 gate

## 現在の境界

Dispatcher は専用公開 request の検証、capability、永続 receipt、read-only reconcile を実装している。通常の worker 起動、prompt、Supervisor の Result 取り込みは旧 `result_path` 方式を使う。接続済み FD の worker 配送と新規 job の version gate は未配線であり、現時点で専用公開を本番有効化しない。

`GET /metrics/job-result-publish` は Dispatcher の既存 Unix socket に対する読み取り専用集計である。`jobs` は receipt も専用公開 marker もない終端件数（旧方式または marker 導入前で識別不能）、receipt が現存する終端件数、receipt 削除後も専用公開 marker が残る終端件数、公開可能な `dispatching`、`running`、`needs_review` の現在値を示す。`receipts` は現存する `reserved` / `committed` / `needs_review` の件数、`current_failures` は現在 `needs_review` である `invalid_result` / `result_missing` / `published_result_reconciliation_required` の件数を示す。job ID、本文、capability、path、URL、任意のエラー文は返さない。いずれも現在値であり、job 自体の retention や operator 解決により減少する。typed rejection の履歴と成功率は表さない。operator は個別の認可済み job 照会と durable な監査記録を併用する。

## 切替前に確認すること

1. 隔離環境で旧 DB fixture と実行中の旧 worker を含む upgrade を行い、旧 worker の `result_path` 公開と終端通知を確認する。新 worker の専用公開では同 payload 再読、異 payload 競合、受理後の応答喪失、restart、file/DB 部分失敗、1 MiB 境界、schema version、secret canary を検証する。
2. 新規 job だけを明示的な release version と capability gate で切り替え、既存 job の方式を永続 job 契約へ固定する。接続済み FD の配送先と worker session を照合し、同じ job に両方式を提示しない。両方式の terminal notification が一件に収束することを E2E で確認する。
3. 観測値の baseline と許容値を記録する。現在 `reserved` または `needs_review` が残る、通知欠落、読取不能、または durable 監査で新しい失敗が確認されたら新規切替を停止する。typed rejection の単調な履歴が整うまでは、この snapshot の増分だけで切替を許可しない。受理不明は read-only reconcile で照合し、blind retry しない。

## 停止と rollback

切替を停止するときは新規 job の gate を off にし、既存 job の方式を変更しない。`reserved` と `needs_review` は file、DB、receipt、worker 停止証拠を読み取りで照合する。Result file の存在や `actions: []` だけで成功、通知済み、再実行安全とは判定しない。rollback 先 binary の schema 読み書き互換性を確認し、進行中の専用公開 job と receipt の扱いが証明できない限り旧 binary を起動しない。旧方式の無効化は混在 job がなく、故障注入と restart を含む E2E、終端通知の照合、rollback 手順、明示的な本番承認が揃った後に別途判断する。

本書は切替の判定条件であり、本番有効化や isolated-live 証拠を記録したものではない。
