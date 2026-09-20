# 承認本文のHMACと暗号化payload

`payload-protection.ts`は、共通承認基盤の本文bindingと暗号化表現を扱う内部codecである。SQL、actor認可、監査root、実providerの検証を代行しない。呼出し元は、現在rootで確認したrequest/attemptと保護clockのmark、OS credential storeの用途別keyを取得してから使う。

## 本文binding

HMAC-SHA256には固定version、key version、instance/workspace、`draft`または`thread_message`の用途とexact UTF-8 bytesを含める。本文のraw SHA-256は返さない。作成はactive keyだけを許し、既存bindingの検証では保存済みkey versionと署名時刻を確認する。thread messageの空本文は扱えるが、draftの空本文は拒否する。snapshotのsemantic hashは既存codecでtarget/source/policy/preconditionとこのMACを結合する。

署名時刻はMACそのものへ含めず、同じkey・scope・用途・本文のMACを安定させる。時刻はrequestの監査された作成時刻と照合する必要があり、単独のcontent bindingを時刻証明にしてはいけない。旧recordを別keyで暗黙にre-MACしない。

## 暗号化表現

本文ごとに内部で新しい256bit DEKを生成し、AES-256-GCM、ランダム96bit nonce、128bit tagを使う。DEKは別用途の256bit KEKでRFC3394 AES-KWし、payloadにはwrapped keyだけを保存する。固定wrap IVはRFC3394の定数であり、GCM nonceへ流用しない。GCM用DEKは各sealで一回だけ使用する。callerにalgorithm、nonce、DEKを選ばせない。

AADはversion/algorithm/KEK version/sealed time/wrapped keyと、次のowner情報を固定順序で結合する。

- instance/workspace、requestまたはattemptの種別とowner ID、request ID
- semantic hash、opaque payload ref
- content MAC/key version/署名時刻
- 作成時刻と保持上限

requestからattemptへ移す場合は、別owner・payload refで再暗号化し、新しいDEKを割り当てる。旧暗号文をそのままattemptへ流用すると復号に失敗する。移動がcommitしたことや旧payloadが削除されたことをcodecの成功から推測しない。

request payloadの暗号化保持上限は作成から最大20分（request 15分とconsume 5分の和）、attemptはclaimから最大24時間である。これは最大保持時間であり、request/decision/consumeの操作可能TTLではない。実際のrequest期限、approved後のconsume期限、terminal/invalid state、current authorizationはbrokerが毎回検証する。期限到達、作成/暗号化時刻より前の読取時刻、読取時刻より未来の暗号化時刻をcodecでも拒否する。呼出し間の時計の巻戻り検出、DBの削除、clock sourceの真正性は保護clockと上位のtransactionが担当する。

## keyと入力境界

`approval_content`と`approval_payload_wrap`を分離し、同じkey bytesの流用を拒否する。新規MAC/wrapはactiveで90日以内のsigning windowにあるkeyのみ、verification-onlyは既存の検証/unwrapのみを許す。revoked、用途違い、version不一致、key欠落、期間不正は安全な固定errorになる。保護storeのアクセス制御、rotation、400日とbackup expiryに沿う検証key保持は別のlifecycleで実装する。

本文は最大256 KiBのvalid UTF-8。BOMを含めexact bytesを保持し、正規化や本文修正をしない。plain_text表示、mention/secret/private URLのadmission、操作別の上限は上位のpolicy/gatewayが担当し、このcodecを内容の安全判定に使わない。

復号はunwrap、GCM final、本文HMACが全て成功するまで文字列を返さない。中間のplaintextとDEK Bufferはfinallyでzero化する。JavaScript文字列、暗号ライブラリ内部、OS memory全体の完全消去は保証しない。codecの戻り値を監査event、ログ、無認可のWeb/Slack出力へ転記しない。

## 検証と残る接続

独立したPython標準HMACの期待値、RFC3394公開vectorとWebCryptoで生成したGCM暗号文との相互運用、field/owner/scope/本文改変、key状態/用途、UTF-8/byte上限、request/attempt保持期限、再暗号化をfixtureで検証する。fixture keyは実credentialではなく、OS storeやproductionの証拠ではない。

同一SQLite transactionでのrequest payload削除・attemptへの移動・terminal削除、backup除外、restore時のneeds_review、expiry sweep、認可付きbroker、protected provider/runtimeは継続する。既存のSQLite全体backupへpayload tableを追加せず、WALのATTACH複数DBをatomic commitの代替にしない。#16やEpic #139をこのcodecだけで完了扱いにしない。

一次資料: [Node 24.4 crypto](https://nodejs.org/download/release/v24.4.0/docs/api/crypto.html)、[NIST SP800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)、[RFC3394](https://www.rfc-editor.org/rfc/rfc3394.html)、[OpenSSL AES cipher](https://docs.openssl.org/3.5/man3/EVP_aes_128_gcm/)。暗号primitiveはNode/OpenSSLを使い、独自実装しない。
