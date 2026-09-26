import { verify, type KeyObject } from "node:crypto";

// The signer and the current-state reader must live outside the Dispatcher DB
// and its rollback domain. This module validates their contract; it does not
// create a fence or infer one from Herdr's agent status.
export interface MaintenanceFenceBody {
  schema_version: 1;
  issuer: string;
  host_boot_id: string;
  supervisor_generation: string;
  fence_generation: number;
  issued_at: string;
  expires_at: string;
  job_ids: string[];
  ingress_frozen: true;
  dispatcher_admission_frozen: true;
  updater_activation_frozen: true;
  worker_creation_frozen: true;
  herdr_inventory_complete: true;
  process_tree_inventory_complete: true;
  terminal_stop_complete: true;
  no_recreation_guard_active: true;
}

export interface SignedMaintenanceFenceReceipt {
  body: MaintenanceFenceBody;
  signature_base64: string;
}

export interface MaintenanceFenceCurrentState {
  host_boot_id: string;
  supervisor_generation: string;
  fence_generation: number;
  active: boolean;
  ingress_frozen: boolean;
  dispatcher_admission_frozen: boolean;
  updater_activation_frozen: boolean;
  worker_creation_frozen: boolean;
  no_recreation_guard_active: boolean;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

export function maintenanceFencePayload(body: MaintenanceFenceBody): Buffer {
  // Fixed field order and domain separator prevent alternate JSON encodings
  // or signatures for a different receipt type from being accepted.
  return Buffer.from(`dona.maintenance-fence.v1\n${JSON.stringify([
    body.schema_version, body.issuer, body.host_boot_id, body.supervisor_generation,
    body.fence_generation, body.issued_at, body.expires_at, body.job_ids,
    body.ingress_frozen, body.dispatcher_admission_frozen, body.updater_activation_frozen,
    body.worker_creation_frozen, body.herdr_inventory_complete,
    body.process_tree_inventory_complete, body.terminal_stop_complete,
    body.no_recreation_guard_active,
  ])}`, "utf8");
}

export function verifyMaintenanceFenceReceipt(
  receipt: SignedMaintenanceFenceReceipt,
  current: MaintenanceFenceCurrentState,
  expectedJobId: string,
  issuer: string,
  publicKey: KeyObject,
  now: Date,
): void {
  const body = receipt.body;
  if (body?.schema_version !== 1 || !validId(body.issuer) || body.issuer !== issuer ||
      !validId(body.host_boot_id) || !validId(body.supervisor_generation) ||
      !Number.isSafeInteger(body.fence_generation) || body.fence_generation < 1 ||
      !Array.isArray(body.job_ids) || body.job_ids.length < 1 || body.job_ids.length > 10_000 ||
      !body.job_ids.every(validId) || new Set(body.job_ids).size !== body.job_ids.length ||
      !body.job_ids.includes(expectedJobId) ||
      body.ingress_frozen !== true || body.dispatcher_admission_frozen !== true ||
      body.updater_activation_frozen !== true || body.worker_creation_frozen !== true ||
      body.herdr_inventory_complete !== true || body.process_tree_inventory_complete !== true ||
      body.terminal_stop_complete !== true || body.no_recreation_guard_active !== true) {
    throw new Error("maintenance_fence_receipt_invalid");
  }
  const issued = Date.parse(body.issued_at);
  const expires = Date.parse(body.expires_at);
  const currentTime = now.getTime();
  if (!Number.isFinite(currentTime) || !Number.isFinite(issued) || !Number.isFinite(expires) ||
      new Date(issued).toISOString() !== body.issued_at ||
      new Date(expires).toISOString() !== body.expires_at ||
      issued > currentTime || expires <= currentTime || expires <= issued ||
      expires - issued > 300_000) throw new Error("maintenance_fence_receipt_expired");
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519" ||
      typeof receipt.signature_base64 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature_base64) ||
      !verify(null, maintenanceFencePayload(body), publicKey, Buffer.from(receipt.signature_base64, "base64"))) {
    throw new Error("maintenance_fence_signature_invalid");
  }
  if (current.host_boot_id !== body.host_boot_id ||
      current.supervisor_generation !== body.supervisor_generation ||
      current.fence_generation !== body.fence_generation || current.active !== true ||
      current.ingress_frozen !== true || current.dispatcher_admission_frozen !== true ||
      current.updater_activation_frozen !== true || current.worker_creation_frozen !== true ||
      current.no_recreation_guard_active !== true) {
    throw new Error("maintenance_fence_generation_changed");
  }
}
