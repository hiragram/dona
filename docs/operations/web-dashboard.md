# Web dashboard UI

認証済みの`GET /`は、既存のsession確認を通過した場合だけ固定HTML、固定CSS、固定browser scriptを返す。HTML自体へprincipal、CSRF、job、Resultを埋め込まず、browserは`GET /api/session`を再確認してからprivate領域を表示する。sessionやreadに失敗した場合、以前の一覧・詳細を消し、staleなprivate viewへfallbackしない。

## 表示と権限

- `job:submit`があるprincipalだけ依頼formを表示する。
- `job:read:own`または`job:read:granted`があるprincipalだけ一覧・詳細を表示する。
- cancelはread projectionの`control.can_cancel`がtrueのexact jobだけに表示する。ただし表示可否はauthorityではなく、serverがcurrent principal、owner、status、receiptを再検証する。
- objective、Result summary、artifact metadata、errorは`textContent`で挿入し、制御文字とbidi制御文字は可視なUnicode escapeへ置換する。HTML、URL、scriptとして解釈しない。

固定assetはCSPのSHA-256へ結合し、`connect-src 'self'`以外の接続、third-party asset、service worker、localStorage、sessionStorage、IndexedDBを使わない。全responseは既存の`no-store`、`no-referrer`、frame拒否を維持する。

## submitとcancel

browserは操作ごとに256-bitの`request_id`を生成し、session由来CSRFをcustom headerへ付ける。処理中は同じbuttonを無効にし、double clickで追加POSTを送らない。成功表示は署名・検証済みserver receiptをBFFが返した後だけ行う。

timeout、切断、`acceptance_unknown`では同じwriteを自動再送しない。submitはjob一覧、cancelはexact job詳細をread-onlyで再取得し、受付結果が不明であることを表示する。利用者が後から明示的に操作しても、新しい`request_id`になるため、画面上で古いwriteの成功を推測しない。

cancelはnative dialogでexact job IDと影響を確認する。成功したcancel receiptとterminal Resultを混同せず、detail projectionが返すcurrent statusを再取得する。

## durable readと再接続

一覧は最大50件のdurable projectionを表示する。詳細から受け取ったopaque event cursorを`Last-Event-ID`にして、bounded one-shot SSEを`fetch`する。`job`、`heartbeat`、`reset`だけを処理し、disconnect時はstale表示へ切り替えてdetailを再取得する。cursorがretention gapで拒否された場合もdetailから新しいcursorを取得する。SSEやpollはsession activityを延長しない。

URL fragmentは選択中jobのbrowser historyにだけ使用し、server request、authority、cursor、idempotency keyには使わない。back/forwardは一覧と詳細を切り替える。bfcacheからの復帰ではprivate viewを消してcurrent sessionとdurable projectionを再取得する。

## accessibilityとbrowser検証

フォームはvisible labelと関連するhelp/errorを持つ。主操作は44px以上、keyboard focusは3px outline、動的状態はatomicなstatus領域、cancel確認はnative dialogを使う。375px、812px横向き、1280pxで横overflowがないことと、200%文字拡大、keyboard focus、submit/cancelの重複防止、SSE cursor、受理不明時のread-only reconcileをPlaywright fixtureで検証する。

このbrowser fixtureはUI contractの決定的検証であり、live IdP、production TLS、production Dispatcher、production workerのterminal evidenceではない。実SQLite・UDS・BFF接続は`npm run test:web-integration`、production readinessは後続の運用gateで別に確認する。

UI設計には`ui-ux-pro-max`のaccessibility、touch target、responsive、form feedback指針を適用した。
