export const authStyles = String.raw`:root{color-scheme:light;--canvas:#f5f6f8;--surface:#fff;--ink:#17212e;--muted:#4b5868;--line:#d8dee6;--primary:#17212e;--on-primary:#fff;--focus:#875500;--error:#a52424;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;color:var(--ink);background:var(--canvas);font-size:100%;line-height:1.75}
*{box-sizing:border-box}body{margin:0}a,button{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:5px}.page{min-height:100dvh;display:flex;flex-direction:column;padding:40px 48px}.brand{display:flex;align-items:baseline;gap:16px;font-size:1.625rem;letter-spacing:-.04em;font-weight:700}.brand span{font-size:.75rem;letter-spacing:.08em;font-weight:500;color:var(--muted)}main{flex:1;display:grid;place-items:center;padding:56px 0 80px}.panel{width:min(100%,28rem);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:40px}.eyebrow{margin:0 0 16px;color:var(--muted);font-size:.8125rem;font-weight:650;letter-spacing:.06em}h1{font-size:1.75rem;line-height:1.45;letter-spacing:-.02em;margin:0 0 20px;text-wrap:balance}.description{margin:0 0 32px;color:var(--muted);font-size:1rem;overflow-wrap:anywhere}.primary{display:flex;align-items:center;justify-content:center;width:100%;min-height:52px;padding:12px 20px;border:1px solid var(--primary);border-radius:7px;background:var(--primary);color:var(--on-primary);font:inherit;font-size:1rem;font-weight:650;text-align:center;text-decoration:none;cursor:pointer;touch-action:manipulation}.primary:hover:not(:disabled){background:#2e3d50}.primary:disabled{cursor:wait;opacity:.65}.status{margin:20px 0 0;min-height:3.5em;font-size:.875rem;color:var(--muted);overflow-wrap:anywhere}.status[data-state=error]{color:var(--error)}.note{margin:24px 0 0;padding-top:24px;border-top:1px solid var(--line);font-size:.8125rem;color:var(--muted)}footer{font-size:.75rem;color:var(--muted);text-align:center}.skip{position:absolute;left:24px;top:-100px;background:var(--surface);color:var(--ink);padding:8px 16px}.skip:focus{top:16px}noscript p{color:var(--error);font-size:.875rem;margin-top:20px}
@media(max-width:560px){.page{padding:24px}.brand{font-size:1.5rem}.brand span{font-size:.75rem}main{padding:40px 0}.panel{padding:28px 24px}h1{font-size:1.5625rem}.description{margin-bottom:28px}footer{text-align:left}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;

// Executed in the browser, with no third-party code or storage.
export const loginBrowserScript = String.raw`(() => {
  "use strict";
  const config = __DONA_PUBLIC_LOGIN_CONFIG__;
  const button = document.getElementById("login-button");
  const status = document.getElementById("login-status");
  let pending = null;
  let generation = 0;
  const token = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const current = () => generation;
  const post = async (target, csrf, signal) => {
    const response = await fetch(target, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      referrerPolicy: "no-referrer", signal, headers: { "content-type": "application/json", ...(csrf ? { "x-dona-csrf": csrf } : {}) }, body: "{}" });
    if (response.status !== 200 || response.headers.get("content-type") !== "application/json; charset=utf-8"
      || response.headers.get("cache-control") !== "no-store" || !response.body) throw Error("login_response_unverified");
    const reader = response.body.getReader(); const parts = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 16384) throw Error("login_response_unverified"); parts.push(value);
      }
      const all = new Uint8Array(size); let offset = 0;
      for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const authorization = value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "authorization_url"
      || typeof value.authorization_url !== "string" || value.authorization_url.length > 8192) throw Error("login_response_unverified");
    const expected = new URL(config.authorization_endpoint), url = new URL(value.authorization_url);
    if (url.protocol !== "https:" || url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password)
      throw Error("login_response_unverified");
    const fields = { response_type: "code", client_id: config.client_id, redirect_uri: config.redirect_uri, scope: "openid", code_challenge_method: "S256" };
    const names = [...Object.keys(fields), "state", "nonce", "code_challenge"];
    if ([...url.searchParams.keys()].length !== names.length || names.some(name => url.searchParams.getAll(name).length !== 1)
      || Object.entries(fields).some(([name, value]) => url.searchParams.get(name) !== value)
      || ["state", "nonce", "code_challenge"].some(name => !token(url.searchParams.get(name)))) throw Error("login_response_unverified");
    return url.href;
  };
  const idle = () => { button.disabled = false; button.removeAttribute("aria-busy"); };
  button.disabled = false;
  button.addEventListener("click", async () => {
    if (pending) return;
    const controller = new AbortController(), turn = current(); pending = controller;
    button.disabled = true; button.setAttribute("aria-busy", "true"); status.dataset.state = "working";
    status.textContent = "ログインを準備しています…";
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const prepared = await post("/api/login/csrf", null, controller.signal);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || Object.keys(prepared).join(",") !== "csrf_token"
        || !token(prepared.csrf_token) || controller.signal.aborted || turn !== current()) throw Error("login_response_unverified");
      const started = await post("/api/login/start", prepared.csrf_token, controller.signal);
      const target = authorization(started);
      if (controller.signal.aborted || turn !== current()) throw Error("login_response_unverified");
      status.textContent = "認証サービスへ移動します…";
      location.assign(target);
    } catch {
      if (turn === current()) {
        status.dataset.state = "error";
        status.textContent = "ログイン開始の結果を確認できませんでした。自動では再実行しません。続ける場合は、新しくログインを始めてください。";
        button.textContent = "新しくログインを始める"; idle();
      }
    } finally { clearTimeout(timer); if (pending === controller) pending = null; }
  });
  addEventListener("pagehide", () => { generation++; pending?.abort(); pending = null; });
  addEventListener("pageshow", event => {
    if (!event.persisted) return;
    generation++; pending?.abort(); pending = null; idle(); button.textContent = "アカウントでログイン";
    status.dataset.state = "idle"; status.textContent = "認証サービスの画面へ移動します。";
  });
})();
`;
