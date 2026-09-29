# Job artifact inventory（読み取り専用）

`dona-dispatcher job artifact-inventory --limit 10` は、Dispatcher DBに記録されたjobをID順に最大20件ずつ読み、worktree、progress、Resultの保存領域を調べる。続きは返された `next_cursor` を `--cursor` に渡す。出力に保存先の絶対パスや内容は含めない。

各artifactの `allocated_bytes` は、確認できたinodeの割当ブロック数を足した観測値である。圧縮、共有ブロック、別artifactとの重複は差し引かない。1回の呼び出しは合計1万entryまたは3秒で計測を打ち切り、そのartifactは `budget_exceeded` と `allocated_bytes: null` を返す。欠落は `missing`、symlinkや所有者の異常は `unsafe`、DBの保存先が生成規則と異なる場合は `contract_mismatch` として扱う。これらの値をゼロ容量として集計しない。

`protection_reasons` は現段階での保守的な表示である。終端jobでも通知と保持期限を照合する仕組みは未実装のため、`notification_unverified` と `retention_expiry_unverified` を返す。このcommandは削除候補を承認せず、DBを `purged` に変更せず、ファイルを削除しない。通知証拠、期限、DB先行遷移、削除直前のinode照合、disk floorを後続の実装で結び付ける。
