# job authorization binding運用契約

## 永続snapshot

新しいjobは`jobs`、`job_owner_bindings`、`job_authorization_bindings`を同じSQLite transactionで作成する。authorization bindingは次を作成時snapshotとして保持し、後からactor文字列やjob IDから補完しない。

- verified human principal bindingへのevent参照とingress proof digest
- tenant/workspaceとprincipal kind/ID
- eventに固定されたdisclosure origin
- providerが検証したGitHub repository/Issue node IDとresource revision
- policy revision、job binding revision、task binding revision

Slack threadはrouting destinationでありhuman principalではない。scheduleは`owner_kind=schedule`かつ`resource_kind=schedule_run`として保存し、owner文字列をhuman principalへ変換しない。taskがない通常jobと移行前jobは`resource_kind=unknown`、principal proofがない旧jobは`owner_kind=unknown`である。

## exact taskの設定

`JobAuthorizationBindingRepository.bindEventTask`は外部provider verifierを必須とする。verifierはcurrent accessと`bind_exact_task` permissionを確認し、自由文URLやtitleではなくGitHub repository node ID、Issue node ID、number、参照時resource revisionを返す。binding側は次を再検証する。

- authorization principal eventと対象source eventが同一である
- durable verified principal bindingのtenant/workspace/principalがprovider evidenceと一致し、revokedでない
- evidenceの検証時刻とexclusive expiryがcurrent timeに有効である
- 初回はexpected binding revision 0、更新はcurrent revisionとのCASである
- 同じrepository/Issueだけを新しいresource revisionへ進め、別task、巻戻り、stale CASを拒否する

同一evidenceのretryはread-backとして同じrowを返す。異なるwriteはPR #156の共有`AuditRepository`へ`binding_change`をappendし、DB外CAS anchorのreserve/finalizeと同じtransaction境界でtask bindingを更新する。reserve、commit、finalizeの応答が不明な場合はblind retryせず、共有auditのread-only reconciliation手順に従う。

## migrationと非検証境界

schema migrationは既存jobを明示的な`unknown`として追加し、`jobs.actor_id`、thread owner、objective、URLからprincipal/taskをbackfillしない。FK、immutable job snapshot、CAS indexは再起動後も維持する。

この実装はfake/injected provider verifierとisolated DB/CASで検証する。GitHub live permission、production credential、DB外anchorのproduction provisioning、production activationはこのIssueでは実施しない。
