import { createHash } from "node:crypto";
import { assertBrowserBoundary, privateHeaders, singleHeader } from "./browser.js";
import { parseWebPolicy, type WebPolicy } from "./policy.js";
import type { BrowserAuthRequest } from "./auth-controller.js";
import { authStyles, loginBrowserScript } from "./public-assets.js";

export interface PublicPageResponse { status: 200 | 400 | 404; headers: Record<string, string>; body: string }
const hash = (text: string) => createHash("sha256").update(text).digest("base64");
/** Fixed public assets only. No session/cookie lookup, database, IdP, authority,
 * initialization or listener capability is reachable through this class. */
export class WebPublicPages {
  private readonly policy: WebPolicy;
  private readonly script: string;
  private readonly scriptHash: string;
  private readonly styleHash = hash(authStyles);
  constructor(policy: WebPolicy) {
    this.policy = parseWebPolicy(policy);
    const config = { authorization_endpoint: this.policy.oidc.authorization_endpoint, client_id: this.policy.oidc.client_id,
      redirect_uri: this.policy.oidc.redirect_uri };
    this.script = loginBrowserScript.replace("__DONA_PUBLIC_LOGIN_CONFIG__", () => JSON.stringify(config));
    this.scriptHash = hash(this.script);
  }
  private page(complete: boolean): string {
    const eyebrow = complete ? "ログイン後のご案内" : "ワークスペースに入る";
    const heading = complete ? "Donaを開く" : "ログインして、作業を始める";
    const description = complete ? "アカウントの確認を終えたら、ダッシュボードへ進んでください。"
      : "登録済みのアカウントでログインして、Donaのワークスペースを開きます。";
    const action = complete ? '<a class="primary" href="/">ダッシュボードを開く</a>'
      : '<button class="primary" id="login-button" type="button" disabled>アカウントでログイン</button><p class="status" id="login-status" role="status" aria-live="polite" aria-atomic="true">認証サービスの画面へ移動します。</p><noscript><p>ログインを始めるには、ブラウザのJavaScriptを有効にしてください。</p></noscript>';
    return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
      + (complete ? 'Donaを開く' : 'ログイン') + ' · Dona</title><style>' + authStyles + '</style></head><body>'
      + '<a class="skip" href="#main">本文へ移動</a><div class="page"><header class="brand">Dona<span>ワークスペース</span></header>'
      + '<main id="main"><section class="panel" aria-labelledby="title"><p class="eyebrow">' + eyebrow + '</p><h1 id="title">' + heading
      + '</h1><p class="description">' + description + '</p>' + action
      + (complete ? '<p class="note">ログイン画面に戻った場合は、もう一度アカウントを確認してください。</p>' : '')
      + '</section></main><footer>Dona · あなたの作業を、ひとつの場所に。</footer></div>'
      + (complete ? '' : '<script src="/assets/login.js" integrity="sha256-' + this.scriptHash + '" defer></script>') + '</body></html>';
  }
  handle(request: BrowserAuthRequest): PublicPageResponse {
    try {
      if (!(request.body instanceof Uint8Array) || request.body.byteLength !== 0 || request.headers.length > 128
        || request.headers.reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 16384) throw Error();
      assertBrowserBoundary(this.policy, request.headers, request.transportVerified);
      const origin = singleHeader(request.headers, "origin"); if (origin !== undefined && origin !== this.policy.origin) throw Error();
      if (request.method !== "GET" || !["/login", "/login/complete", "/assets/login.js"].includes(request.target))
        return { status: 404, headers: { ...privateHeaders, "content-type": "application/json; charset=utf-8" }, body: '{"error":"not_found"}' };
      if (request.target === "/assets/login.js") return { status: 200, headers: { ...privateHeaders, "content-type": "text/javascript; charset=utf-8" }, body: this.script };
      const complete = request.target === "/login/complete";
      const csp = privateHeaders["content-security-policy"] + "; style-src 'sha256-" + this.styleHash + "'"
        + (complete ? "; script-src 'none'; connect-src 'none'" : "; script-src 'sha256-" + this.scriptHash + "'; connect-src 'self'");
      return { status: 200, headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": csp }, body: this.page(complete) };
    } catch { return { status: 400, headers: { ...privateHeaders, "content-type": "application/json; charset=utf-8" }, body: '{"error":"public_request_invalid"}' }; }
  }
}
