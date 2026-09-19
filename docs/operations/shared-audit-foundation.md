# 承認・Web共通監査基盤の実装境界

この基盤は [#16](https://github.com/hiragram/dona/issues/16) の一部であり、[採用済みWeb ADR](../adr/0002-web-trust-boundary.md) が要求する共有chainのcodecとSQLite/CAS transaction protocolを提供する。参照する承認契約は [PR #126 の exact head](https://github.com/hiragram/dona/blob/0c4a1a451cbeb6962da1d49033948e6fd0f57c46/docs/adr/0001-supervisor-approval.md) で、#15の採用・担当・branchを変更するものではない。採用版が変われば整合性を再reviewする。

## 実装済み

`dispatcher/src/audit/codec.ts` はversion 1のstrict schema、辞書順のcanonical JSON、SHA-256 record digest、用途分離したHMAC-SHA-256、sequenceとprevious MACによるchain検証を所有する。未知field、未知codec、曖昧な日時・整数、任意本文・URL・path用のfieldを受け付けない。actor、scope、具体的なtyped operation、versioned safe error code、session、resource、receipt、attemptと`authz_revision`等のrevisionは、呼出側が認証済みの永続identityから供給する。opaque IDの文字列検査だけでは出所を証明できないため、client申告を転記しない。

通常の読取でもrestore時でも、`verifyAuditChain`へ署名済みgenesisまたはretention checkpoint、以降の全record、DB/backup外の保護storeから取得したfresh anchorを渡す。chain ID、checkpoint MAC、末尾sequence/MACと全recordを検証し、欠落・並替え・時刻巻戻り・未finalize reservation・不一致を拒否する。DB内のanchorや過去のcacheをtrust rootとして渡してはならない。

signing keyの有効期間は最大90日で、用途・version・鍵長とrecord時刻を検証する。rotation後のverification-only keyでは新規署名しない。検証はretained recordの古い鍵を必要とし、鍵の欠落・revoked・用途違い・provider例外では共通のredacted errorを返す。秘密鍵をDBへ保存したり、既存recordを新しい鍵で再署名したりしない。

checkpointはMAC検証済みの最後に削除するrecordからsequence、MAC、時刻を導出し、署名時刻とtransaction IDを含む。独立した境界時刻・sequence・MACは受け付けない。checkpointへ署名するだけではretentionや初期化を許可しない。外部anchorと一致したcheckpointだけを検証の起点として受け付ける。

`dispatcher/src/audit/repository.ts` は明示的なschema installと、外部storeで事前確定されたgenesisの初期化を提供する。現在のDispatcher serviceは呼び出していない。既存DBの`user_version`を変えず、opt-inの監査schema versionを検査する。unknown/部分schema、初期化済みDBの再初期化は拒否する。runtimeへ接続するPRではDispatcher本体の互換性・migration gateも更新する必要がある。

appendは`BEGIN IMMEDIATE`で直前chainを検証し、外部CAS reserveを確認してからaudit rowと同期SQL callbackを同じDB transactionでcommitする。callbackには同じDB connectionのSQLだけを許可し、外部writeや手動commit、非同期処理を渡さない。commit後はanchorがpendingの間に再びwriter lockを取得し、finalizeと完全read-backまで他writerと直列化する。後続appendによって確定済み操作を失敗扱いせず、検証成功後だけ結果を返す。append/DB commit失敗時は業務更新もrollbackし、外部reservationは自動取消しない。finalize失敗はcommit済みの可能性を保持し、pending中は全検証を拒否する。

retentionは保護clockの有効時刻で400日境界を検査し、checkpointをCAS reserve・DB commit・finalizeした後だけ旧recordを削除する。削除失敗やfinalize応答喪失では旧recordが残り、確定済みanchorをread-onlyで検証できた後に`pruneRetainedPrefix`で明示cleanupできる。未finalize anchorの自動再試行・修復は行わない。

## 未接続と完了条件

この段階ではservice/APIへのruntime接続、既存serviceによるDB migration、実credentialの作成、auditの独自代替sequence、production activationは行っていない。codecの成功はsecurity decisionや外部writeを許可する証拠ではない。

#16の残作業はapproval domain/repository、request・decision・consume・attemptの別record、暗号化payload lifecycle、typed outbox、protected clock、実DB外CAS/key provider、Dispatcher migrationとruntimeへの接続、そのrestart/restore/競合testである。ここで提供するCAS portには本番default実装を置かず、memory fixtureはテスト専用である。共通primitiveを組み合わせる際は次を満たす必要がある。

- DB外storeはrollback-resistantでintegrity保護された原子的CASを提供し、鍵はDB/backupと分離する。通常fileのrenameやmemory fixtureを本番実装の代用にしない。
- audit appendとsecurity decisionを同じSQLite transactionで行い、append失敗ではdecisionをcommitしない。DB commit後のfinalize失敗は未検証として以後のsecurity decisionを停止し、成功responseを返さない。
- retentionはsigned checkpointと外部anchorを確定した後だけ旧recordを削除し、verification keyは最後のrecordの400日保持とbackup expiryの両方が終わるまで保護保持する。
- clock、binding/policy generation、payloadのrestore整合性は専用の保護contractで検証する。audit codecだけでそれらのcontinuityを保証したとみなさない。

#141のWeb認証と#145のapproval接続は、この共有基盤の完成と対応するruntime gateを必要とする。unit fixtureは実IdP、WebAuthn、browser、credential store、productionの実証とは区別する。

監査schemaはversion行だけでなく、table/index/triggerの正規形と関連するTEMP objectも確認する。installerは既存の欠落・未知objectを修復せず、read/append/retentionと業務mutation後にも照合する。DDL自体はversion 1の定義を維持する。
