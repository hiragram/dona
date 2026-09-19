# 承認・Web共通監査基盤の実装境界

この基盤は [#16](https://github.com/hiragram/dona/issues/16) の一部であり、[採用済みWeb ADR](../adr/0002-web-trust-boundary.md) が要求する共有chainのcodecを提供する。参照する承認契約は [PR #126 の exact head](https://github.com/hiragram/dona/blob/0c4a1a451cbeb6962da1d49033948e6fd0f57c46/docs/adr/0001-supervisor-approval.md) で、#15の採用・担当・branchを変更するものではない。採用版が変われば整合性を再reviewする。

## 実装済み

`dispatcher/src/audit/codec.ts` はversion 1のstrict schema、辞書順のcanonical JSON、SHA-256 record digest、用途分離したHMAC-SHA-256、sequenceとprevious MACによるchain検証を所有する。未知field、未知codec、曖昧な日時・整数、任意本文・URL・path用のfieldを受け付けない。actor、scope、session、resource、receipt、attemptとrevisionは、呼出側が認証済みの永続identityから供給する。opaque IDの文字列検査だけでは出所を証明できないため、client申告を転記しない。

通常の読取でもrestore時でも、`verifyAuditChain`へ署名済みgenesisまたはretention checkpoint、以降の全record、DB/backup外の保護storeから取得したfresh anchorを渡す。chain ID、checkpoint MAC、末尾sequence/MACと全recordを検証し、欠落・並替え・時刻巻戻り・未finalize reservation・不一致を拒否する。DB内のanchorや過去のcacheをtrust rootとして渡してはならない。

signing keyの有効期間は最大90日で、用途・version・鍵長とrecord時刻を検証する。rotation後のverification-only keyでは新規署名しない。検証はretained recordの古い鍵を必要とし、鍵の欠落・revoked・用途違い・provider例外では共通のredacted errorを返す。秘密鍵をDBへ保存したり、既存recordを新しい鍵で再署名したりしない。

checkpointは最後に削除するrecordのsequence、MAC、時刻と署名時刻を含む。checkpointへ署名するだけではretentionや初期化を許可しない。外部anchorと一致したcheckpointだけを検証の起点として受け付ける。

## 未接続と完了条件

この段階ではservice/APIへのruntime接続、DB schema変更、実credentialの作成、auditの独自代替sequence、production activationは行っていない。codecの成功はsecurity decisionや外部writeを許可する証拠ではない。

#16の残作業はSQLite repository/domain、request・decision・consume・attemptの別record、暗号化payload lifecycle、typed outbox、protected clock、DB外CAS anchorのreserve・DB commit・finalize、400日retentionとcheckpoint削除順、restart/restore/競合testである。共通primitiveを組み合わせる際は次を満たす必要がある。

- DB外storeはrollback-resistantでintegrity保護された原子的CASを提供し、鍵はDB/backupと分離する。通常fileのrenameやmemory fixtureを本番実装の代用にしない。
- audit appendとsecurity decisionを同じSQLite transactionで行い、append失敗ではdecisionをcommitしない。DB commit後のfinalize失敗は未検証として以後のsecurity decisionを停止し、成功responseを返さない。
- retentionはsigned checkpointと外部anchorを確定した後だけ旧recordを削除し、verification keyは最後のrecordの400日保持とbackup expiryの両方が終わるまで保護保持する。
- clock、binding/policy generation、payloadのrestore整合性は専用の保護contractで検証する。audit codecだけでそれらのcontinuityを保証したとみなさない。

#141のWeb認証と#145のapproval接続は、この共有基盤の完成と対応するruntime gateを必要とする。unit fixtureは実IdP、WebAuthn、browser、credential store、productionの実証とは区別する。
