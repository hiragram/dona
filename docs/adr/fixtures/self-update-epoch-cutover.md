# self-update epoch cutover state matrix

各caseの期待値はADR 0003の契約。実装前の仕様fixtureであり、現行test成功を意味しない。

| ID | 初期状態・注入点 | 期待結果 |
| --- | --- | --- |
| W1 | 旧epoch running worker、Result到着前にactivation | worker継続、旧領域保護、新Dispatcherは新規dispatchのみ所有 |
| W2 | 旧epoch running worker、Result atomic publish後にactivation | digest/session/fence照合でreceiptを一度確定、通知は別にsettle |
| W3 | 旧protocol compatible、Result到着後にDispatcher restart | receipt再読で重複回収せずterminal維持 |
| W4 | 旧protocol unsupportedまたはowner不明 | Result隔離、削除・resume・notify禁止 |
| W5 | lease expired/revoked、旧workerが後からResult公開 | 死亡や移譲を推定せず`needs_review` |
| R1 | apply受理後、quiesce前にrestart | 同一epoch/requestを再読しinventoryとacceptanceを照合 |
| R2 | quiesce途中でrestart | 同一fenceの両drainとwatermarkを再取得、unknown write再送禁止 |
| R3 | migration backup後・schema commit前にrestart | backup/receipt/schemaを検査し二重migration禁止 |
| R4 | pointer rename後・activation commit前にrestart | pointer、receipt、health、sessionを照合し推定で再起動しない |
| N1 | terminal jobだがnotification event欠損 | 自動event生成なし、`needs_review` |
| N2 | 投稿応答不明だがexact markerあり | 既送信としてreceiptを確定、再投稿なし |
| N3 | 投稿応答不明でmarkerなし/old thread | 通知抑止、operator判断待ち |
| N4 | group attention未解決、全sibling terminal | all-terminal抑止、sessionをactiveへ戻さない |
| N5 | attention解決済み、全sibling terminal | 保存済みall-terminal eventだけ一度処理 |
| M1 | migration前、旧schemaでrollback | 旧SHA/schema healthとreceiptを検証して復帰可 |
| M2 | migration後、旧releaseは新schema非互換 | 検証済みsnapshot復元と外部receipt照合なしではrollback禁止 |
| M3 | migration後、新epochでprovider write確定 | snapshot復元でもwriteを未実行扱いせずreconcile |
| C1 | terminal Result済み、通知未settle | release/Result/snapshot GC禁止 |
