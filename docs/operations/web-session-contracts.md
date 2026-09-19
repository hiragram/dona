# Web session・route・context契約

Dispatcherの監査付き保存部品は [Web認証状態の保存](web-auth-storage.md) を参照する。

[#141](https://github.com/hiragram/dona/issues/141)の部分実装。[採用ADR](../adr/0002-web-trust-boundary.md)のruntime接続に向けた、BFF側の検証部品を定義する。listener、Dispatcherの権限正本、監査付き保存、one-use consumeはまだ接続していない。

sessionは同じinstance/tenantのcurrent registryとruntime generationへ照合し、principal revoke、identity/authz revision、session state、BFF generationの不一致を拒否する。絶対8時間、idle 30分、access token期限を上限とし、時刻巻戻りを拒否する。roleとscopeは明示した組合せだけを許す。scope eligibilityだけでowner/grantやsupervisor bindingを認可しない。SSE・自動poll・内部再認可はactivityを更新しない。

ingress contextは用途別keyのHMAC、codec version、固定audienceを使い、principal/session/revoke/revision/BFF世代、method、固定route ID、resource kindとID、body digest、発行時刻、最大10秒の期限、256-bit nonceを結ぶ。両peerは実際のraw request targetとbodyから独立してbindingを導出する。動的routeのresource省略・kind不一致、静的routeへのresource追加を拒否する。session期限を越えず、keyの90日以内のsigning期限・verification-only・revokedを区別する。署名はcurrent registryや一回使用の証明ではない。Dispatcher側の実装では、双方で同じwire contractを検証し、current resource認可とnonce consumeを業務判断と同じ共通監査transactionへ結ぶ必要がある。

routeはraw request targetをURL正規化前に照合し、encoded path、dot segment、fragment、未定義method、callback以外のqueryを拒否する。local logout・local CSRF・logout状態確認だけをIdP不要のlocal session gateへ限定する。cookie/Origin/Fetch Metadataと、logout時のCSRF検証は引き続き必須である。approval decisionは独立step-upを必要とする。route descriptorは認可結果ではなく、未実装capabilityを有効にしない。

callback parserは重複field、malformed encoding、code/error混在、issuer不一致を拒否する。providerのerror説明やURLは結果へ返さない。cookie-bound loginの監査付き一回消費とsecret削除を確定してから、既存OIDC protocolのtoken交換を一度だけ呼ぶ接続が必要である。

既存30件に23件のunit testを加えた53件を検証対象とする。実IdP、実WebAuthn、browser、productionの証拠ではなく、#141のwhole completionを主張しない。
