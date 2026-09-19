import { z } from "zod";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const scopeSchema = z.strictObject({
  access_group: z.string().max(256).regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/).refine(value => !/\s/.test(value)),
  instance_id: identifier,
  purpose: z.enum(["audit_anchor", "clock_mark", "binding_generation", "policy_generation"]),
});
export type KeychainCasScope = z.infer<typeof scopeSchema>;
export interface KeychainCasEntry { revision: number; value: Uint8Array }
const valueSchema = z.string().min(1).max(10924).refine(value => {
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= 8192 && decoded.toString("base64") === value;
});
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ codec_version: z.literal(1), status: z.literal("observed"), revision, value: valueSchema }),
  z.strictObject({ codec_version: z.literal(1), status: z.literal("changed"), revision, value: valueSchema }),
  z.strictObject({ codec_version: z.literal(1), status: z.literal("conflict") }),
  z.strictObject({ codec_version: z.literal(1), status: z.literal("unverified") }),
]);
export type KeychainCasResponse = z.infer<typeof responseSchema>;
export class KeychainCasError extends Error {
  constructor() { super("keychain_cas_unverified"); this.name = "KeychainCasError"; }
}
function guard<T>(callback: () => T): T {
  try { return callback(); } catch {
    throw new KeychainCasError();
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function encodedValue(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8192) throw new KeychainCasError();
  return valueSchema.parse(Buffer.from(bytes).toString("base64"));
}
export function encodeKeychainCasRequest(scopeInput: unknown, expected?: KeychainCasEntry, proposed?: Uint8Array): string {
  return guard(() => {
    const scope = scopeSchema.parse(scopeInput);
    if (expected === undefined && proposed === undefined) return canonical({ codec_version: 1, operation: "read", scope });
    if (!expected || !proposed || revision.parse(expected.revision) === Number.MAX_SAFE_INTEGER) throw new KeychainCasError();
    const result = canonical({ codec_version: 1, operation: "compare_exchange", scope, expected_revision: expected.revision,
      expected_value: encodedValue(expected.value), proposed_value: encodedValue(proposed) });
    if (Buffer.byteLength(result) > 32768) throw new KeychainCasError();
    return result;
  });
}
export function parseKeychainCasResponse(raw: string): KeychainCasResponse {
  return guard(() => {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 16384) throw new KeychainCasError();
    const result = responseSchema.parse(JSON.parse(raw));
    const expected = canonical(result);
    if (raw !== expected && raw !== expected + "\n") throw new KeychainCasError();
    return result;
  });
}