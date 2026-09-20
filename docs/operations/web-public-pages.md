# publicなログイン画面と完了案内

`WebPublicPages`は固定の`GET /login`、`GET /login/complete`、`GET /assets/login.js`だけを返す。private sessionやDB、IdP、監査repositoryへの接続を持たず、cookieの有無・内容で表示を変えない。Host・transport・Origin・空bodyは検証し、private routeや任意fileへ一般化しない。

## ログイン開始

ログイン画面は初回表示だけではAPIを呼ばない。利用者がボタンを押した時だけ、same-originのCSRF準備とlogin開始の2つのPOSTを順に送る。cookieはbrowserがsame-origin credentialとして扱い、CSRFはcustom headerへ付ける。no-store・no-referrer、redirect拒否、10秒の操作期限、16KiBの応答上限を設ける。

返されたauthorization URLは、固定policyのHTTPS endpoint、client、redirect URI、code flow、scope、PKCE方式と固定param集合を再照合してから同じtabを移動する。任意のreturn URL、未知param、別originへの誘導を採用しない。CSRFやauthorization URLをDOM、localStorage、sessionStorage、IndexedDBへ保存しない。

処理中はボタンを無効にし、結果不明は日本語のstatus領域へ表示する。自動再POSTは行わず、利用者の明示的な「新しくログインを始める」だけを受け付ける。pagehideでpending fetchを中断し、bfcacheから戻った場合もpublicな操作状態だけを戻す。復帰時にAPIを自動実行しない。

## 完了案内

callbackの遷移先`/login/complete`にはscript、session確認、bootstrap、自動redirectを含めない。認証成功やprincipalを推測せず、アカウント確認後の案内と固定same-origin dashboard linkだけを表示する。利用者がlinkを選ぶ新しいnavigationから、Strict session cookieを使う後続の確認へ進む。

全HTML・script・errorにno-storeとno-referrerを付ける。CSSとlogin scriptの内容はSHA-256でCSPへ結合し、external scriptには同じSRIを付ける。完了案内のscript/connectはnoneであり、外部font・image・第三者scriptを追加しない。

## 表示と操作の方針

system font、明確な見出し、一つの主操作、16px相当以上の本文を基本にする。本文・ボタン等の文字サイズはremで指定し、設定による拡大を受け入れる。light配色を明示し、normal textのcontrastは4.5:1以上、keyboard focusは3px outline、主操作の高さは44px以上とする。処理や失敗は色だけでなく文で伝える。画面の動きは設けない。

ui-ux-pro-maxのアクセシビリティ指針を使用した。検索が返したlanding page構成は認証画面に適合しないため採用せず、単一の操作を中心とした一般的なフォーム配置を使った。

## 検証の実行

Web unit/typecheck/build、共有repositoryとの結合検証、browser fixtureは`npm run verify:web`で実行する。browser依存は`@playwright/test` 1.63.0へ固定し、CIではそのversionが指定するChromiumを使う。

```sh
npm ci --prefix sources/web
npm ci --prefix dispatcher
cd sources/web
npx --no-install playwright install chromium
cd ../..
npm run verify:web
```

macOSで既存のChromeを使う場合は、固定の`DONA_WEB_TEST_BROWSER=chrome`だけを選べる。任意実行fileやprofile pathは受け付けず、test用の独立browser contextを作る。

```sh
DONA_WEB_TEST_BROWSER=chrome npm run verify:web
```

browser fixtureは完了案内のAPIゼロ・手動link、click起点の2POST、連打防止、pagehide中断、応答喪失・任意redirect・cache誤設定・oversize応答の拒否、375px・横向き・desktop・200%文字拡大・keyboard focusを検証する。ネットワークはすべてfixtureで応答し、想定外の宛先を拒否する。ブラウザを動かしたUI証拠であり、実TLS・IdP・BFF session発行・OS保護storeのE2Eではない。実SQLite/監査/UDS/BFF接続は別の結合testが扱う。

[Playwrightのbrowser選択](https://playwright.dev/docs/browsers)と[network routing](https://playwright.dev/docs/network)に従う。CIのbrowser installは一時runner上だけで行い、productionへ導入しない。

TLS/proxy listenerによるcontroller統合、認証済みdashboard、activityの監査更新、local二者provisioning、native保護brokerとruntime/release接続は残る。この表示層だけでIssue #141やEpic #139を完了扱いしない。
