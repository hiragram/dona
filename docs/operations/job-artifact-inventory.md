# Job artifact inventory（読み取り専用）

`dona-dispatcher job artifact-inventory --limit 10` は、Dispatcher DBに記録されたjobをDB行順に最大20件ずつ読み、worktree、progress、Resultの保存領域を調べる。続きは返された数値の `next_cursor` を `--cursor` に渡す。出力に保存先の絶対パスや内容は含めない。保存済みjob IDが不正でもページ送りを継続できる。

worktreeとprogressのdirectoryは内部を辿らず `unmeasured_directory`、Result fileは開かず `unmeasured_file` とする。いずれも `allocated_bytes: null` で、`size_is_complete` は `false` となる。安全なhandle相対走査とfile openが可能になるまで容量を推測しない。欠落は `missing`、symlinkや所有者の異常は `unsafe`、DBの保存先が生成規則と異なる場合は `contract_mismatch` として扱う。これらの値をゼロ容量として集計しない。旧DBに残るjob ID直下のResult fileも、正確な生成規則に一致する場合だけ観測する。

`protection_reasons` は現段階での保守的な表示である。終端jobでも通知と保持期限を照合する仕組みは未実装のため、`notification_unverified` と `retention_expiry_unverified` を返す。このcommandは削除候補を承認せず、DBを `purged` に変更せず、ファイルを削除しない。通知証拠、期限、DB先行遷移、削除直前のinode照合、disk floorを後続の実装で結び付ける。
