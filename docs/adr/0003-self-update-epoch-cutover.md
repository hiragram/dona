# ADR 0003: self-update epochとworkload・通知のcutover

状態: 採用。Issue #232。後続の #233 以降が実装する契約であり、現行runtimeの機能を主張しない。

## 背景と採用案

現行の`updateSafetyStatus()`は`events.dispatching/waiting_agent`、`jobs.dispatching/cancelling`、steer acceptance unknownをunsafeとする一方、running/blocked/needs_reviewのworkerとterminal通知backlogを止めない。`JobSupervisor.stop()`はcontroller operationをabortするがworker ownershipを移さない。起動時のlegacy Result path移行と`listJobsNeedingNotification()`は、過去jobの状態変更と通知生成を同時に起こし得る。ゆえに「quiesce済み」だけでは安全なcutoverを証明できない。

採用するのは **旧epoch固定で継続し、検証済みcompletionだけを新epochが回収する方式**。checkpointと所有権移譲が実装・検証されたworkerだけ、将来の別契約で明示handoffできる。v1では実行中workerのhandoffを禁止する。全worker terminal待ちのstop-the-worldは長時間jobを破壊しResult喪失を増やすため却下する。識別子だけによる暗黙handoffも却下する。

## 正本と所有権

- stable Updater DBが単調増加する`update_epoch`と`request_id`、fence、旧/新release SHA、completion・control・notification protocol compatibility、phaseを所有する。epochはapply受理時に予約し、同一requestのrestartで再採番しない。activation失敗・rollback後も番号を再利用しない。
- Dispatcher DBが各workloadの`owner_epoch`、`owner_release_sha`、`protocol_version`、`owner_session_id`、`source_event_id`、workspace/tenant、completion destination、lease/fence、状態を所有する。job ID、process名、pathだけから所有権を推定しない。未登録legacyは`unknown`として隔離する。初回導入でlive legacy workerが残る場合はactivationを拒否し、全worker terminalと通知backlogのmaterialize後に進む。
- stable Updaterのactivation fenceはruntime操作を制御する。Dispatcherのworkload fenceはResult受理と状態遷移を制御する。二つを混同しない。旧ownerは新epochのDB状態を書けない。旧workerは自身の保存済みcompletion destinationへResultを原子的に公開できるが、回収・通知・削除の権限を持たない。
- completion receiptはjob ID、source event、owner/workspace、owner epoch、release SHA、protocol version、worker session identity、Result digest、destination、workload fenceをserver側の永続値と照合して一度だけ確定する。取消済みlease、新旧protocol不一致、digest不一致、重複で内容が異なるResultは`needs_review`へ隔離し、自動再実行しない。receiptだけが所有権を移すことはない。receipt、jobのterminal状態、`completion_event_id`、group transition、通知dispositionは同一Dispatcher transactionでcommitする。`blocked`、cancelled、failed、needs_reviewへの通知対象遷移も、それぞれgroup transition、attention/all-terminal event/ID、通知dispositionと同一transactionで確定する。最後のattention resolutionもgroup state、all-terminal event/ID、通知dispositionと同一transactionで確定する。既存receiptに対応するeventだけ欠損する状態を許さず、新protocolの不整合は自動生成せず隔離する。旧schemaの正常なevent作成前窓は初回quiesceでmaterializeする。
- worker leaseは実行の観測期限であり、期限切れは死亡証明ではない。期限切れだけでは再割当てしない。ただし同一ownerに固定され、revoke/再割当てがなくexact session/fence/digestが一致するResultは期限後でもreceipt化できる。revoked、acceptance unknown、session identity不明ではcancel/resume/reassign/通知を自動実行しない。operator reconcileまで結果領域を保護する。
- release、worker sandbox、Result領域、DB snapshotは各workloadのResult dispositionと通知dispositionがsettleし、rollback対象期間が終わるまでGC禁止。`completed`または`not_required`を永続dispositionとして扱い、通知先`none`やdispatch前cancelで正当に存在しないResult/通知は`not_required`へ確定できる。unknownはsettle扱いにしない。cleanupは各artifactの参照を列挙した後にfence付きで行う。

## workload cutover表

| class | apply前とquiesce | activation後 | 証拠不足時 |
| --- | --- | --- | --- |
| main agentの受理済みturn | Result公開までdrain。未受理入力を停止し、旧sessionのexact identityを停止・消失確認 | pointer切替後に新releaseで新sessionを開始 | acceptance unknownなら停止して`needs_review` |
| background worker | owner epochへ固定し継続。新規dispatch/steer/cancelを停止 | 新Dispatcherがversioned completion receiptで回収。旧owner fence、exact session、元の委任source event、現在のfollow-up event ID、same-threadの候補と依頼意図、workspaceを別々に検証するversioned steer/cancel経路だけを提供し、実行所有権は移さない。経路がないlive workerを残したactivationは禁止 | legacy/unknownは隔離、旧Result領域を保持 |
| scheduled worker | schedule runとowner bindingを固定し継続。due scanと新規委任を停止 | 同じrun keyの重複を拒否しcompletionを検証。schedule/run/revisionと取消mutationの永続ID、旧owner fence、exact sessionを検証するserver-originated cancel経路を維持し、経路がなければactivation拒否 | access/authorization不明なら新規実行・通知抑止 |
| provider writeとoutbox | in-flight writeをreceiptまでdrain。応答喪失は外部IDで読取照合 | 未claimの`send_not_started`とintentなしをfenced claimで一度だけ送信し、既存receiptは照合して再開 | acceptance unknownなら再送せず隔離 |
| job/group notification worker | in-flight postとsession statusをreceiptまでdrain | 保存済みevent/receiptだけ再照合し送信 | 投稿済み不明なら重複送信せず`suspended`相当のattention |
| updater runtime operation | intentとfenceをstable DBへ先に保存 | pointer、process、health、sessionを再観測 | 不一致なら`needs_review`、再送禁止 |

## DB snapshotとphase invariant

1. **plan/apply前:** exact current/target SHA、inventory上の全live ownerと未settle通知のprotocolに対するcompletion reader・steer/cancel経路・event payload/group readerと新旧runtimeのwriter互換性、schema migration能力、owner別workload inventory、通知outbox・group state、Result参照、rollback対象を永続snapshotへ結び付ける。inventoryにunknownや未解決writeがあれば適用を拒否するか対象を隔離して明示的に保護する。件数だけで安全判定しない。
2. **quiesce:** Slack ingress、Dispatcherの新規dispatch・schedule due scan・provider write開始を停止し、in-flight acceptanceをreceiptまでdrainする。両serviceのdrain receiptは同じrequest/epoch/fenceとinventory watermarkに束縛する。watermark以降の新規commitがないことを再照合する。main turnとsteer/cancelの受理不明が残れば進めない。
3. **migration:** app DBのonline backupをmigration前に取り、WALを含む一貫性、integrity、schema version、open-test、復元可能性を検証する。backupはepochと元SHAへ束縛する。migrationはbackup/receiptを書いてから一度だけ実行し、失敗・応答不明時はschema/receiptを読んで判定する。新schemaを旧releaseが読書きできないならrollbackを禁止し、旧DB snapshotを復元できると証明した場合だけ旧releaseへ戻す。worker ResultはDB snapshotの外にあるため、復元後もreceipt照合を継続する。
4. **activation:** stable updaterだけがfenced runtime operation intentを記録し、quiesce済み旧process消失を確認してからpointerを切り替え、pointer/activation receipt、新process SHA/schema/protocol/session healthを照合する。新Dispatcherはwriterを起動しないsafe modeで開始する。completion回収、reminder/provider、job/update通知を含む全background writerは停止する。新Dispatcherには`request_id`・epoch・release SHA・Updater fenceを束縛したactive-epoch receiptをCASで永続化させ、同じ値をhealthとDB read-backで照合する。rollbackで旧releaseへ戻す場合も別の単調増加epochを予約し、旧release SHAと新Updater fenceを束縛したactive-epoch receiptを旧DispatcherへCAS install/read-backする。target epochのreceiptを再利用しない。応答不明なら再installせずread-backする。exact active epochが確定するまで新規ingress、job stamp、due scan、全background writerを開かない。
5. **rollback:** 新Dispatcherでjob stamp、schedule due scan、completion回収、provider write、通知送信、またはSlack ingressを一度でも開いた後はmigration前DB snapshotへの自動rollbackを禁止する。target上のevent、main-agent Result、schedule revision、idempotency、auditを完全なstable journalなしに復元できないためである。rollbackできるのはこれら全writerを開始する前だけ。初回rolloutで旧releaseにactive-epoch APIがなければ、旧schema snapshotへ戻した後も外部投入を再開しない。旧releaseへ互換APIを先行導入した段階的rolloutをrollback可の前提とし、先行導入していない初回更新はapply前にrollback不可として拒否する。completion回収、通知outbox、provider writeを含む全background writerをfenceで停止し、最終commit watermarkを再読してinventoryとsnapshotを照合する。外部workerの未回収Result領域は保護する。旧release/schemaの互換性を証明できなければ`needs_review`とする。旧releaseを再起動する際は別の単調増加epochを予約し、旧release SHAと新Updater fenceに束縛したactive-epoch receiptをCAS install/read-backしてからingressを開く。target epochを再利用しない。
6. **post-activation:** inventoryの全workload、Result receipt、notification receipt、runtime operationをboundedに照合する。旧workerが残る間は旧protocol readerとcleanup保護を維持する。通知settleはruntime activationと独立した完了条件とする。

## terminal通知

`completion_event_id`、groupのattention/all-terminal ID、投稿receipt、保存済みreply targetを正本とする。新protocolのterminal jobにeventが欠損していても起動時scanから自動生成しない。旧schemaではterminal保存後の別loopでeventを作るため、初回quiesceでは既存規則でbacklogをmaterializeし、event IDとgroup stateの最終watermarkを照合する。materializeできない場合はactivationを拒否する。既存receiptがあればevent ID、payload digest、status、投稿/Agent Sessionの証拠を照合する。永続eventに`send_not_started`のmarkerがありprovider writeのintentもない場合、scheduled通知ではさらに`notification_authorization_phase=none`を要求する。phaseが`preflight`/`write`または応答不明なら認可を再実行せずread-only照合と明示reconcileへ送る。それ以外の未試行eventは投稿receiptがなくても正常なpendingとして、保存済みeventから一度だけ送信できる。ただしscheduled通知では現在の通知event IDで一段目の`authorize_job_notification`、ownerのcurrent channel accessと署名済みaccess receipt、投稿直前の二段目認可と`access_receipt_verified`を順に確認する。cancel/pause/authorization失効を含む不一致は送信を抑止する。通常のSlack thread通知も保存済みtargetとcurrent accessを再検証する。送信intent後にreceiptを失った状態、旧thread、workspace/owner access不明、投稿済み不明は抑止して`needs_review`へ送る。通知先を現在の会話やjob metadataから推定しない。

Grouped通知ではprogressを投稿せず、attentionは同一group/transitionの既存eventだけを一度処理する。all-terminalは全sibling terminalかつattention resolutionが`not_required`または`resolved`であることをdurable stateで再検証してから送る。未解決attention、欠損group snapshot、旧threadはfinal通知を抑止する。投稿応答喪失時は保存済みnotification IDとprovider側のexact markerを読取照合し、一意に確定できなければ再投稿しない。activation成功を通知成功の代用にしない。

## downstream契約と費用

#233以降で必要な更新: Updaterのepoch/inventory/phase receipt、Dispatcherのworkload owner・completion receipt・versioned reader、schedule runとgroup notificationのfence、Slack投稿receiptとaccess照合、GC参照、管理用reconcile API。既存schemaへepoch列を加えるmigrationと旧protocol readerの維持が必要。複数世代のworkerと未settle通知が残る期間はinventory上の全owner/notification protocolを読む費用がある。次のupdateはtargetが全owner protocolのcompletionとsteer/cancel、全未settle通知protocolのevent payloadとgroup stateを扱えることを検証し、互換でなければactivationを拒否する。readerとcontrol adapterの削除には該当する全ownerと通知dispositionのsettle、保護期間終了の証拠が要る。逆戻しにはDB snapshotだけでなく外部writeと通知receiptの照合が必要で、証拠がない場合は自動rollbackしない。

#155のtest runner設計、#181のdiagnostic log形式、production activationは本ADRの対象外。

## 共用state matrix

`docs/adr/fixtures/self-update-epoch-cutover.md`の各caseを後続のschema/API/統合testで同じ期待結果として使用する。
