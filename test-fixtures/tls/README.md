# 合成loopback TLS fixture

このディレクトリの秘密鍵と証明書はテスト専用に生成した公開fixtureで、実credentialではない。運用・配備・OS trustへの登録に使用しない。テストclientが明示的な`ca`として読み、localhostへの実TLS接続だけを検証する。

通常の証明書はP-256、CA:FALSE、serverAuth、SANにlocalhost/127.0.0.1/::1を含む。期間は2026-09-01〜2036-09-01で、固定fixture保護時刻と現在のclient TLS検証を両立する。wrong-name証明書はCNがlocalhostでもSANがexample.invalidなので、CN fallbackなしの拒否を確認する。

OpenSSL 3.6.2で合成鍵を生成し、固定拡張と期間を指定して自己署名した。証明書を信頼する操作はテストclientのみに限定し、実IdP、OS credential store、browser trustは操作していない。
