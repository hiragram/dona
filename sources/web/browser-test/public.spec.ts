import { test, expect, type Page } from "@playwright/test";
import { WebPublicPages } from "../src/public-pages.js";
import { fixturePolicy } from "../test/fixtures.js";
const token = Buffer.alloc(32, 1).toString("base64url");
const policy = fixturePolicy();
function target() {
  const url = new URL(policy.oidc.authorization_endpoint);
  url.search = new URLSearchParams({ response_type: "code", client_id: policy.oidc.client_id, redirect_uri: policy.oidc.redirect_uri,
    scope: "openid", state: token, nonce: token, code_challenge_method: "S256", code_challenge: token }).toString();
  return url.href;
}
/** Browser UI evidence only: all transport is fulfilled locally. This does not
 * establish real TLS/IdP/session/OS-store readiness. Those contracts have separate
 * repository/UDS tests and live-provider gates. No external network is allowed. */
async function fixture(page: Page, options: { failure?: "unknown" | "redirect" | "cache" | "oversize"; pause?: Promise<void> } = {}) {
  const pages = new WebPublicPages(policy), calls: Array<{ path: string; method: string; csrf?: string }> = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), headers = await request.allHeaders();
    calls.push({ path: url.pathname, method: request.method(), ...(headers["x-dona-csrf"] ? { csrf: headers["x-dona-csrf"] } : {}) });
    if (url.origin === policy.origin && ["/login", "/login/complete", "/assets/login.js"].includes(url.pathname)) {
      const response = pages.handle({ method: request.method(), target: url.pathname + url.search,
        body: Buffer.from(request.postData() ?? ""), transportVerified: true, headers: Object.entries({ ...headers, host: url.host }) });
      await route.fulfill(response); return;
    }
    if (url.origin === policy.origin && url.pathname === "/api/login/csrf") {
      expect(request.method()).toBe("POST"); expect(request.postData()).toBe("{}"); expect(headers.origin).toBe(policy.origin);
      if (options.pause) await options.pause;
      await route.fulfill({ status: 200, headers: { "content-type": "application/json; charset=utf-8",
        "cache-control": options.failure === "cache" ? "public" : "no-store" },
        body: options.failure === "oversize" ? "x".repeat(16385) : JSON.stringify({ csrf_token: token }) }).catch(() => {}); return;
    }
    if (url.origin === policy.origin && url.pathname === "/api/login/start") {
      expect(request.method()).toBe("POST"); expect(request.postData()).toBe("{}"); expect(headers.origin).toBe(policy.origin);
      expect(headers["x-dona-csrf"]).toBe(token);
      if (options.failure === "unknown") await route.abort("failed");
      else await route.fulfill({ status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        body: JSON.stringify({ authorization_url: options.failure === "redirect" ? "https://other.example.test/" : target() }) });
      return;
    }
    if (url.href === target() || (url.origin === policy.origin && url.pathname === "/")) {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fixture target</title><p>Fixture only</p>" }); return;
    }
    errors.push("unexpected fixture network destination"); await route.abort();
  });
  return { calls, errors };
}

test("完了案内はAPIを呼ばず、手動linkからだけdashboardへ移動する", async ({ page }) => {
  const f = await fixture(page), response = await page.goto(policy.origin + "/login/complete");
  expect(response!.headers()["cache-control"]).toBe("no-store"); expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByRole("heading", { name: "Donaを開く" })).toBeVisible();
  expect(await page.locator("script").count()).toBe(0); expect(f.calls.map(call => call.path)).toEqual(["/login/complete"]);
  await page.getByRole("link", { name: "ダッシュボードを開く" }).click(); await expect(page).toHaveURL(policy.origin + "/");
  expect(f.calls.map(call => call.path)).toEqual(["/login/complete", "/"]); expect(f.errors).toEqual([]);
});

test("利用者のclickからだけ2つのPOSTを通し固定IdPへ移動する", async ({ page }) => {
  const f = await fixture(page); await page.goto(policy.origin + "/login");
  const button = page.getByRole("button", { name: "アカウントでログイン" }); await expect(button).toBeEnabled();
  expect(f.calls.map(call => call.path)).toEqual(["/login", "/assets/login.js"]);
  await button.click(); await expect(page).toHaveURL(target());
  expect(f.calls.filter(call => call.method === "POST")).toEqual([{ path: "/api/login/csrf", method: "POST" }, { path: "/api/login/start", method: "POST", csrf: token }]);
  expect(f.errors).toEqual([]);
});

test("処理中は重複clickを無効化し別ページへ移動したら次のPOSTをしない", async ({ page }) => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(page, { pause }); await page.goto(policy.origin + "/login");
  const button = page.getByRole("button", { name: "アカウントでログイン" }); await button.click();
  await expect(button).toBeDisabled(); await expect.poll(() => f.calls.filter(call => call.method === "POST").length).toBe(1);
  await button.evaluate(element => (element as HTMLButtonElement).click());
  await page.goto(policy.origin + "/login/complete"); release();
  await expect(page.getByRole("heading", { name: "Donaを開く" })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/api/login/start")).toEqual([]);
});

for (const failure of ["unknown", "redirect", "cache", "oversize"] as const) {
  test(`拒否または受理不明を表示し自動再POSTしない: ${failure}`, async ({ page }) => {
    const f = await fixture(page, { failure }); await page.goto(policy.origin + "/login");
    await page.getByRole("button", { name: "アカウントでログイン" }).click();
    await expect(page.getByRole("button", { name: "新しくログインを始める" })).toBeEnabled();
    await expect(page.getByRole("status")).toContainText("自動では再実行しません");
    expect(f.calls.filter(call => call.path === "/api/login/csrf").length).toBe(1);
    expect(f.calls.filter(call => call.path === "/api/login/start").length).toBe(failure === "cache" || failure === "oversize" ? 0 : 1);
    expect(f.errors).toEqual([]); await expect(page).toHaveURL(policy.origin + "/login");
  });
}

for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1280, height: 900 }]) {
  test(`keyboard focusと文字拡大で操作と本文が隠れない: ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const f = await fixture(page); await page.goto(policy.origin + "/login");
    await expect(page.getByRole("button", { name: "アカウントでログイン" })).toBeEnabled();
    await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
    await page.keyboard.press("Tab"); const button = page.getByRole("button", { name: "アカウントでログイン" }); await expect(button).toBeFocused();
    expect(await button.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
    expect(f.calls.filter(call => call.method === "POST")).toEqual([]); expect(f.errors).toEqual([]);
  });
}
