# self-update epoch cutover state matrix

各caseの期待値はADR 0003の契約。実装前の仕様fixtureであり、現行test成功を意味しない。

| ID | 初期状態・注入点 | 期待結果 |
| --- | --- | --- |
| W1 | 旧epoch running worker、Result到着前にactivation | worker継続、旧領域保護、新Dispatcherは新規dispatchのみ所有 |
| W2 | 旧epoch running worker、Result atomic publish後にactivation | digest/session/fence照合でreceiptを一度確定、通知は別にsettle |
| W3 | 旧protocol compatible、Result到着後にDispatcher restart | receipt再読で重複回収せずterminal維持 |
| W4 | 旧protocol unsupportedまたはowner不明 | Result隔離、削除・resume・notify禁止 |
| W5 | lease expiredのみ、旧workerが後からResult公開 | 同一owner/session/fenceでrevokeなしならreceipt化。revokedは隔離 |
| W6 | 旧epochのblocked workerへsteer/cancel | versioned経路で元委任eventと現在follow-up event、same-thread、旧owner fenceとexact sessionを検証。経路なしならactivation禁止 |
| W7 | Aのlive workerが残るBからCへの更新 | CがA/Bの全live protocolを扱えなければactivation拒否 |
| R0 | 初回移行時にlive legacy workerあり | activation拒否。全terminalと通知materialize後に再評価 |
| R1 | apply受理後、quiesce前にrestart | 同一epoch/requestを再読しinventoryとacceptanceを照合 |
| R2 | quiesce途中でrestart | 同一fenceの両drainとwatermarkを再取得、unknown write再送禁止 |
| R3 | migration backup後・schema commit前にrestart | backup/receipt/schemaを検査し二重migration禁止 |
| R4 | pointer rename後・activation commit前にrestart | pointer、receipt、health、sessionを照合し推定で再起動しない |
| N1 | terminal jobだがnotification event欠損 | 自動event生成なし、`needs_review` |
| N1a | event永続化済み、`send_not_started`、投稿receiptなし | 必要な認可とaccess再検証後、同一eventから一度だけ送信 |
| N1b | scheduled通知pending、authorization取消/失効 | 二段階認可が成立せず送信抑止 |
| N2 | 投稿応答不明だがexact markerあり | 既送信としてreceiptを確定、再投稿なし |
| N3 | 投稿応答不明でmarkerなし/old thread | 通知抑止、operator判断待ち |
| N4 | group attention未解決、全sibling terminal | all-terminal抑止、sessionをactiveへ戻さない |
| N5 | attention解決済み、全sibling terminal | 保存済みall-terminal eventだけ一度処理 |
| M1 | migration前、旧schemaでrollback | 旧SHA/schema healthとreceiptを検証して復帰可 |
| M2 | migration後、旧releaseは新schema非互換 | 検証済みsnapshot復元と外部receipt照合なしではrollback禁止 |
| M3 | migration後、新epochでprovider write確定 | snapshot復元でもwriteを未実行扱いせずreconcile |
| M4 | target ingress開始後に旧snapshotへのrollback要求 | 全mutation journalがないためsnapshot rollback禁止 |
| M5 | Dispatcher active epoch install応答喪失 | receiptをread-backし、exact一致までingress停止 |
| M6 | target稼働後に旧releaseへrollback | 新しいrollback epochをCAS install/read-backし、target epochを再利用しない |
| M7 | 新ingress前のrollback inventory直後にworker Result到着 | writer fence後ならDB commitなし。Result領域を保護し復帰後に回収 |
| C1 | terminal Result済み、通知未settle | release/Result/snapshot GC禁止 |
| C2 | dispatch前cancelでResultなし、通知先none | 両dispositionを`not_required`へ確定後、参照がなければGC可 |
| C3 | completion receipt commit直後にrestart | terminal状態・event/group transitionも同時に存在し、重複生成なし |
