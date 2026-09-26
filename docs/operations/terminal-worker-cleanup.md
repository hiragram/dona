# Result受理後のworker cleanup

この処理は、新しいDona版で作成したjobについて、Result受理後に残ったidle Codex agentへ一度だけ`Ctrl+C`を送るbest-effort cleanupである。Herdrの`dona` sessionはDonaだけが操作する、という運用上の単一writer前提に依存する。job IDとagent名は同一で、DBの一意制約と変更禁止triggerで別jobへの割当を防ぐ。terminal jobを再びprepare/startする経路は設けない。

保存済みworkspace、pane、agent名、agent session IDを直前の`agent get <job-id>`結果と照合する。同じidentityで`working`または`blocked`なら待つ。steer送信中は候補から除外し、claim時にも確認する。idle/doneを確認した後、送信前に`attempting`を永続化し、agent名宛ての`send-keys <job-id> ctrl+c`を一度だけ呼ぶ。`agent get`と`agent list`で短時間の不在を観測し、`stopped`、`unknown`、`rejected`を保存する。送信のtimeoutや再起動後の`attempting`は読み取りだけで照合し、再送しない。cleanupは通知生成やResult受理を変更しない。

Herdr APIにはidentityを条件にしたatomicな送信がない。Dona以外の操作者が同じagent名を外部から再利用すると、照合と送信の間の競合は残る。これは上記の単一writer運用で受け入れた残余リスクであり、`stopped`は観測したagent名の不在だけを表す。全worker/process treeの停止、旧11件のmaintenance fence receipt、Updaterのactivation安全性は証明しない。`maintenance_fence_receipt_required`と既存のfail-closed update gateは維持する。
