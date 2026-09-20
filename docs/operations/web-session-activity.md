# dashboard画面遷移のsession activity

認証済みの`GET /`について、BFFが`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document`、`Sec-Fetch-User: ?1`をすべて一意に確認した場合だけ、session確認へ`user_navigation: true`を付ける。既存のTLS分類、固定Host、`Sec-Fetch-Site: same-origin`、Origin照合、空body、cookie、fresh IdP照合と現行registryの条件も維持する。

この組合せは[Fetch Metadataの同一originリンク遷移の例](https://www.w3.org/TR/fetch-metadata/#examples)に基づく分類である。headerだけを認証や人間の暗号学的な証明に使わない。native clientはheaderを構成できるため、session保護・IdP照合・現行世代・絶対期限・approvalのstep-upを代替しない。直接URL入力など`Sec-Fetch-Site: none`の扱いも広げず、公開login完了画面の手動リンクから同一origin遷移する。

## BFFから監査確定まで

BFFはbrowserのJSONや独自activity headerを転送せず、固定routeとFetch Metadataから属性を作る。専用service credentialがcanonical body全体を署名するため、受信途中の属性追加・削除・変更は拒否する。属性は`true`または省略だけを許し、`/api/session`では`true`を拒否する。省略時の既存version 1 wireは変えない。旧peerは新属性を拒否するため、未対応peerへの暗黙fallbackはしない。

Dispatcherは共通監査rootと保護clockを確認したtransaction内で、context署名・現在のsession/revision・期限・nonceを照合する。navigationの場合だけ`last_activity_at`をその保護時刻へ進め、nonceと同じmetadata commitmentへ記録する。payload bindingやsession絶対期限は変えない。SQL失敗時は両方rollbackし、anchorがpendingまたは応答不明なら成功を返さない。確定後に応答を失った場合もBFFは503とし、cookieを保持して同じwriteを再送しない。

idle 30分以上、絶対8時間上限、access token期限、失効・revision不一致はactivity更新前に拒否する。すでに失効したsessionをnavigationで復活させない。既定の`GET /`、`/api/session`、自動poll、SSE、内部再検証はactivityではない。user commandは各業務gateへの接続時に扱い、汎用heartbeatやtouch endpointは追加しない。

## 検証と残る接続

repository試験でnavigationと既定確認、replay、各期限、失効、SQL失敗・anchor応答喪失を確認する。BFF試験はmode/destination/user属性の欠落・不一致・重複、両peerのcodec試験は固定routeとMAC改変を確認する。実Node TLS・私有UDS・SQLite・native extensionを使う結合試験で、navigation更新とpoll不更新、確定後の応答喪失を確認する。

結合試験の証明書、IdP応答、保護clock・key・anchorはfixtureであり、実IdP/browser/WebAuthn/Keychainやproductionの証拠ではない。認証済みdashboard表示、業務command、local二者provisioning、native保護providerとruntime/release接続は残る。この変更だけでIssue #141やEpic #139を完了扱いしない。
