import assert from "node:assert/strict";
import test from "node:test";
import { WebBoundaryError } from "../src/policy.js";
import { WebAuthController, type BrowserAuthRequest } from "../src/auth-controller.js";
import { controllerFixture } from "./auth-controller-fixture.js";

test("最終transactionの署名済み拒否理由を保持し追加監査writeをしない", async () => {
  for (const [reason, status, publicReason] of [
    ["session_revoked", 401, "session_revoked"], ["revision_mismatch", 401, "session_revoked"],
    ["session_expired", 401, "session_expired"], ["identity_mismatch", 401, "identity_mismatch"],
    ["session_invalid", 401, "session_invalid"], ["proof_invalid", 401, "session_invalid"],
    ["already_consumed", 401, "session_invalid"], ["deployment_invalid", 503, "identity_unavailable"],
    ["identity_unavailable", 503, "identity_unavailable"], ["clock_anomaly", 503, "identity_unavailable"],
    ["quota_exceeded", 503, "identity_unavailable"], ["operation_unsupported", 503, "identity_unavailable"],
  ] as const) {
    const f = controllerFixture(); let confirms = 0;
    f.connections.session.confirm = async () => { confirms++; return { status: "denied", reason }; };
    const result = await f.controller.handle(f.request());
    assert.equal(result.status, status); assert.deepEqual(JSON.parse(result.body), { error: publicReason });
    assert.equal(confirms, 1); assert.ok(!f.calls.some(call => call.startsWith("write:")));
    assert.equal(result.headers["set-cookie"], undefined);
  }
});

function header(request: BrowserAuthRequest, name: string, value?: string): BrowserAuthRequest {
  return { ...request, headers: [...request.headers.filter(([key]) => key !== name), ...(value === undefined ? [] : [[name, value] as const])] };
}
function privateFailure(result: Awaited<ReturnType<ReturnType<typeof controllerFixture>["controller"]["handle"]>>) {
  assert.ok(result.status >= 400); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["referrer-policy"], "no-referrer"); assert.equal(result.headers["set-cookie"], undefined);
  assert.deepEqual(Object.keys(JSON.parse(result.body)), ["error"]);
}

test("BFFは同一originの明示dashboard navigationだけをservice activityへ分類する", async () => {
  for (const target of ["/", "/api/session"]) for (const mode of ["navigation", "poll", "script", "frame", "missing_user", "false_user", "duplicate_user"]) {
    const f=controllerFixture(), confirm=f.connections.session.confirm;
    let observed: boolean | undefined;
    f.connections.session.confirm=async (input,identity)=>{observed=input.user_navigation;return confirm(input,identity);};
    let request=header(header(header(f.request(target),"sec-fetch-mode","navigate"),"sec-fetch-dest","document"),"sec-fetch-user","?1");
    if(mode==="poll")request=f.request(target);
    if(mode==="script")request=header(request,"sec-fetch-mode","cors");
    if(mode==="frame")request=header(request,"sec-fetch-dest","iframe");
    if(mode==="missing_user")request=header(request,"sec-fetch-user");
    if(mode==="false_user")request=header(request,"sec-fetch-user","?0");
    if(mode==="duplicate_user")request={...request,headers:[...request.headers,["sec-fetch-user","?1"]]};
    const result=await f.controller.handle(request);
    if(mode==="duplicate_user" && target==="/")assert.ok(result.status>=400);
    else assert.equal(result.status,200);
    assert.equal(observed,target==="/" && mode==="navigation"?true:undefined);
  }
});

test("各session requestでonline照合と現行registryとDispatcher確認を行う", async () => {
  const f = controllerFixture(), before = f.snapshot.session.state.last_activity_at;
  for (let i = 0; i < 2; i++) {
    const result = await f.controller.handle(f.request()); assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body).principal.role_ids, ["requester"]);
    assert.equal(JSON.parse(result.body).csrf_token, f.csrf); assert.equal(result.headers["cache-control"], "no-store");
    assert.ok(!result.body.includes(f.cookie) && !result.body.includes(f.token) && !result.body.includes("subject-A"));
  }
  assert.deepEqual(f.calls, ["read:session_lookup", "oidc", "read:principal_lookup", "confirm", "read:session_lookup", "oidc", "read:principal_lookup", "confirm"]);
  assert.notEqual(f.contexts[0], f.contexts[1]); assert.equal(f.snapshot.session.state.last_activity_at, before);
});

test("Host・Origin・Fetch Metadata・cookie・bodyの不正はprivate data取得前に拒否する", async () => {
  const variants = (f: ReturnType<typeof controllerFixture>): BrowserAuthRequest[] => [
    header(f.request(), "host", "other.test"), header(f.request(), "origin", "null"), header(f.request(), "sec-fetch-site", "cross-site"),
    header(f.request(), "sec-fetch-site"), header(f.request(), "x-principal-id", "other"), header(f.request(), "x-forwarded-proto", "https"),
    { ...f.request(), transportVerified: false }, { ...f.request(), body: Buffer.from("{}") },
    header(f.request(), "cookie", "__Host-dona_session=" + f.cookie + "; __Host-dona_session=" + f.cookie),
    header(f.request(), "cookie", "__Host-dona_session=invalid"), header(f.request(), "cookie"),
    { ...f.request("/api/session/logout", "POST"), body: Buffer.from('{"principal_id":"other"}') },
    header(f.request("/api/session/logout", "POST"), "content-type", "text/plain"), f.request("/api/jobs?actor_id=other"),
  ];
  for (let i = 0; i < variants(controllerFixture()).length; i++) {
    const f = controllerFixture(), result = await f.controller.handle(variants(f)[i]!); privateFailure(result);
    assert.deepEqual(f.calls, ["write:record_denial"]);
  }
});

test("current registry・tenant・generation・expiryの不一致で成功contextを発行しない", async () => {
  for (const change of [
    (f: ReturnType<typeof controllerFixture>) => { f.snapshot.principal.tenant_id = "other"; },
    (f: ReturnType<typeof controllerFixture>) => { f.snapshot.principal.authz_revision++; },
    (f: ReturnType<typeof controllerFixture>) => { f.snapshot.bff_generation++; },
    (f: ReturnType<typeof controllerFixture>) => { f.setNow(f.snapshot.session.state.expires_at); },
    (f: ReturnType<typeof controllerFixture>) => { f.setNow("2026-09-19T00:30:01.000Z"); },
  ]) {
    const f = controllerFixture(); change(f); privateFailure(await f.controller.handle(f.request()));
    assert.ok(!f.calls.includes("confirm")); assert.equal(f.contexts.length, 0);
  }
  const f = controllerFixture(); f.setOnline({ active: true, sub: "different-subject", expires_at: Date.parse(f.initial) / 1000 + 300 });
  const result = await f.controller.handle(f.request()); assert.equal(result.status, 401); privateFailure(result);
  assert.ok(!f.calls.includes("confirm"));
  assert.equal(f.snapshot.session.state.state, "revoked");
});

test("IdP inactiveはdurable revokeへ接続し拒否後に成功認証へ戻さない", async () => {
  const f = controllerFixture(); f.setOnline({ active: false });
  const result = await f.controller.handle(f.request()); assert.equal(result.status, 401); privateFailure(result);
  assert.deepEqual(f.calls, ["read:session_lookup", "oidc", "write:revoke_inactive"]);
  assert.equal(f.snapshot.session.state.state, "revoked"); assert.equal(f.snapshot.payload, null);
  f.calls.length = 0; privateFailure(await f.controller.handle(f.request())); assert.ok(!f.calls.includes("oidc"));
  const invalid = controllerFixture(); invalid.connections.oidc.introspect = async () => { throw new WebBoundaryError("identity_invalid"); };
  assert.equal((await invalid.controller.handle(invalid.request())).status, 401);
  assert.equal(invalid.snapshot.session.state.state, "revoked");
  assert.deepEqual(invalid.calls, ["read:session_lookup", "write:revoke_inactive"]);
});

test("IdP障害・保護key不明・audit失敗では503でcookieを保持する", async () => {
  for (const mode of ["idp", "key", "audit"] as const) {
    const f = controllerFixture();
    if (mode === "idp") f.connections.oidc.introspect = async () => { throw new WebBoundaryError("identity_unavailable"); };
    if (mode === "key") f.keys.protection = () => { throw Error("private provider details"); };
    if (mode === "audit") f.connections.write.mutate = async () => { throw Error("private audit details"); };
    const request = mode === "audit" ? header(f.request(), "origin", "null") : f.request();
    const result = await f.controller.handle(request); assert.equal(result.status, 503); privateFailure(result);
    assert.equal(result.body, '{"error":"identity_unavailable"}'); assert.equal(f.snapshot.session.state.state, "active");
  }
});

test("local CSRFとlogoutは期限切れ・既失効でもIdP不要で同じsessionだけを扱う", async () => {
  const f = controllerFixture(); f.setNow(f.snapshot.session.state.expires_at);
  f.connections.oidc.introspect = async () => { throw Error("must not call IdP"); };
  const csrf = await f.controller.handle(header(f.request("/api/session/csrf", "POST"), "x-dona-csrf"));
  assert.equal(csrf.status, 200); assert.deepEqual(JSON.parse(csrf.body), { csrf_token: f.csrf });
  for (let i = 0; i < 2; i++) {
    const result = await f.controller.handle(f.request("/api/session/logout", "POST"));
    assert.equal(result.status, 204); assert.equal(result.body, ""); assert.match(result.headers["set-cookie"]!, /Max-Age=0$/);
  }
  assert.equal(f.calls.filter(value => value === "write:revoke_session").length, 2); assert.ok(!f.calls.includes("oidc"));
});

test("logout応答喪失は再writeせずstatusのread-only照合後だけcookieを削除する", async () => {
  const f = controllerFixture(), mutate = f.connections.write.mutate;
  f.connections.write.mutate = async input => { await mutate(input); throw Error("response lost"); };
  const unknown = await f.controller.handle(f.request("/api/session/logout", "POST")); assert.equal(unknown.status, 503); privateFailure(unknown);
  assert.equal(unknown.body, '{"error":"durability_unavailable"}');
  assert.equal(f.snapshot.session.state.state, "revoked"); assert.deepEqual(f.calls, ["read:session_lookup", "write:revoke_session"]);
  const status = await f.controller.handle(f.request("/api/session/logout-status", "POST"));
  assert.equal(status.status, 200); assert.deepEqual(JSON.parse(status.body), { revoked: true }); assert.match(status.headers["set-cookie"]!, /Max-Age=0$/);
  assert.equal(f.calls.filter(value => value.startsWith("write:")).length, 1);
});

test("logoutのread-back喪失・非失効snapshot・別cookieは成功ackにしない", async () => {
  for (const mode of ["read_lost", "active", "wrong_cookie"] as const) {
    const f = controllerFixture(), read = f.connections.read.read, mutate = f.connections.write.mutate;
    let written = false;
    f.connections.write.mutate = async input => {
      if (input.operation === "revoke_session") { written = true; if (mode === "active") return { operation: input.operation, result: { status: "succeeded", kind: "revoked", generation: 1 } }; }
      return mutate(input);
    };
    f.connections.read.read = async input => {
      if (written && mode === "read_lost") throw Error("read lost"); return read(input);
    };
    const request = mode === "wrong_cookie" ? header(f.request("/api/session/logout", "POST"), "cookie", "__Host-dona_session=" + Buffer.alloc(32, 4).toString("base64url")) : f.request("/api/session/logout", "POST");
    const result = await f.controller.handle(request); privateFailure(result);
    if (mode !== "wrong_cookie") assert.equal(result.status, 503);
    assert.ok(f.calls.filter(value => value === "write:revoke_session").length <= 1);
  }
});

test("local endpointのOrigin・CSRF不一致とclient指定identityは作用を起こさない", async () => {
  for (const target of ["/api/session/csrf", "/api/session/logout", "/api/session/logout-status"]) {
    const f = controllerFixture(); privateFailure(await f.controller.handle(header(f.request(target, "POST"), "origin", "https://foreign.test")));
    if (target !== "/api/session/csrf") privateFailure(await f.controller.handle(header(f.request(target, "POST"), "x-dona-csrf", Buffer.alloc(32, 5).toString("base64url"))));
    assert.equal(f.snapshot.session.state.state, "active"); assert.ok(!f.calls.includes("oidc") && !f.calls.includes("write:revoke_session"));
  }
});

test("保護時計巻戻りと通信中のexpiry・revision変更を最終成功前に拒否する", async () => {
  for (const mode of ["rewind", "expire", "revision", "response_late", "token_late"] as const) {
    const f = controllerFixture(), introspect = f.connections.oidc.introspect, confirm = f.connections.session.confirm;
    if (mode === "token_late") f.setOnline({ active: true, sub: "subject-A", expires_at: Date.parse(f.initial) / 1000 + 1 });
    f.connections.oidc.introspect = async (...args) => {
      const result = await introspect(...args);
      if (mode === "rewind") f.setNow("2026-09-19T00:00:00.000Z");
      if (mode === "expire") f.setNow(f.snapshot.session.state.expires_at);
      if (mode === "revision") f.snapshot.principal.identity_binding_revision++;
      return result;
    };
    f.connections.session.confirm = async (...args) => {
      const result = await confirm(...args);
      if (mode === "response_late") f.setNow("2026-09-19T00:00:11.000Z");
      if (mode === "token_late") f.setNow("2026-09-19T00:00:02.000Z");
      return result;
    };
    privateFailure(await f.controller.handle(f.request()));
    if (mode === "response_late" || mode === "token_late") assert.equal(f.calls.filter(value => value.startsWith("write:")).length, 0);
  }
});

test("cookie key inventory不足・重複・revoked keyで既存sessionへfallbackしない", async () => {
  for (const mode of ["missing", "duplicate", "revoked"] as const) {
    const f = controllerFixture(), key = f.key("web_cookie_index");
    f.keys.cookies = () => mode === "missing" ? { retained_versions: [1, 2], keys: [key] }
      : mode === "duplicate" ? { retained_versions: [1, 2], keys: [key, key] }
      : { retained_versions: [1], keys: [{ ...key, state: "revoked" }] };
    const result = await f.controller.handle(f.request()); assert.equal(result.status, 503); privateFailure(result);
    assert.deepEqual(f.calls, ["write:record_denial"]);
  }
});

test("監査側が別の拒否理由を返した場合は元errorを確定せず503にする", async () => {
  for (const reason of ["deployment_invalid", "identity_unavailable", "cookie_ambiguous"] as const) {
    const f = controllerFixture(); let writes = 0;
    f.connections.write.mutate = async input => { writes++; assert.equal(input.operation, "record_denial"); return { operation: input.operation, result: { status: "denied", reason } }; };
    const result = await f.controller.handle(header(f.request(), "origin", "null"));
    assert.equal(result.status, 503); assert.equal(result.body, '{"error":"identity_unavailable"}'); privateFailure(result);
    assert.equal(writes, 1);
  }
});

test("cookie構文エラーの400とmissing・unknown cookieの401を区別する", async () => {
  for (const malformed of [
    "__Host-dona_session=invalid", "__Host-dona_login=invalid",
    "__Host-dona_session=" + Buffer.alloc(32, 9).toString("base64url") + "; __Host-dona_session=" + Buffer.alloc(32, 9).toString("base64url"),
    "__Host-dona_login=" + Buffer.alloc(32, 1).toString("base64url") + "; __Host-dona_login=" + Buffer.alloc(32, 2).toString("base64url"),
  ]) {
    const f = controllerFixture(), result = await f.controller.handle(header(f.request(), "cookie", malformed));
    assert.equal(result.status, 400); assert.match(JSON.parse(result.body).error, /^cookie_(invalid|ambiguous)$/); privateFailure(result);
  }
  for (const cookie of [undefined, "__Host-dona_session=" + Buffer.alloc(32, 4).toString("base64url")]) {
    const f = controllerFixture(); assert.equal((await f.controller.handle(header(f.request(), "cookie", cookie))).status, 401);
  }
  const f = controllerFixture(), forged = await f.controller.handle(header(f.request(), "x-actor-id", "other"));
  assert.equal(forged.status, 401); assert.equal(forged.body, '{"error":"identity_invalid"}');
});

test("前後どちらのcurrent registryでもrevision変更をsession_revokedへ写像する", async () => {
  for (const field of ["authz_revision", "identity_binding_revision"] as const) for (const late of [false, true]) {
    const f = controllerFixture(), introspect = f.connections.oidc.introspect; let reason: string | undefined;
    const mutate = f.connections.write.mutate;
    f.connections.write.mutate = async input => { if (input.operation === "record_denial") reason = input.reason; return mutate(input); };
    if (late) f.connections.oidc.introspect = async (...args) => { const result = await introspect(...args); f.snapshot.principal[field]++; return result; };
    else f.snapshot.principal[field]++;
    const result = await f.controller.handle(f.request()); assert.equal(result.status, 401);
    assert.equal(result.body, '{"error":"session_revoked"}'); assert.equal(reason, "session_revoked"); assert.ok(!f.calls.includes("confirm"));
  }
});

test("古いBFFは新世代のsessionを採用せず現行BFFだけが旧cookieのlocal logoutを扱う", async () => {
  for(const target of ["/api/session","/api/session/csrf","/api/session/logout","/api/session/logout-status"]){
    const f=controllerFixture();f.snapshot.bff_generation=2;
    const request=f.request(target,target==="/api/session"?"GET":"POST");
    assert.equal((await f.controller.handle(request)).status,401);
    assert.ok(!f.calls.includes("oidc") && !f.calls.includes("confirm") && !f.calls.includes("write:revoke_session"));
  }
  const f=controllerFixture();f.snapshot.bff_generation=2;f.snapshot.session.state.state="revoked";
  f.snapshot.session.payload_ref=null;f.snapshot.session.payload_digest=null;f.snapshot.payload=null;
  const current=new WebAuthController(f.policy,f.connections,f.keys,f.now,2);
  assert.equal((await current.handle(f.request("/api/session/logout","POST"))).status,204);
  assert.throws(()=>new WebAuthController(f.policy,f.connections,f.keys,f.now,0));
});

test("SSE cursorはLast-Event-IDをbrowser境界で検証し期限切れだけ409へ写像する",async()=>{
  for(const mode of ["missing","malformed","duplicate","expired"] as const){const f=controllerFixture();let reads=0;
    f.connections.jobRead={execute:async()=>{reads++;return{status:"denied",reason:"cursor_invalid"};}};
    let request=f.request("/api/jobs/job_1/events");
    if(mode==="malformed")request=header(request,"last-event-id","bad");
    if(mode==="duplicate")request={...request,headers:[...request.headers,["last-event-id","a".repeat(43)],["last-event-id","b".repeat(43)]]};
    if(mode==="expired")request=header(request,"last-event-id","a".repeat(43));
    const result=await f.controller.handle(request);assert.equal(result.status,mode==="expired"?409:mode==="duplicate"?403:400,mode);assert.equal(reads,mode==="expired"?1:0,mode);
  }
});

test("job read内部障害はidentity_unavailableへ正規化する",async()=>{const f=controllerFixture();
  f.connections.jobRead={execute:async()=>({status:"denied",reason:"internal_error"})};
  const result=await f.controller.handle(f.request("/api/jobs"));
  assert.equal(result.status,503);assert.equal(result.body,'{"error":"identity_unavailable"}');privateFailure(result);
});
