# 共有approval基盤の統合由来

このPRは`feature/web-adapter-dashboard`で完了したIssue #16の共有基盤を、`integration/issue-26-supervisor-approval`へ供給する。Issue #17のbinding実装や完了を意味しない。

## 移植方法

PR #157・#158と後続の承認PRはWeb featureへのmerge commitであり、feature branchにはWeb adapter・UI・SSEなどが混在する。merge commitのcherry-pickでは無関係な差分と親履歴を安全に分離できないため、同branchの承認・共通監査・native・payload backup境界の最終treeから差分を再構成した。testではWeb認証fixtureへの依存を共通承認fixtureへ切り出し、Web adapter sourceを持ち込まず個別processで実行する。

## 由来commit

以下は対象source pathに関わるfeature branchのfirst-parent統合履歴である。PR #157・#158の元commitはそれぞれPRのcommits欄で確認できる。

- `d496e78 Merge pull request #227 from hiragram/dona/job_01m2wg5mnxzzmqvvf2ms1hfeat-approval-notification-lifecycle`
- `e3c902d 承認実行の開始と復旧をfeatureへ統合する (#226)`
- `f1684eb 承認metadata読取のSQL文再利用をfeatureへ統合する (#225)`
- `71b4bc6 実行attempt markerの監査保存をfeatureへ統合する (#224)`
- `09965e1 承認のone-shot consumeとpayload移動をfeatureへ統合する (#223)`
- `389ee6c 承認decisionと取消・期限切れをfeatureへ統合する (#222)`
- `4132d10 承認request作成と通知outboxをfeatureへ統合する (#221)`
- `4623342 承認clock履歴の監査接続をfeatureへ統合する (#219)`
- `c14f37d 承認の同一transaction読取をfeatureへ統合する (#218)`
- `15fdc69 承認payload保存と監査接続をfeatureへ統合する (#217)`
- `c11ddb0 承認payload metadata codecをfeatureへ統合する (#216)`
- `909bb04 承認payload保存schemaとbackup除外をfeatureへ統合する (#214)`
- `aa37208 承認本文HMACとpayload暗号化をfeatureへ統合する (#213)`
- `14c525e 承認recordの固定aliasと一覧読取をfeatureへ統合する (#212)`
- `f93160b 承認recordとalias・一覧の一括更新をfeatureへ統合する (#209)`
- `8ad13ea 承認recordのSQL保存と監査付き読取をfeatureへ統合する (#208)`
- `bc20c8a 承認metadataの複数point更新をfeatureへ統合する (#207)`
- `61a3b00 承認indexの同一DB保存層をfeatureへ統合する (#206)`
- `e8a3aed 承認recordのcanonical codecをfeatureへ統合する (#205)`
- `995e65d 承認metadataの同一DB保存とmigrationをfeatureへ統合する (#202)`
- `f4bd25c 承認レコードのdigest treeをfeatureへ統合する (#201)`
- `63afdb0 保護headと使用済みIDのadapterをfeatureへ統合する (#194)`
- `5e725b1 使用済みtransaction IDの検証をfeatureへ統合する (#192)`
- `2bf3006 内部Keychain CAS libraryをfeatureへ統合する (#191)`
- `7b2d117 Web sessionとcontextの監査照合をfeatureへ統合する (#190)`
- `c0e3f46 OS clockの観測sourceをfeatureへ統合する (#189)`
- `2810c34 複数状態rootの共通監査をfeatureへ統合する (#188)`
- `3687cee Web認証状態の監査付き保存層をfeatureへ統合する (#187)`
- `9f09d58 状態digestとretention checkpointをfeatureへ統合する (#186)`
- `7d0c689 監査付き業務更新の事前判定をfeatureへ統合する (#184)`
- `e851573 承認のSQLite制約とtransaction境界をWeb featureへ統合する (#158)`
- `caaf454 承認の共通部品をWeb featureへ統合する (#157)`
- `3591ad7 共通監査基盤をWeb featureへ統合する (#156)`

## 取り込んだファイル

以下はこのPRの変更ファイルの完全な一覧である。この文書自身は一覧から除く。

- `dispatcher/package.json`
- `dispatcher/scripts/build-security-clock.mjs`
- `dispatcher/scripts/build-security-keychain-cas.mjs`
- `dispatcher/scripts/build-security-native.mjs`
- `dispatcher/scripts/build-sqlite-identity.mjs`
- `dispatcher/src/approval/channel.ts`
- `dispatcher/src/approval/clock-history.ts`
- `dispatcher/src/approval/clock-provenance.ts`
- `dispatcher/src/approval/clock.ts`
- `dispatcher/src/approval/consume-broker.ts`
- `dispatcher/src/approval/create-broker.ts`
- `dispatcher/src/approval/decision-broker.ts`
- `dispatcher/src/approval/domain.ts`
- `dispatcher/src/approval/execution-authority.ts`
- `dispatcher/src/approval/execution-broker.ts`
- `dispatcher/src/approval/execution-marker-store.ts`
- `dispatcher/src/approval/execution-marker.ts`
- `dispatcher/src/approval/history-transaction.ts`
- `dispatcher/src/approval/index-codec.ts`
- `dispatcher/src/approval/index-list.ts`
- `dispatcher/src/approval/index-store.ts`
- `dispatcher/src/approval/keychain-cas.ts`
- `dispatcher/src/approval/metadata-plan-store.ts`
- `dispatcher/src/approval/metadata-plan.ts`
- `dispatcher/src/approval/metadata-store.ts`
- `dispatcher/src/approval/metadata-tree.ts`
- `dispatcher/src/approval/native-clock.ts`
- `dispatcher/src/approval/notification-authority.ts`
- `dispatcher/src/approval/notification-broker.ts`
- `dispatcher/src/approval/notification-marker.ts`
- `dispatcher/src/approval/payload-metadata.ts`
- `dispatcher/src/approval/payload-mutation.ts`
- `dispatcher/src/approval/payload-protection.ts`
- `dispatcher/src/approval/payload-repository.ts`
- `dispatcher/src/approval/payload-sql.ts`
- `dispatcher/src/approval/protected-heads.ts`
- `dispatcher/src/approval/record-codec.ts`
- `dispatcher/src/approval/record-indexes.ts`
- `dispatcher/src/approval/record-mutation.ts`
- `dispatcher/src/approval/record-relations.ts`
- `dispatcher/src/approval/record-repository.ts`
- `dispatcher/src/approval/record-sql.ts`
- `dispatcher/src/approval/request-lifecycle.ts`
- `dispatcher/src/approval/schema.ts`
- `dispatcher/src/approval/snapshot.ts`
- `dispatcher/src/approval/transaction.ts`
- `dispatcher/src/approval/used-transaction-store.ts`
- `dispatcher/src/approval/used-transactions.ts`
- `dispatcher/src/audit/codec.ts`
- `dispatcher/src/audit/coordination.ts`
- `dispatcher/src/audit/durability.ts`
- `dispatcher/src/audit/file-identity.ts`
- `dispatcher/src/audit/repository.ts`
- `dispatcher/src/audit/synchronous.ts`
- `dispatcher/src/native/file-identity.c`
- `dispatcher/src/native/security-clock.c`
- `dispatcher/src/native/security-keychain-cas.h`
- `dispatcher/src/native/security-keychain-cas.m`
- `dispatcher/src/payload-backup-boundary.ts`
- `dispatcher/test/approval/clock-history.ts`
- `dispatcher/test/approval/clock.ts`
- `dispatcher/test/approval/consume-broker.ts`
- `dispatcher/test/approval/consume-concurrency.ts`
- `dispatcher/test/approval/create-broker.ts`
- `dispatcher/test/approval/decision-broker.ts`
- `dispatcher/test/approval/domain.ts`
- `dispatcher/test/approval/execution-broker.ts`
- `dispatcher/test/approval/execution-marker-store.ts`
- `dispatcher/test/approval/execution-marker.ts`
- `dispatcher/test/approval/fixtures/broker.ts`
- `dispatcher/test/approval/fixtures/consume-authority.ts`
- `dispatcher/test/approval/fixtures/consume-heads.ts`
- `dispatcher/test/approval/fixtures/consume-process.ts`
- `dispatcher/test/approval/fixtures/coordination-crash.mjs`
- `dispatcher/test/approval/fixtures/coordination-hold.mjs`
- `dispatcher/test/approval/fixtures/coordination-publication-crash.mjs`
- `dispatcher/test/approval/fixtures/decision.ts`
- `dispatcher/test/approval/fixtures/execution.ts`
- `dispatcher/test/approval/fixtures/keychain-cas-main.m`
- `dispatcher/test/approval/fixtures/keychain-cas-mock.m`
- `dispatcher/test/approval/fixtures/notification.ts`
- `dispatcher/test/approval/fixtures/records.ts`
- `dispatcher/test/approval/fixtures/storage.ts`
- `dispatcher/test/approval/fixtures/transaction-store.ts`
- `dispatcher/test/approval/fixtures/transaction-worker.mjs`
- `dispatcher/test/approval/fixtures/transaction-worker.ts`
- `dispatcher/test/approval/index-codec.ts`
- `dispatcher/test/approval/index-store.ts`
- `dispatcher/test/approval/keychain-cas.ts`
- `dispatcher/test/approval/metadata-plan.ts`
- `dispatcher/test/approval/metadata-store.ts`
- `dispatcher/test/approval/metadata-tree.ts`
- `dispatcher/test/approval/native-clock.ts`
- `dispatcher/test/approval/native-keychain-cas.ts`
- `dispatcher/test/approval/notification-broker.ts`
- `dispatcher/test/approval/notification-marker.ts`
- `dispatcher/test/approval/payload-metadata.ts`
- `dispatcher/test/approval/payload-protection.ts`
- `dispatcher/test/approval/payload-repository.ts`
- `dispatcher/test/approval/protected-heads.ts`
- `dispatcher/test/approval/record-codec.ts`
- `dispatcher/test/approval/record-mutation.ts`
- `dispatcher/test/approval/record-repository.ts`
- `dispatcher/test/approval/schema.ts`
- `dispatcher/test/approval/snapshot.ts`
- `dispatcher/test/approval/transaction.ts`
- `dispatcher/test/approval/used-transactions.ts`
- `dispatcher/test/audit/codec.ts`
- `dispatcher/test/audit/repository.ts`
- `dispatcher/test/audit/synchronous-types.ts`
- `dispatcher/test/run-tests.mjs`
- `docs/operations/approval-clock-history.md`
- `docs/operations/approval-consume.md`
- `docs/operations/approval-decisions.md`
- `docs/operations/approval-execution-lifecycle.md`
- `docs/operations/approval-execution-marker.md`
- `docs/operations/approval-foundation.md`
- `docs/operations/approval-metadata-plan.md`
- `docs/operations/approval-metadata-store.md`
- `docs/operations/approval-metadata-tree.md`
- `docs/operations/approval-notification-lifecycle.md`
- `docs/operations/approval-payload-metadata.md`
- `docs/operations/approval-payload-protection.md`
- `docs/operations/approval-payload-repository.md`
- `docs/operations/approval-payload-storage.md`
- `docs/operations/approval-record-codec.md`
- `docs/operations/approval-record-index.md`
- `docs/operations/approval-record-mutation.md`
- `docs/operations/approval-record-queries.md`
- `docs/operations/approval-record-repository.md`
- `docs/operations/approval-request-create.md`
- `docs/operations/approval-storage-foundation.md`
- `docs/operations/approval-transaction-reads.md`
- `docs/operations/shared-audit-foundation.md`

## 除外範囲

Web adapter・UI・SSE・dashboard presentation、Issue #17のsupervisor binding/bootstrap/rotation/revoke/break-glass、Issue #18以降の実装、runtimeでの承認API接続、production activationは含めない。共有audit codecの既存Web operation定義は共通監査schemaの直接依存として保持する。
