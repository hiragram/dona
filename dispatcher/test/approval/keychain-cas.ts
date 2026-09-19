import assert from "node:assert/strict";
import test from "node:test";
import { KeychainCasError, encodeKeychainCasRequest, parseKeychainCasResponse } from "../../src/approval/keychain-cas.js";

const scope = { access_group: "ABCDEFGHIJ.dev.dona.fixture", instance_id: "fixture", purpose: "audit_anchor" };
const observed = '{"codec_version":1,"revision":1,"status":"observed","value":"b2xk"}';
const changed = '{"codec_version":1,"revision":2,"status":"changed","value":"bmV3"}';

test("CAS wireは用途とscopeと容量を固定し不正値を拒否する", () => {
  assert.equal(JSON.parse(encodeKeychainCasRequest(scope)).operation, "read");
  const request = JSON.parse(encodeKeychainCasRequest(scope, { revision: 1, value: Buffer.from("old") }, Buffer.from("new")));
  assert.deepEqual(request, { codec_version: 1, operation: "compare_exchange", scope, expected_revision: 1, expected_value: "b2xk", proposed_value: "bmV3" });
  for (const change of [{ purpose: "credentials" }, { access_group: "*" }, { instance_id: "fixture\n" }, { extra: 1 }])
    assert.throws(() => encodeKeychainCasRequest({ ...scope, ...change }), KeychainCasError);
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN])
    assert.throws(() => encodeKeychainCasRequest(scope, { revision: number, value: Buffer.from("old") }, Buffer.from("new")), KeychainCasError);
  for (const value of [Buffer.alloc(0), Buffer.alloc(8193)])
    assert.throws(() => encodeKeychainCasRequest(scope, { revision: 1, value }, Buffer.from("new")), KeychainCasError);
  assert.throws(() => encodeKeychainCasRequest(scope, undefined, Buffer.from("new")), KeychainCasError);
});

test("CAS responseはcanonical JSONと厳密なfieldを要求し内容をerrorへ転載しない", () => {
  assert.equal(parseKeychainCasResponse(observed).status, "observed");
  assert.equal(parseKeychainCasResponse(changed + "\n").status, "changed");
  for (const raw of ["private-value", observed + "\n\n", observed.replace('"revision":1', '"revision":1,"revision":1'),
    observed.replace('"revision":1', '"revision":true'), observed.replace('"value":"b2xk"', '"value":"b2xk="'),
    observed.replace('"status":"observed"', '"extra":1,"status":"observed"'), "x".repeat(16385)])
    assert.throws(() => parseKeychainCasResponse(raw), { name: "KeychainCasError", message: "keychain_cas_unverified" });
});

