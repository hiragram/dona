import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import "../../scripts/build-security-keychain-cas.mjs";
import { encodeKeychainCasRequest, parseKeychainCasResponse } from "../../src/approval/keychain-cas.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

// This is an API-contract fixture, not a live Keychain or OS concurrency test.
if (process.platform === "darwin") test("native CASはSecItem mockだけを使い境界と応答不明を検証する", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dona-keychain-api-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "mock-helper");
  const source = fileURLToPath(new URL("../../src/native/security-keychain-cas.m", import.meta.url));
  const library = fileURLToPath(new URL("../../dist/native/libsecurity-keychain-cas.dylib", import.meta.url));
  const exported = execFileSync("/usr/bin/nm", ["-gU", library], { encoding: "utf8", timeout: 2000, maxBuffer: 8192 });
  assert.match(exported, /_DonaKeychainCasProcessRequest/);
  assert.doesNotMatch(exported, /\b_main\b/);
  assert.equal(fs.statSync(library).mode & 0o111, 0);
  const manifest = JSON.parse(fs.readFileSync(new URL("../../dist/native/libsecurity-keychain-cas.json", import.meta.url), "utf8"));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(manifest, { codec_version: 1, platform: process.platform, arch: process.arch, source: hash(fs.readFileSync(source)),
    header: hash(fs.readFileSync(new URL("../../src/native/security-keychain-cas.h", import.meta.url))), binary: hash(fs.readFileSync(library)) });
  const fixture = fileURLToPath(new URL("./fixtures/keychain-cas-mock.m", import.meta.url));
  const frontend = fileURLToPath(new URL("./fixtures/keychain-cas-main.m", import.meta.url));
  const environment = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  execFileSync("/usr/bin/cc", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror",
    "-DSecItemCopyMatching=DonaFixtureCopyMatching", "-DSecItemUpdate=DonaFixtureUpdate",
    "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication",
    source, fixture, frontend, "-o", binary], { timeout: 30000, maxBuffer: 8192, killSignal: "SIGKILL", env: environment });
  const imports = execFileSync("/usr/bin/nm", ["-u", binary], { encoding: "utf8", timeout: 2000, maxBuffer: 8192 });
  assert.doesNotMatch(imports, /_SecItem(?:CopyMatching|Update|Add|Delete)(?:\n|$)/);
  const scope = { access_group: "ABCDEFGHIJ.dev.dona.fixture", instance_id: "fixture", purpose: "audit_anchor" };
  const read = { codec_version: 1, operation: "read", scope };
  const cas = { ...read, operation: "compare_exchange", expected_revision: 1,
    expected_value: Buffer.from("old").toString("base64"), proposed_value: Buffer.from("new").toString("base64") };
  function run(input: unknown, scenario = "normal", raw = false) {
    const result = spawnSync(binary, [], { input: raw ? input as string : canonical(input), encoding: "utf8",
      timeout: 3000, maxBuffer: 16384, killSignal: "SIGKILL", env: { ...environment, DONA_TEST_KEYCHAIN_SCENARIO: scenario } });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /^fixture:reads=\d+,writes=\d+,revision=\d+\n$/);
    return { status: result.status, response: parseKeychainCasResponse(result.stdout), trace: result.stderr };
  }
  assert.deepEqual(run(read), { status: 0, response: { codec_version: 1, revision: 1, status: "observed", value: "b2xk" },
    trace: "fixture:reads=1,writes=0,revision=1\n" });
  assert.deepEqual(run(cas), { status: 0, response: { codec_version: 1, revision: 2, status: "changed", value: "bmV3" },
    trace: "fixture:reads=2,writes=1,revision=2\n" });
  assert.deepEqual(run(encodeKeychainCasRequest(scope), "normal", true), run(read));
  assert.deepEqual(run(encodeKeychainCasRequest(scope, { revision: 1, value: Buffer.from("old") }, Buffer.from("new")), "normal", true), run(cas));
  for (const change of [{ expected_revision: 2 }, { expected_value: "d3Jvbmc=" }]) {
    assert.deepEqual(run({ ...cas, ...change }), { status: 0, response: { codec_version: 1, status: "conflict" },
      trace: "fixture:reads=1,writes=0,revision=1\n" });
  }
  for (const scenario of ["missing", "locked", "duplicate", "bad_value_type", "oversize", "synchronized",
    "wrong_protection", "wrong_service", "wrong_group", "wrong_account"]) {
    assert.deepEqual(run(cas, scenario), { status: 1, response: { codec_version: 1, status: "unverified" },
      trace: "fixture:reads=1,writes=0,revision=1\n" }, scenario);
  }
  for (const [scenario, reads, revision] of [["update_denied", 1, 1], ["competing_update", 1, 2],
    ["lost_update_reply", 1, 2], ["readback_missing", 2, 2], ["readback_drift", 2, 3]] as const) {
    assert.deepEqual(run(cas, scenario), { status: 1, response: { codec_version: 1, status: "unverified" },
      trace: `fixture:reads=${reads},writes=1,revision=${revision}\n` }, scenario);
  }
  for (const invalid of [{ ...read, operation: "bootstrap" }, { ...read, codec_version: true }, { ...read, extra: "denied" },
    { ...read, scope: { ...scope, instance_id: "fixture\n" } }, { ...read, scope: { ...scope, access_group: "*" } },
    { ...cas, expected_revision: 0 }, { ...cas, expected_revision: Number.MAX_SAFE_INTEGER },
    { ...cas, expected_revision: 1.5 }, { ...cas, expected_revision: true }, { ...cas, proposed_value: "" },
    { ...cas, proposed_value: "bmV3=" }, { ...cas, proposed_value: Buffer.alloc(8193).toString("base64") }]) {
    assert.deepEqual(run(invalid), { status: 1, response: { codec_version: 1, status: "unverified" },
      trace: "fixture:reads=0,writes=0,revision=1\n" });
  }
  for (const raw of [canonical(read) + "\n", canonical(read).replace('"codec_version":1', '"codec_version":1,"codec_version":1'),
    canonical(read).replace('"codec_version":1', '"codec_version":1.0'), "x".repeat(32769)]) {
    assert.deepEqual(run(raw, "normal", true), { status: 1, response: { codec_version: 1, status: "unverified" },
      trace: "fixture:reads=0,writes=0,revision=1\n" });
  }
  const maximum = Buffer.alloc(8192, 0x66).toString("base64");
  const large = run({ ...cas, proposed_value: maximum }).response;
  assert.equal(large.status, "changed");if (large.status !== "changed") assert.fail();assert.equal(large.value, maximum);
  const slash = run({ ...cas, proposed_value: "////" }).response;
  assert.equal(slash.status, "changed");if (slash.status !== "changed") assert.fail();assert.equal(slash.value, "////");
});
