# Google Drive changes.watch pilot運用

このpilotはdedicated test accountのread-only connectionと、固定したfile・folder・shared drive allowlistだけを対象にする。Google Workspace Events API、Drive contentへのwrite、全組織rolloutは対象外である。

## 安全境界

- OAuth scopeは`https://www.googleapis.com/auth/drive.metadata.readonly`を基本とし、content取得が必要な別要件なしに`drive` scopeへ広げない。
- `X-Goog-Channel-ID`、`X-Goog-Channel-Token`、`X-Goog-Resource-ID`を保存済みgenerationへ照合する。token、credential、page tokenはlog、Result、healthへ出さない。
- push bodyは空である。`sync`はwatch handshakeのcontrol notificationとして扱い、business eventを作らない。message numberは増加するが連番とは仮定せず、gapだけで通知欠落と判定しない。
- notification後とperiodic reconciliationの両方で保存済みpage tokenから`changes.list`を全page drainする。全eventと`newStartPageToken`を同じDB transactionでcommitし、partial pageや429/5xxではcursorを進めない。
- cursor無効・期限切れでは現在tokenへblind jumpしない。connectionをdegraded/needs-reviewとして隔離し、allowlistを用いたbounded reconciliationを人間が判断する。

## watch・renew・reconcile

`changes.watch`のexpirationは作成時に明示し、7日以下に制限する。expiry windowへ入ったらunique channel ID/tokenで新generationを1件だけ作る。create response lossはoperation receipt/lookupで照合し、blind createしない。old/new overlap中はcanonical change identityでduplicateを収束させ、新generationの検証後だけ旧channelをstop候補にする。stop response lossもread-only照合へ送り、blind stopしない。

periodic reconciliationはprovider cursor lifecycleのwakeとして実行し、scheduler scheduleを正本にしない。healthではsecretなしにconnection state、cursor version/age、channel expiry、last delivery/reconcile、renew operation stateを確認する。

## live smoke（別途明示承認が必要）

1. dedicated test Drive connectionと1件のallowlisted fileを準備し、read-only credential referenceを登録する。
2. 公開HTTPS callbackへwatch channelを作成し、`sync`がbusiness eventを作らないことを確認する。
3. allowlisted fileを1回変更し、push header、`changes.list`、Dispatcher receipt、checkpointを照合する。
4. 短いexpirationの新generationを作り、overlap duplicate、cutover、旧channel停止候補を確認する。
5. pushを遮断した状態でperiodic reconciliationだけにより同じchangeが回収されることを確認する。

channel作成・更新・停止とtest file変更は外部writeであるため、この手順を実行する担当者の明示承認なしには行わない。
