import { z } from "zod";
import { registryPrincipalSchema } from "./domain.js";
import { storedWebSessionSchema, storedPayloadSchema, verifyWebPayload } from "./model.js";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/\s/.test(value));
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const index = z.strictObject({ key_version: revision, digest });
const indexes = z.array(index).min(1).max(128).refine(values => new Set(values.map(value => value.key_version)).size === values.length);
const versions = z.array(revision).max(128).refine(values => values.every((value, i) => i === 0 || value > values[i - 1]!));
export const authReadInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("login_context") }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("session_lookup"), cookie_indexes: indexes }),
  z.strictObject({ codec_version: z.literal(1), operation: z.literal("principal_lookup"), subject_indexes: indexes }),
]);
const principalProjection = z.strictObject({ principal: registryPrincipalSchema, bff_generation: revision });
const sessionProjection = z.strictObject({ session: storedWebSessionSchema, principal: registryPrincipalSchema,
  bff_generation: revision, payload: storedPayloadSchema.nullable() }).superRefine((value, ctx) => {
  const session = value.session.state, principal = value.principal;
  let invalid = session.instance_id !== principal.instance_id || session.tenant_id !== principal.tenant_id
    || session.principal_id !== principal.principal_id || session.bff_generation > value.bff_generation;
  if (value.session.payload_ref === null) invalid ||= value.payload !== null;
  else { try { verifyWebPayload(value.payload, value.session); } catch { invalid = true; } }
  if (invalid) ctx.addIssue({ code: "custom", message: "web_read_projection_invalid" });
});
export const authReadResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("login_context"), bff_generation: revision, retained_subject_key_versions: versions }),
  z.strictObject({ operation: z.literal("session_lookup"), snapshot: sessionProjection.nullable() }),
  z.strictObject({ operation: z.literal("principal_lookup"), snapshot: principalProjection.nullable() }),
]);
export type AuthReadInput = z.infer<typeof authReadInputSchema>;
export type AuthReadResult = z.infer<typeof authReadResultSchema>;
export function validateReadBinding(input: AuthReadInput, result: AuthReadResult, scope: { instance_id: string; tenant_id: string }): void {
  id.parse(scope.instance_id); id.parse(scope.tenant_id);
  if (input.operation !== result.operation) throw Error("web_read_projection_invalid");
  if (result.operation !== "login_context" && result.snapshot !== null
    && (result.snapshot.principal.instance_id !== scope.instance_id || result.snapshot.principal.tenant_id !== scope.tenant_id)) throw Error("web_read_projection_invalid");
  if (input.operation === "session_lookup" && result.operation === "session_lookup" && result.snapshot !== null
    && !input.cookie_indexes.some(candidate => candidate.key_version === result.snapshot!.session.cookie_key_version
      && candidate.digest === result.snapshot!.session.cookie_digest)) throw Error("web_read_projection_invalid");
}
