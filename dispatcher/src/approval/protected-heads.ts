import { types } from "node:util";
import { z } from "zod";
import { assertSynchronousCallback, assertSynchronousResult } from "../audit/synchronous.js";
import { auditAnchorSchema, type AuditAnchor } from "../audit/codec.js";
import type { AuditAnchorStore } from "../audit/repository.js";
import { parseClockMark, type ClockMark, type ClockMarkStore } from "./clock.js";
import { isTransactionUsed, prepareUsedTransactionInsert, type UsedTransactionScope } from "./used-transactions.js";
import type { ImmutableUsedTransactionNodes } from "./used-transaction-store.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().length(64).regex(/^[0-9a-f]+$/);
const scopeSchema = z.strictObject({ instance_id: id, ledger_id: id, purpose: z.enum(["clock_mark", "audit_anchor"]) });
const headSchema = z.strictObject({ codec_version: z.literal(1), kind: z.enum(["clock_mark", "audit_anchor"]),
  scope: scopeSchema, used_root: digest, last_reservation_id: id, state: z.unknown() });
const entrySchema = z.strictObject({ revision, value: z.string().min(1).max(8192) });
export type ProtectedHeadEntry = z.infer<typeof entrySchema>;
/** Implemented by the authenticated OS broker, not an ordinary DB/backup. Read
 * must be fresh and rollback-resistant. CAS compares every byte AND revision,
 * persists atomically, and returns only after durable readback. No retries. */
export interface ProtectedHeadPort {
  read(): ProtectedHeadEntry;
  compareExchange(expected: ProtectedHeadEntry, proposed: string): ProtectedHeadEntry;
}
type Common = Omit<z.infer<typeof headSchema>, "kind" | "state">;
export type ProtectedHead = Common & ({ kind: "clock_mark"; state: ClockMark } | { kind: "audit_anchor"; state: AuditAnchor });
export class ProtectedHeadError extends Error {
  constructor() { super("protected_head_unverified"); this.name = "ProtectedHeadError"; }
}
function guard<T>(operation: () => T): T { try { return operation(); } catch { throw new ProtectedHeadError(); } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function parsedHead(input: unknown): ProtectedHead {
  assertSynchronousResult(input); const head = headSchema.parse(input);
  if (head.kind !== head.scope.purpose) throw new ProtectedHeadError();
  if (head.kind === "clock_mark") {
    const state = parseClockMark(head.state); id.parse(state.transaction_id); id.parse(state.boot_id);
    if (state.previous_transaction_id !== null) id.parse(state.previous_transaction_id);
    if (state.transaction_id !== head.last_reservation_id) throw new ProtectedHeadError();
    return { ...head, kind: "clock_mark", state };
  }
  const state = auditAnchorSchema.parse(head.state); id.parse(state.chain_id);
  if (state.pending_transaction_id !== null && state.pending_transaction_id !== head.last_reservation_id) throw new ProtectedHeadError();
  return { ...head, kind: "audit_anchor", state };
}
/** Codec only; callers cannot bootstrap a protected provider with these bytes.
 * The initial reservation ID must already exist in the durably staged tree. */
export function encodeProtectedHead(input: unknown): string {
  return guard(() => { const encoded = canonical(parsedHead(input));
    if (Buffer.byteLength(encoded) > 8192) throw new ProtectedHeadError(); return encoded; });
}
function entry(input: unknown): ProtectedHeadEntry {
  assertSynchronousResult(input); const result = entrySchema.parse(input);
  if (Buffer.byteLength(result.value) > 8192) throw new ProtectedHeadError(); return result;
}
function method(object: object, name: string): (...args: unknown[]) => unknown {
  let current: object | null = object;
  for (let depth = 0; current !== null && depth < 16; depth++, current = Object.getPrototypeOf(current)) {
    if (types.isProxy(current)) throw new ProtectedHeadError();
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor)) throw new ProtectedHeadError(); assertSynchronousCallback(descriptor.value);
      return (...args) => Reflect.apply(descriptor.value, object, args);
    }
  }
  throw new ProtectedHeadError();
}
class HeadAccess {
  private readonly readPort: () => unknown;
  private readonly compareExchange: (...args: unknown[]) => unknown;
  private readonly stage: (...args: unknown[]) => unknown;
  private readonly readNode: (digest: string) => string | undefined;
  private readonly scope: UsedTransactionScope;
  constructor(scope: UsedTransactionScope, port: ProtectedHeadPort, nodes: ImmutableUsedTransactionNodes) {
    this.scope = guard(() => { assertSynchronousResult(scope); return Object.freeze(scopeSchema.parse(scope)); });
    [this.readPort, this.compareExchange, this.stage, this.readNode] = guard(() => {
      const read = method(nodes, "read");
      return [method(port, "read"), method(port, "compareExchange"), method(nodes, "stage"), (digest: string) => {
        const value = read(digest); if (value !== undefined && typeof value !== "string") throw new ProtectedHeadError(); return value;
      }];
    });
  }
  read(): { entry: ProtectedHeadEntry; head: ProtectedHead } {
    const observed = entry(this.readPort()); const head = parsedHead(JSON.parse(observed.value));
    if (encodeProtectedHead(head) !== observed.value || canonical(head.scope) !== canonical(this.scope)
      || !isTransactionUsed(this.scope, head.used_root, head.last_reservation_id, this.readNode)) throw new ProtectedHeadError();
    return { entry: observed, head };
  }
  update(before: ReturnType<HeadAccess["read"]>, state: ClockMark | AuditAnchor, transactionId?: string): ProtectedHead {
    if (before.entry.revision === Number.MAX_SAFE_INTEGER) throw new ProtectedHeadError();
    let next = parsedHead({ ...before.head, state, last_reservation_id: transactionId ?? before.head.last_reservation_id });
    if (transactionId !== undefined) {
      const plan = prepareUsedTransactionInsert(this.scope, before.head.used_root, transactionId, this.readNode);
      if (this.stage(plan.nodes) !== undefined) throw new ProtectedHeadError();
      if (!isTransactionUsed(this.scope, plan.proposed_root, transactionId, this.readNode)) throw new ProtectedHeadError();
      next = parsedHead({ ...next, used_root: plan.proposed_root });
    }
    const proposed = encodeProtectedHead(next);
    // The current readback also detects drift during auxiliary staging. A CAS
    // conflict still stops, even when another caller happened to propose bytes.
    const current = this.read();
    if (canonical(current.entry) !== canonical(before.entry)) throw new ProtectedHeadError();
    const accepted = entry(this.compareExchange(Object.freeze({ ...before.entry }), proposed));
    if (accepted.revision !== before.entry.revision + 1 || accepted.value !== proposed) throw new ProtectedHeadError();
    const after = this.read();
    if (canonical(after.entry) !== canonical(accepted)) throw new ProtectedHeadError(); return after.head;
  }
}

/** No default or memory-backed port is provided. The runtime must construct a
 * scope-bound authenticated broker port and this dedicated auxiliary store. */
export class ProtectedClockMarks implements ClockMarkStore {
  private readonly access: HeadAccess;
  constructor(scope: UsedTransactionScope, port: ProtectedHeadPort, nodes: ImmutableUsedTransactionNodes) {
    guard(() => { assertSynchronousResult(scope); if (scopeSchema.parse(scope).purpose !== "clock_mark") throw new ProtectedHeadError(); });
    this.access = new HeadAccess(scope, port, nodes);
  }
  read(): ClockMark { return guard(() => { const { head } = this.access.read(); if (head.kind !== "clock_mark") throw new ProtectedHeadError(); return head.state; }); }
  reserve(expectedInput: ClockMark, proposedInput: ClockMark): ClockMark {
    return guard(() => {
      assertSynchronousResult(expectedInput); assertSynchronousResult(proposedInput);
      const before = this.access.read(), expected = parseClockMark(expectedInput), proposed = parseClockMark(proposedInput);
      const elapsedUtc = Date.parse(proposed.effective_utc) - Date.parse(expected.effective_utc);
      if (before.head.kind !== "clock_mark" || canonical(expected) !== canonical(before.head.state)
        || proposed.previous_transaction_id !== expected.transaction_id || proposed.transaction_id === expected.transaction_id
        || proposed.boot_id !== expected.boot_id || proposed.continuous_ms < expected.continuous_ms
        || !Number.isSafeInteger(elapsedUtc) || elapsedUtc < proposed.continuous_ms - expected.continuous_ms) throw new ProtectedHeadError();
      const after = this.access.update(before, proposed, proposed.transaction_id);
      if (after.kind !== "clock_mark") throw new ProtectedHeadError(); return after.state;
    });
  }
}
export class ProtectedAuditAnchors implements AuditAnchorStore {
  private readonly access: HeadAccess;
  constructor(scope: UsedTransactionScope, port: ProtectedHeadPort, nodes: ImmutableUsedTransactionNodes) {
    guard(() => { assertSynchronousResult(scope); if (scopeSchema.parse(scope).purpose !== "audit_anchor") throw new ProtectedHeadError(); });
    this.access = new HeadAccess(scope, port, nodes);
  }
  read(): AuditAnchor { return guard(() => { const { head } = this.access.read(); if (head.kind !== "audit_anchor") throw new ProtectedHeadError(); return head.state; }); }
  reserve(expectedInput: AuditAnchor, proposedInput: AuditAnchor): AuditAnchor {
    return guard(() => {
      assertSynchronousResult(expectedInput); assertSynchronousResult(proposedInput);
      const before = this.access.read(), expected = auditAnchorSchema.parse(expectedInput), proposed = auditAnchorSchema.parse(proposedInput);
      if (before.head.kind !== "audit_anchor" || canonical(expected) !== canonical(before.head.state) || expected.pending_transaction_id !== null
        || proposed.chain_id !== expected.chain_id || proposed.pending_transaction_id === null) throw new ProtectedHeadError();
      const append = proposed.sequence === expected.sequence + 1 && proposed.mac !== expected.mac && proposed.checkpoint_mac === expected.checkpoint_mac;
      const retention = proposed.sequence === expected.sequence && proposed.mac === expected.mac && proposed.checkpoint_mac !== expected.checkpoint_mac;
      if (!append && !retention) throw new ProtectedHeadError();
      const after = this.access.update(before, proposed, proposed.pending_transaction_id);
      if (after.kind !== "audit_anchor") throw new ProtectedHeadError(); return after.state;
    });
  }
  finalize(reservationInput: AuditAnchor): AuditAnchor {
    return guard(() => {
      assertSynchronousResult(reservationInput); const reservation = auditAnchorSchema.parse(reservationInput), before = this.access.read();
      if (before.head.kind !== "audit_anchor" || reservation.pending_transaction_id === null || canonical(reservation) !== canonical(before.head.state)) throw new ProtectedHeadError();
      const after = this.access.update(before, { ...reservation, pending_transaction_id: null });
      if (after.kind !== "audit_anchor") throw new ProtectedHeadError(); return after.state;
    });
  }
}
