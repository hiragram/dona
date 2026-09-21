# agent read認可・開示境界

## 適用範囲

agent socketからの`list_event_jobs`、`list_thread_jobs`、`list_owner_jobs`、`get_job_status`は、transport認証だけではjobを返さない。各候補を`AgentReadAuthorization`へ渡し、次の順で判定した後に明示allowlist projectionを組み立てる。

1. current agent contextのverified human principalと、job作成時のimmutable authorization bindingを照合する。
2. tenant/workspace、owner kind、policy revision、job/source event identityを照合する。
3. operationごとのtyped grant portを判定する。
4. 元の開示先とcurrent eventの開示先をcurrent visibility portで判定する。

grant portとvisibility portは未接続時に必ずdenyする。job ID、thread/channel ID、保存済み`actor_id`、同じowner文字列だけでは許可しない。provider確認を行う後続実装が接続されるまで、human向けreadはsafe-offである。

read grant operationは`read_own_human_waits`、`read_exact_job_status`、`read_bounded_result`、`resolve_origin_ref`のtyped catalogから選ぶ。既存4 surfaceはjobごとの`read_exact_job_status`として判定し、surface名をgrant operationとして流用しない。別operationの権限を推論せず、wait queryとbounded Resultはそれぞれの後続Issueが接続する。

## authorityとdisclosure

policy decisionは`authority`と`disclosure`を別fieldに保持する。authorityが許可されてもvisibilityが確認できなければ外部へ返さない。private originから別channelへの開示をprincipal一致だけで許可しない。

deny理由はrestricted audit portにdecision codeだけを渡す。objective、Result、自由文error、destination本文、credentialをauditへ渡さない。public APIは不可視jobと不存在jobを同じ`404 not_available`へ縮退し、listでは認可後の要素だけから件数と`truncated`を計算する。

## projection inventory

| surface | human command | job completion purpose |
| --- | --- | --- |
| `list_event_jobs` | job単位の共通認可後、status/receiptのallowlistだけ | 関連source eventへ限定した専用completion projection |
| `list_thread_jobs` | current eventのreply target完全一致かつjob単位の共通認可 | purpose allowlistでroute拒否 |
| `list_owner_jobs` | durable owner候補を取得後にjob単位でfilter-after-auth | purpose allowlistでroute拒否 |
| `get_job_status` | owner照合と共通認可後、status/receiptのallowlistだけ | notification owner照合後の専用completion projection |

どのprojectionも`result_json`、objective、自由文error、workspace/result path、runtime identityを含めない。bounded Result本文の開示はIssue #171、grant付きdiscoveryは#167/#169、owner wait queryは#245の責務である。

管理socketはworker/supervisor内部契約を維持し、このagent向けprojectionへ自動変換しない。agent credentialから管理socketへ到達できることを意味しない。

## 検証境界

fake grant/visibility portとisolated DBでprincipal/workspace/channel、unknown owner、policy revision、restart、visibility変化、不可視/不存在の同形応答、private canary非開示を検証する。production provider接続、live Slack、production activationは行わない。
