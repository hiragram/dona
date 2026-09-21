import { expect, test, type Page, type Route } from "@playwright/test";
import { dashboardPage } from "../src/dashboard.js";
import { fixturePolicy } from "../test/fixtures.js";

const policy = fixturePolicy(), csrf = Buffer.alloc(32, 7).toString("base64url"), cursor = Buffer.alloc(32, 8).toString("base64url");
const at = "2026-09-21T00:00:00.000Z";
const job = (patch: Record<string, unknown> = {}) => ({ job_id: "job_alpha", status: "running", created_at: at, updated_at: at,
  completed_at: null, progress: { sequence: 3, phase: "implementing", updated_at: at }, result: null, error_code: null,
  control: { can_cancel: true }, ...patch });
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, headers, body: JSON.stringify(body) });
}

async function fixture(page: Page, options: { submitUnknown?: boolean; cancelUnknown?: boolean; pauseSubmit?: Promise<void>; unsafeResult?: boolean;
  scopes?: string[]; firstEventAbort?: boolean; cancelReason?: "terminal" | "owner_mismatch"; listFailsAfterSubmit?: boolean;
  eventDeniedStatus?: 403 | 404; pauseFirstAlphaDetail?: Promise<void>; pauseSecondList?: Promise<void>; multipleJobs?: boolean; listDeniedAfterFirst?: boolean; detailAfterCancelStatus?: 403 | 503 } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown; csrf?: string; lastEventId?: string }> = [], errors: string[] = [];
  const unsafeTerminal = job({ status: "completed", completed_at: at, progress: null, control: { can_cancel: false },
    result: { status: "completed", summary: "<img src=x onerror=alert(1)>\u202eend", completed_at: at, artifacts: [{ name: "report.txt", kind: "report" }] } });
  let current = job(), listReads = 0, detailReads = 0, alphaDetailReads = 0, submitWrites = 0, cancelWrites = 0, eventReads = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), requestHeaders = await request.allHeaders();
    let body: unknown; try { body = request.postData() ? JSON.parse(request.postData()!) : undefined; } catch { body = "invalid"; }
    calls.push({ path: url.pathname + url.search, method: request.method(), ...(body === undefined ? {} : { body }),
      ...(requestHeaders["x-dona-csrf"] ? { csrf: requestHeaders["x-dona-csrf"] } : {}),
      ...(requestHeaders["last-event-id"] ? { lastEventId: requestHeaders["last-event-id"] } : {}) });
    if (url.origin !== policy.origin) { errors.push("unexpected external request"); await route.abort(); return; }
    if (url.pathname === "/") { await route.fulfill(dashboardPage()); return; }
    if (url.pathname === "/login") { await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>login</title>" }); return; }
    if (url.pathname === "/api/session") { await fulfill(route, { principal: { principal_id: "principal-fixture", role_ids: ["requester"], scopes: options.scopes ?? ["job:submit", "job:read:own", "job:cancel:own"] }, csrf_token: csrf }); return; }
    if (url.pathname === "/api/jobs" && request.method() === "GET") { listReads++;const snapshot=current;if(options.pauseSecondList&&listReads===2)await options.pauseSecondList; if(options.listDeniedAfterFirst&&listReads>1){await fulfill(route,{error:"scope_denied"},403);return;}if(options.listFailsAfterSubmit&&submitWrites>0){await fulfill(route,{error:"identity_unavailable"},503);return;}
      await fulfill(route, { items: options.pauseFirstAlphaDetail||options.multipleJobs ? [job(),job({job_id:"job_beta"})] : [snapshot], next_cursor: null }); return; }
    if (url.pathname === "/api/jobs" && request.method() === "POST") {
      submitWrites++; expect(requestHeaders["x-dona-csrf"]).toBe(csrf); expect(body).toMatchObject({ workspace: { kind: "scratch" } });
      expect((body as { request_id: string }).request_id).toMatch(/^[A-Za-z0-9_-]{43}$/); if (options.pauseSubmit) await options.pauseSubmit;
      if (options.submitUnknown) { await fulfill(route, { error: "acceptance_unknown" }, 503); return; }
      current = job({ job_id: "job_created", status: "queued", progress: null }); await fulfill(route, { status: "succeeded", outcome: "created", receipt_id: "receipt", job: { job_id: "job_created", status: "queued" } }, 201); return;
    }
    if (/^\/api\/jobs\/[A-Za-z0-9_-]+$/.test(url.pathname)) { detailReads++;const id=url.pathname.split("/").at(-1)!;if(options.detailAfterCancelStatus&&cancelWrites>0){await fulfill(route,{error:options.detailAfterCancelStatus===403?"scope_denied":"identity_unavailable"},options.detailAfterCancelStatus);return;}
      if(id==="job_alpha"){alphaDetailReads++;if(options.pauseFirstAlphaDetail&&alphaDetailReads===1)await options.pauseFirstAlphaDetail;}
      await fulfill(route, { job: options.pauseFirstAlphaDetail||options.multipleJobs?job({job_id:id,...(id==="job_alpha"?{error_code:alphaDetailReads===1?"old_projection":"new_projection"}:{})}):current, event_cursor: cursor }); return; }
    if (/^\/api\/jobs\/[A-Za-z0-9_-]+\/events$/.test(url.pathname)) {
      eventReads++; expect(requestHeaders["last-event-id"]).toBe(cursor); if(options.eventDeniedStatus){await fulfill(route,{error:options.eventDeniedStatus===403?"scope_denied":"not_found"},options.eventDeniedStatus);return;} if (options.firstEventAbort && eventReads === 1) { await route.abort("failed"); return; }
      const event = options.unsafeResult && eventReads === 1 ? "job" : "heartbeat"; if (event === "job") current = unsafeTerminal;
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
        body: `id: ${cursor}\nevent: ${event}\ndata: ${JSON.stringify({ job: current })}\n\n` }); return;
    }
    if (/^\/api\/jobs\/[A-Za-z0-9_-]+\/cancel$/.test(url.pathname)) {
      cancelWrites++; expect(requestHeaders["x-dona-csrf"]).toBe(csrf); expect((body as { request_id: string }).request_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (options.cancelUnknown) { await fulfill(route, { error: "acceptance_unknown" }, 503); return; }
      if (options.cancelReason) { await fulfill(route, { error: options.cancelReason }, options.cancelReason === "owner_mismatch" ? 403 : 409); return; }
      current = job({ status: "cancelling", control: { can_cancel: false } }); await fulfill(route, { status: "succeeded", outcome: "cancelled", receipt_id: "cancel", job: { job_id: "job_alpha", status: "cancelling" } }); return;
    }
    errors.push("unexpected route: " + url.pathname); await route.abort();
  });
  return { calls, errors, get listReads() { return listReads; }, get detailReads() { return detailReads; }, get submitWrites() { return submitWrites; }, get cancelWrites() { return cancelWrites; }, get eventReads() { return eventReads; } };
}

test("login後にdurable一覧・詳細・SSEを表示しuntrusted Resultをliteral表示する", async ({ page }) => {
  const f = await fixture(page, { unsafeResult: true }); await page.goto(policy.origin + "/");
  await expect(page.getByRole("heading", { name: "新しい依頼" })).toBeVisible();
  await expect(page.getByRole("button", { name: /job_alpha/ })).toBeVisible();
  await page.getByRole("button", { name: /job_alpha/ }).click();
  await expect(page.getByRole("heading", { name: "job_alpha" })).toBeVisible();
  await expect.poll(() => f.eventReads).toBeGreaterThan(0);
  await expect(page.getByText("完了", { exact: true })).toBeVisible();
  await expect(page.locator("pre.summary")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("pre.summary")).toContainText("\\u202eend"); expect(await page.locator("img").count()).toBe(0);
  expect(f.calls.find(call => call.path.endsWith("/events"))?.lastEventId).toBe(cursor);
  expect(await page.locator("script").count()).toBe(1); expect(f.errors).toEqual([]);
});

test("送信中の二重操作を止め、receipt確認後だけ作成済みjobへ進む", async ({ page }) => {
  let release!: () => void; const pauseSubmit = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(page, { pauseSubmit }); await page.goto(policy.origin + "/");
  await page.getByLabel("依頼内容").fill("安全に調査する"); const button = page.getByRole("button", { name: "依頼を送信" }); await button.click();
  await expect(button).toBeDisabled(); await button.evaluate(element => (element as HTMLButtonElement).click()); expect(f.submitWrites).toBe(1);
  release(); await expect(page.getByRole("heading", { name: "job_created" })).toBeVisible(); expect(f.submitWrites).toBe(1); expect(f.errors).toEqual([]);
});

test("成功receipt後の一覧read失敗を受付不明へ戻さない", async ({ page }) => {
  const f = await fixture(page, { listFailsAfterSubmit: true }); await page.goto(policy.origin + "/");
  await page.getByLabel("依頼内容").fill("受理後のread失敗を確認する"); await page.getByRole("button", { name: "依頼を送信" }).click();
  await expect(page.getByRole("heading", { name: "job_created" })).toBeVisible(); expect(f.submitWrites).toBe(1); expect(f.errors).toEqual([]);
});

test("依頼全体が64 KiBを超える場合は送信前に止める", async ({ page }) => {
  const f = await fixture(page); await page.goto(policy.origin + "/"); await page.getByLabel("依頼内容").fill("あ".repeat(30000));
  await page.getByRole("button", { name: "依頼を送信" }).click(); await expect(page.getByText("依頼全体を64 KiB以内にしてください。")).toBeVisible();
  expect(f.submitWrites).toBe(0); expect(f.errors).toEqual([]);
});

test("submitのacceptance unknownは再POSTせず一覧をread-only再取得する", async ({ page }) => {
  const f = await fixture(page, { submitUnknown: true }); await page.goto(policy.origin + "/");
  await expect(page.getByRole("heading", { name: "新しい依頼" })).toBeVisible(); const before = f.listReads;
  await page.getByLabel("依頼内容").fill("結果不明を確認する"); await page.getByRole("button", { name: "依頼を送信" }).click();
  await expect(page.getByRole("status")).toContainText("自動では再実行せず"); expect(f.submitWrites).toBe(1); expect(f.listReads).toBe(before + 1); expect(f.errors).toEqual([]);
});

test("submit受付不明後のreconcileが403ならprivate表示を消去する",async({page})=>{
  const f=await fixture(page,{submitUnknown:true,listDeniedAfterFirst:true});await page.goto(policy.origin+"/");await page.getByLabel("依頼内容").fill("失効を確認する");await page.getByRole("button",{name:"依頼を送信"}).click();
  await expect(page.getByRole("status")).toContainText("受付結果は不明です");await expect(page.getByRole("button",{name:/job_alpha/})).toBeHidden();expect(f.submitWrites).toBe(1);expect(f.errors).toEqual([]);
});

test("cancelはexact jobをdialogで確認し結果不明でも再POSTしない", async ({ page }) => {
  const f = await fixture(page, { cancelUnknown: true }); await page.goto(policy.origin + "/"); await page.getByRole("button", { name: /job_alpha/ }).click();
  await page.getByRole("button", { name: "このジョブを取り消す" }).click(); const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("job_alpha");
  await page.getByRole("button", { name: "取消を送信" }).click(); await expect(page.getByRole("status")).toContainText("自動では再実行せず"); expect(f.cancelWrites).toBe(1); expect(f.errors).toEqual([]);
});

test("current scopeがないrouteの操作を表示せずAPIも呼ばない", async ({ page }) => {
  const f = await fixture(page, { scopes: [] }); await page.goto(policy.origin + "/");
  await expect(page.getByRole("status")).toContainText("表示可能なジョブ操作はありません");
  await expect(page.getByRole("heading", { name: "新しい依頼" })).toBeHidden(); await expect(page.getByRole("heading", { name: "ジョブ" })).toBeHidden();
  expect(f.listReads).toBe(0); expect(f.submitWrites).toBe(0); expect(f.errors).toEqual([]);
});

test("submit専用principalはreceipt後に禁止されたreadを送らない", async ({ page }) => {
  const f=await fixture(page,{scopes:["job:submit"]});await page.goto(policy.origin+"/");await expect(page.getByRole("heading",{name:"新しい依頼"})).toBeVisible();
  await page.getByLabel("依頼内容").fill("submitだけ行う");await page.getByRole("button",{name:"依頼を送信"}).click();await expect(page.getByRole("status")).toContainText("durably受理されました");
  expect(f.submitWrites).toBe(1);expect(f.listReads).toBe(0);expect(f.detailReads).toBe(0);expect(f.errors).toEqual([]);
});

test("一覧更新で403なら以前のprivate一覧を消去する", async ({ page }) => {
  const f=await fixture(page,{listDeniedAfterFirst:true});await page.goto(policy.origin+"/");await expect(page.getByRole("button",{name:/job_alpha/})).toBeVisible();
  await page.getByRole("button",{name:"一覧を更新"}).click();await expect(page.getByRole("status")).toContainText("以前の内容は表示していません");await expect(page.getByRole("button",{name:/job_alpha/})).toBeHidden();expect(f.errors).toEqual([]);
});

test("reloadとback/forwardはbrowser cacheでなくsessionとdurable detailを再取得する", async ({ page }) => {
  const f = await fixture(page); await page.goto(policy.origin + "/"); await expect(page.getByRole("button", { name: /job_alpha/ })).toBeVisible();
  const beforeReload = f.listReads; await page.reload(); await expect(page.getByRole("button", { name: /job_alpha/ })).toBeVisible(); expect(f.listReads).toBe(beforeReload + 1);
  await page.getByRole("button", { name: /job_alpha/ }).click(); await expect(page.getByRole("heading", { name: "job_alpha" })).toBeVisible();
  await page.getByRole("button", { name: "一覧へ戻る" }).click(); await expect(page.getByRole("heading", { name: "ジョブ" })).toBeVisible();
  const beforeBack = f.detailReads; await page.goBack(); await expect(page.getByRole("heading", { name: "job_alpha" })).toBeVisible(); expect(f.detailReads).toBeGreaterThan(beforeBack);
  await page.goForward(); await expect(page.getByRole("heading", { name: "ジョブ" })).toBeVisible(); expect(f.errors).toEqual([]);
});

test("SSE切断はstaleを明示してdetailから再接続し、cancel競合も再writeしない", async ({ page }) => {
  const f = await fixture(page, { firstEventAbort: true, cancelReason: "terminal" }); await page.goto(policy.origin + "/"); await page.getByRole("button", { name: /job_alpha/ }).click();
  await expect(page.getByText(/接続が切れました|最新状態を確認できません/)).toBeVisible(); await expect.poll(() => f.detailReads, { timeout: 4000 }).toBeGreaterThan(1);
  await page.getByRole("button", { name: "このジョブを取り消す" }).click(); await page.getByRole("button", { name: "取消を送信" }).click();
  await expect(page.getByRole("status")).toContainText("取消を受け付けられませんでした"); expect(f.cancelWrites).toBe(1); expect(f.eventReads).toBeGreaterThan(1); expect(f.errors).toEqual([]);
});

test("SSEで認可を失ったらprivate detailを消去する", async ({ page }) => {
  const f = await fixture(page, { eventDeniedStatus: 403 }); await page.goto(policy.origin + "/"); await page.getByRole("button", { name: /job_alpha/ }).click();
  await expect(page.getByRole("status")).toContainText("以前の内容は表示していません"); await expect(page.getByRole("heading", { name: "job_alpha" })).toBeHidden();
  expect(f.eventReads).toBe(1); expect(f.errors).toEqual([]);
});

test("SSEでgrant失効の404ならstale detailと一覧を消去する",async({page})=>{
  const f=await fixture(page,{eventDeniedStatus:404});await page.goto(policy.origin+"/");await page.getByRole("button",{name:/job_alpha/}).click();await expect(page.getByRole("status")).toContainText("以前の内容は消去しました");
  await expect(page.getByRole("heading",{name:"job_alpha"})).toBeHidden();await expect(page.getByRole("button",{name:/job_alpha/})).toBeHidden();expect(f.eventReads).toBe(1);expect(f.errors).toEqual([]);
});

test("遅い旧一覧応答はsubmit後の新しい一覧を上書きしない",async({page})=>{
  let release!:()=>void;const pauseSecondList=new Promise<void>(resolve=>{release=resolve;});const f=await fixture(page,{pauseSecondList});await page.goto(policy.origin+"/");
  await page.getByRole("button",{name:"一覧を更新"}).click({noWaitAfter:true});await page.getByLabel("依頼内容").fill("新しい依頼");await page.getByRole("button",{name:"依頼を送信"}).click();await expect(page.getByRole("heading",{name:"job_created"})).toBeVisible();
  await page.getByRole("button",{name:"一覧へ戻る"}).click();release();await page.waitForTimeout(100);await expect(page.getByRole("button",{name:/job_created/})).toBeVisible();expect(f.errors).toEqual([]);
});

test("bfcache復帰時に前principalの未送信formを初期化する",async({page})=>{
  const f=await fixture(page);await page.goto(policy.origin+"/");await page.getByLabel("依頼内容").fill("private draft");await page.getByLabel("作業場所").selectOption("github");await page.getByLabel("Repository").fill("owner/private");
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));await expect(page.getByRole("heading",{name:"新しい依頼"})).toBeVisible();await expect(page.getByLabel("依頼内容")).toHaveValue("");await expect(page.getByLabel("作業場所")).toHaveValue("scratch");await expect(page.getByLabel("Repository")).toBeHidden();expect(f.errors).toEqual([]);
});

test("遅い旧detail応答は現在の選択を上書きしない", async ({ page }) => {
  let release!:()=>void;const pauseFirstAlphaDetail=new Promise<void>(resolve=>{release=resolve;});const f=await fixture(page,{pauseFirstAlphaDetail});await page.goto(policy.origin+"/");
  await page.getByRole("button",{name:/job_alpha/}).click();await page.getByRole("button",{name:/job_beta/}).click();await expect(page.getByRole("heading",{name:"job_beta"})).toBeVisible();
  release();await page.waitForTimeout(100);await expect(page.getByRole("heading",{name:"job_beta"})).toBeVisible();expect(page.url()).toContain("job_beta");expect(f.errors).toEqual([]);
});

test("A→B→Aでも最初のA応答を選択世代で破棄する", async ({ page }) => {
  let release!:()=>void;const pauseFirstAlphaDetail=new Promise<void>(resolve=>{release=resolve;});const f=await fixture(page,{pauseFirstAlphaDetail});await page.goto(policy.origin+"/");
  await page.getByRole("button",{name:/job_alpha/}).click();await page.getByRole("button",{name:/job_beta/}).click();await expect(page.getByRole("heading",{name:"job_beta"})).toBeVisible();
  await page.goBack();await expect(page.getByText("new_projection")).toBeVisible();release();await page.waitForTimeout(100);await expect(page.getByText("new_projection")).toBeVisible();await expect(page.getByText("old_projection")).toBeHidden();expect(f.errors).toEqual([]);
});

test("取消dialogのjobからnavigationしたら送信せずdialogを閉じる",async({page})=>{
  const f=await fixture(page,{multipleJobs:true});await page.goto(policy.origin+"/");await page.getByRole("button",{name:/job_beta/}).click();await page.getByRole("button",{name:"このジョブを取り消す"}).click();
  await page.evaluate(()=>{history.pushState({job:"job_alpha"},"","#job=job_alpha");dispatchEvent(new PopStateEvent("popstate"));});await expect(page.getByRole("heading",{name:"job_alpha"})).toBeVisible();await expect(page.getByRole("dialog")).toBeHidden();expect(f.cancelWrites).toBe(0);expect(f.errors).toEqual([]);
});

test("cancel成功receipt後のdetail失敗を取消失敗へ戻さない",async({page})=>{
  const f=await fixture(page,{detailAfterCancelStatus:503});await page.goto(policy.origin+"/");await page.getByRole("button",{name:/job_alpha/}).click();await page.getByRole("button",{name:"このジョブを取り消す"}).click();await page.getByRole("button",{name:"取消を送信"}).click();
  await expect(page.getByRole("status")).toContainText("取消受付は確認済みですが");expect(f.cancelWrites).toBe(1);expect(f.errors).toEqual([]);
});

test("cancel受付不明後のreconcileが403ならprivate表示を消去する",async({page})=>{
  const f=await fixture(page,{cancelUnknown:true,detailAfterCancelStatus:403});await page.goto(policy.origin+"/");await page.getByRole("button",{name:/job_alpha/}).click();await page.getByRole("button",{name:"このジョブを取り消す"}).click();await page.getByRole("button",{name:"取消を送信"}).click();
  await expect(page.getByRole("status")).toContainText("取消の受付結果は不明です");await expect(page.getByRole("heading",{name:"job_alpha"})).toBeHidden();expect(f.cancelWrites).toBe(1);expect(f.errors).toEqual([]);
});

test("terminal detailではSSEを開始せずerror codeとfocusを表示する", async ({ page }) => {
  const f=await fixture(page);await page.goto(policy.origin+"/");
  await page.evaluate(()=>{history.replaceState(null,"","/");});
  // fixtureの一覧取得後にdetail projectionをterminalへ切り替える。
  await page.route("**/api/jobs/job_alpha",route=>fulfill(route,{job:job({status:"failed",error_code:"worker_failed",control:{can_cancel:false}}),event_cursor:cursor}));
  await page.getByRole("button",{name:/job_alpha/}).click();const title=page.getByRole("heading",{name:"job_alpha"});await expect(title).toBeFocused();await expect(page.getByText("worker_failed")).toBeVisible();
  expect(f.eventReads).toBe(0);expect(f.errors).toEqual([]);
});

for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1280, height: 900 }]) {
  test(`keyboard・200%文字・主要viewportで操作を維持する: ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport); const f = await fixture(page); await page.goto(policy.origin + "/");
    await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await page.evaluate(() => ({ unlabeled: [...document.querySelectorAll("button,input,textarea,select")].filter(element => {
      const input = element as HTMLInputElement, label = input.id && document.querySelector(`label[for="${input.id}"]`);
      return element.tagName === "BUTTON" ? !(element.textContent ?? "").trim() : !label && !element.getAttribute("aria-label"); }).length,
      columns: getComputedStyle(document.getElementById("private-view")!).gridTemplateColumns.split(" ").length }));
    expect(audit.unlabeled).toBe(0); expect(audit.columns).toBe(viewport.width <= 860 ? 1 : 2);
    const submit = page.getByRole("button", { name: "依頼を送信" }); await submit.scrollIntoViewIfNeeded(); expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(f.errors).toEqual([]);
  });
}
