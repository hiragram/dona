import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import { maintenanceFencePayload, verifyMaintenanceFenceReceipt,
  type MaintenanceFenceBody, type MaintenanceFenceCurrentState } from "../src/maintenance-fence.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-09-26T00:00:30.000Z");
const body: MaintenanceFenceBody = {
  schema_version: 1, issuer: "host-supervisor", host_boot_id: "boot-1",
  supervisor_generation: "supervisor-2", fence_generation: 3,
  issued_at: "2026-09-26T00:00:00.000Z", expires_at: "2026-09-26T00:01:00.000Z",
  job_ids: ["job-a", "job-b"], ingress_frozen: true,
  dispatcher_admission_frozen: true, updater_activation_frozen: true,
  worker_creation_frozen: true, herdr_inventory_complete: true,
  process_tree_inventory_complete: true, terminal_stop_complete: true,
  no_recreation_guard_active: true,
};
const current: MaintenanceFenceCurrentState = {
  host_boot_id: "boot-1", supervisor_generation: "supervisor-2", fence_generation: 3,
  active: true, ingress_frozen: true, dispatcher_admission_frozen: true,
  updater_activation_frozen: true, worker_creation_frozen: true,
  no_recreation_guard_active: true,
};
function signed(candidate: MaintenanceFenceBody) {
  return { body: candidate, signature_base64: sign(null, maintenanceFencePayload(candidate), privateKey).toString("base64") };
}

test("署名、対象job、現在のhost世代と継続中のfreezeが一致した場合だけ受理する", () => {
  const receipt = signed(body);
  assert.doesNotThrow(() => verifyMaintenanceFenceReceipt(receipt, current, "job-a", "host-supervisor", publicKey, now));
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, current, "job-c", "host-supervisor", publicKey, now), /receipt_invalid/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, { ...current, fence_generation: 4 }, "job-a", "host-supervisor", publicKey, now), /generation_changed/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, { ...current, no_recreation_guard_active: false }, "job-a", "host-supervisor", publicKey, now), /generation_changed/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt,
    { ...current, worker_creation_frozen: "false" } as unknown as MaintenanceFenceCurrentState,
    "job-a", "host-supervisor", publicKey, now), /generation_changed/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt,
    { ...current, active: "false" } as unknown as MaintenanceFenceCurrentState,
    "job-a", "host-supervisor", publicKey, now), /generation_changed/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, current, "job-a", "host-supervisor", publicKey,
    new Date("2026-09-26T00:01:00.000Z")), /receipt_expired/);
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, current, "job-a", "host-supervisor", publicKey,
    new Date("invalid")), /receipt_expired/);
  const ecKey = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey;
  assert.throws(() => verifyMaintenanceFenceReceipt(receipt, current, "job-a", "host-supervisor", ecKey, now), /signature_invalid/);
});

test("不完全inventory、停止未証明、署名改変、重複scopeを拒否する", () => {
  for (const change of [
    { herdr_inventory_complete: false }, { process_tree_inventory_complete: false },
    { terminal_stop_complete: false }, { worker_creation_frozen: false },
    { job_ids: ["job-a", "job-a"] },
  ]) {
    const candidate = signed({ ...body, ...change } as MaintenanceFenceBody);
    assert.throws(() => verifyMaintenanceFenceReceipt(candidate, current, "job-a", "host-supervisor", publicKey, now), /receipt_invalid/);
  }
  const tampered = signed(body);
  tampered.body = { ...body, job_ids: ["job-c"] };
  assert.throws(() => verifyMaintenanceFenceReceipt(tampered, current, "job-c", "host-supervisor", publicKey, now), /signature_invalid/);
});
