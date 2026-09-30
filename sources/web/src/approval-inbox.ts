import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const cursor = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const operation = z.literal("slack.post_thread_reply.v1");
const safeText = z.string().min(1).max(240).refine(value =>
  value === value.trim() && !value.includes("  ")
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Zs}]/u.test(value.replaceAll(" ", ""))
  && new TextDecoder("utf-8", {fatal: true}).decode(new TextEncoder().encode(value)) === value);
const literalText = z.string().min(1).max(4096).refine(value =>
  new TextDecoder("utf-8", {fatal: true}).decode(new TextEncoder().encode(value)) === value);
const ambiguousDisplay = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Zs}]/u;
const exactTargetSchema = z.strictObject({workspace_id: id, channel_id: id,
  thread_ts: z.string().regex(/^\d{10}\.\d{6}$/), display_name: literalText});
const fingerprintProjectionSchema = z.strictObject({opaque_action_id: id, operation, exact_target: exactTargetSchema,
  risk: z.enum(["elevated", "critical"]), expires_at: utc, presentation_revision: revision});
/** Canonical non-secret plan projection, with fixed field order and UTF-8 bytes. */
export function computeApprovalDisplayFingerprint(input: unknown): string {
  try {
    const value = fingerprintProjectionSchema.parse(input);
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  } catch { throw new ApprovalInboxUnavailable(); }
}

/** Version 1 reversible display codec from ADR 0002. Caller HTML-escapes the output. */
export function encodeApprovalDisplay(value: unknown): string {
  try {
    const raw = literalText.parse(value);
    return Array.from(raw, char => {
      if (char === "\\") return "\\\\";
      if (char === "\n") return "\\n";
      if (char === "\t") return "\\t";
      if (char !== " " && ambiguousDisplay.test(char))
        return `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
      return char;
    }).join("");
  } catch { throw new ApprovalInboxUnavailable(); }
}

const state = z.enum(["pending", "approved", "rejected", "expired", "needs_review"]);
const temporal = (item: {created_at: string; expires_at: string}) =>
  Date.parse(item.created_at) < Date.parse(item.expires_at)
  && Date.parse(item.expires_at) - Date.parse(item.created_at) <= 15 * 60_000;
/** Minimal list data; private target and draft require a separate current detail read. */
export const approvalInboxListItemSchema = z.strictObject({request_id: id, operation, requester: safeText,
  operation_summary: safeText, risk: z.enum(["elevated", "critical"]), created_at: utc, expires_at: utc, state}).refine(temporal);
/** Display data from a verified approval repository, never the action payload. */
export const approvalInboxItemSchema = z.strictObject({
  request_id: id, operation, requester: safeText, risk: z.enum(["elevated", "critical"]), risk_reason: safeText,
  opaque_action_id: id, operation_summary: safeText, exact_target: exactTargetSchema,
  exact_draft: literalText, resolved_mentions: z.array(z.strictObject({target_id: id, display: literalText})).max(3)
    .refine(mentions => new Set(mentions.map(mention => mention.target_id)).size === mentions.length),
  display_fingerprint: hash, created_at: utc, expires_at: utc,
  request_revision: revision, presentation_ref: id, presentation_revision: revision, display_codec_version: z.literal(1),
  state,
}).refine(item => temporal(item)
  && item.display_fingerprint === computeApprovalDisplayFingerprint({opaque_action_id: item.opaque_action_id,
    operation: item.operation, exact_target: item.exact_target, risk: item.risk,
    expires_at: item.expires_at, presentation_revision: item.presentation_revision}));
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>;
export const approvalInboxSchema = z.strictObject({ codec_version: z.literal(1), items: z.array(approvalInboxListItemSchema).max(50), next_cursor: cursor.nullable() })
  .refine(value => new Set(value.items.map(item => item.request_id)).size === value.items.length);
export const approvalInboxDetailSchema = z.strictObject({ codec_version: z.literal(1), item: approvalInboxItemSchema });

/** The browser confirms only a candidate. The authority must reread durable state. */
export const approvalDecisionCandidateSchema = z.strictObject({
  codec_version: z.literal(1), display_codec_version: z.literal(1), request_id: id, operation,
  decision: z.enum(["approve", "reject"]), expected_request_revision: revision,
  expected_presentation_ref: id, expected_presentation_revision: revision, expected_display_fingerprint: hash,
  expected_challenge_ref: id,
});
export type ApprovalDecisionCandidate = z.infer<typeof approvalDecisionCandidateSchema>;
export const approvalAuthorityEvidenceSchema = z.strictObject({
  principal_id: id, instance_id: id, tenant_id: id, workspace_id: id, supervisor_binding_id: id, binding_revision: revision,
  session_ref: id, session_generation: revision, authz_revision: revision,
  role: z.literal("supervisor"), step_up_verified: z.literal(true), csrf_verified: z.literal(true),
  request_id: id, operation, decision: z.enum(["approve", "reject"]), display_fingerprint: hash,
  persisted_action_hash: hash, presentation_action_hash: hash, request_revision: revision,
  presentation_ref: id, presentation_revision: revision, display_codec_version: z.literal(1),
  presentation_status: z.literal("synchronized_sent"), audience_principal_id: id,
  challenge_ref: id, challenge_state: z.literal("unused"), challenge_created_at: utc, challenge_expires_at: utc,
  challenge_request_id: id, challenge_decision: z.enum(["approve", "reject"]),
  challenge_action_hash: hash, challenge_display_fingerprint: hash, challenge_presentation_revision: revision,
  challenge_principal_id: id, challenge_session_ref: id, challenge_instance_id: id, challenge_tenant_id: id,
  challenge_workspace_id: id, challenge_supervisor_binding_id: id,
  challenge_binding_revision: revision, challenge_credential_id: id,
  challenge_policy_revision: revision,
  credential_id: id, credential_revision: revision, credential_state: z.literal("active"),
  credential_non_backup: z.literal(true), user_verified: z.literal(true),
  credential_stored_sign_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  assertion_sign_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  counter_unsupported_registration_proven: z.boolean(), credential_counter_cas_succeeded: z.literal(true),
  target_visible: z.literal(true), target_shared: z.literal(false), visibility_revision: revision,
  target_workspace_id: id,
  persisted_resource_snapshot_hash: hash, current_resource_snapshot_hash: hash,
  policy_revision: revision, requester_authorization_revision: revision,
  created_at: utc, expires_at: utc,
  state: z.literal("pending"), consumed: z.literal(false),
});
export type ApprovalAuthorityEvidence = z.infer<typeof approvalAuthorityEvidenceSchema>;

export class ApprovalInboxUnavailable extends Error {
  constructor() { super("approval_inbox_unavailable"); this.name = "ApprovalInboxUnavailable"; }
}

/** This is a preflight boundary, not an approval grant or a decision writer.
 * Evidence must be computed by a server authority from the current principal,
 * protected clock and persisted request in the decision transaction. */
export function assertApprovalDecisionCandidate(candidateInput: unknown, evidenceInput: unknown,
  expectedScope: { principal_id: string; instance_id: string; tenant_id: string; workspace_id: string;
    supervisor_binding_id: string; binding_revision: number;
    session_ref: string; session_generation: number; authz_revision: number; policy_revision: number;
    requester_authorization_revision: number; challenge_ref: string; credential_id: string;
    credential_revision: number; credential_stored_sign_count: number; visibility_revision: number }, now: string): ApprovalDecisionCandidate {
  try {
    const candidate = approvalDecisionCandidateSchema.parse(candidateInput);
    const evidence = approvalAuthorityEvidenceSchema.parse(evidenceInput);
    const scope = z.strictObject({ principal_id: id, instance_id: id, tenant_id: id, workspace_id: id,
      supervisor_binding_id: id, binding_revision: revision, session_ref: id, session_generation: revision, authz_revision: revision,
      policy_revision: revision, requester_authorization_revision: revision, challenge_ref: id,
      credential_id: id, credential_revision: revision,
      credential_stored_sign_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      visibility_revision: revision }).parse(expectedScope);
    const at = utc.parse(now);
    const requested = Buffer.from(candidate.expected_display_fingerprint, "hex");
    const current = Buffer.from(evidence.display_fingerprint, "hex");
    const action = Buffer.from(evidence.persisted_action_hash, "hex");
    const presented = Buffer.from(evidence.presentation_action_hash, "hex");
    if (evidence.principal_id !== scope.principal_id || evidence.instance_id !== scope.instance_id
      || evidence.tenant_id !== scope.tenant_id || evidence.workspace_id !== scope.workspace_id
      || evidence.supervisor_binding_id !== scope.supervisor_binding_id
      || evidence.binding_revision !== scope.binding_revision
      || evidence.session_ref !== scope.session_ref || evidence.session_generation !== scope.session_generation
      || evidence.authz_revision !== scope.authz_revision || evidence.policy_revision !== scope.policy_revision
      || evidence.requester_authorization_revision !== scope.requester_authorization_revision
      || evidence.challenge_ref !== scope.challenge_ref || evidence.credential_id !== scope.credential_id
      || evidence.credential_revision !== scope.credential_revision
      || evidence.credential_stored_sign_count !== scope.credential_stored_sign_count
      || ((evidence.credential_stored_sign_count !== 0 || evidence.assertion_sign_count !== 0)
        ? evidence.assertion_sign_count <= evidence.credential_stored_sign_count
        : !evidence.counter_unsupported_registration_proven)
      || evidence.visibility_revision !== scope.visibility_revision
      || evidence.target_workspace_id !== scope.workspace_id
      || evidence.audience_principal_id !== scope.principal_id
      || candidate.request_id !== evidence.request_id || candidate.operation !== evidence.operation
      || candidate.decision !== evidence.decision || candidate.display_codec_version !== evidence.display_codec_version
      || candidate.expected_request_revision !== evidence.request_revision
      || candidate.expected_presentation_ref !== evidence.presentation_ref
      || candidate.expected_presentation_revision !== evidence.presentation_revision
      || candidate.expected_challenge_ref !== evidence.challenge_ref
      || evidence.challenge_request_id !== evidence.request_id || evidence.challenge_decision !== evidence.decision
      || evidence.challenge_action_hash !== evidence.persisted_action_hash
      || evidence.challenge_display_fingerprint !== evidence.display_fingerprint
      || evidence.challenge_presentation_revision !== evidence.presentation_revision
      || evidence.challenge_principal_id !== evidence.principal_id || evidence.challenge_session_ref !== evidence.session_ref
      || evidence.challenge_instance_id !== evidence.instance_id || evidence.challenge_tenant_id !== evidence.tenant_id
      || evidence.challenge_workspace_id !== evidence.workspace_id
      || evidence.challenge_supervisor_binding_id !== evidence.supervisor_binding_id
      || evidence.challenge_binding_revision !== evidence.binding_revision
      || evidence.challenge_credential_id !== evidence.credential_id
      || evidence.challenge_policy_revision !== evidence.policy_revision
      || !timingSafeEqual(requested, current) || !timingSafeEqual(action, presented)
      || !timingSafeEqual(Buffer.from(evidence.persisted_resource_snapshot_hash, "hex"),
        Buffer.from(evidence.current_resource_snapshot_hash, "hex"))
      || Date.parse(evidence.created_at) >= Date.parse(evidence.expires_at)
      || Date.parse(evidence.created_at) > Date.parse(at)
      || Date.parse(evidence.expires_at) - Date.parse(evidence.created_at) > 15 * 60_000
      || Date.parse(at) >= Date.parse(evidence.expires_at)
      || Date.parse(evidence.challenge_expires_at) > Date.parse(evidence.expires_at)
      || Date.parse(evidence.challenge_created_at) < Date.parse(evidence.created_at)
      || Date.parse(evidence.challenge_created_at) > Date.parse(at)
      || Date.parse(evidence.challenge_created_at) >= Date.parse(evidence.challenge_expires_at)
      || Date.parse(evidence.challenge_expires_at) - Date.parse(evidence.challenge_created_at) > 2 * 60_000
      || Date.parse(at) >= Date.parse(evidence.challenge_expires_at)) throw Error();
    return candidate;
  } catch { throw new ApprovalInboxUnavailable(); }
}

export interface ApprovalInboxAuthority {
  /** Authenticated server-side repository read with current binding and visibility. */
  list(cursor: string | null): Promise<unknown>;
  detail(requestId: string): Promise<unknown>;
}

/** No default authority or decision transport exists while Epic #26 is incomplete. */
export class ApprovalInboxAdapter {
  constructor(private readonly authority?: ApprovalInboxAuthority) {}
  async list(nextCursor: string | null = null): Promise<z.infer<typeof approvalInboxSchema>> {
    if (!this.authority) throw new ApprovalInboxUnavailable();
    try { return approvalInboxSchema.parse(await this.authority.list(nextCursor === null ? null : cursor.parse(nextCursor))); }
    catch { throw new ApprovalInboxUnavailable(); }
  }
  async detail(requestId: string, currentWorkspaceId: string): Promise<z.infer<typeof approvalInboxDetailSchema>> {
    if (!this.authority) throw new ApprovalInboxUnavailable();
    try {
      const detail = approvalInboxDetailSchema.parse(await this.authority.detail(id.parse(requestId)));
      if (detail.item.request_id !== requestId || detail.item.exact_target.workspace_id !== id.parse(currentWorkspaceId)) throw Error();
      return detail;
    } catch { throw new ApprovalInboxUnavailable(); }
  }
}

/** Text-only view model for list, detail, and the human confirmation screen. */
export function approvalInboxView(itemInput: unknown, now: string, currentWorkspaceId: string) {
  try {
    const item = approvalInboxItemSchema.parse(itemInput);
    const at = utc.parse(now);
    if (item.exact_target.workspace_id !== id.parse(currentWorkspaceId)) throw Error();
    const canStartChallenge = item.state === "pending" && Date.parse(item.created_at) <= Date.parse(at)
      && Date.parse(at) < Date.parse(item.expires_at);
    return Object.freeze({
      title: item.operation_summary, operationKind: item.operation, exactTarget: item.exact_target, exactDraft: item.exact_draft,
      resolvedMentions: item.resolved_mentions, opaqueActionId: item.opaque_action_id,
      requester: item.requester, risk: item.risk, riskReason: item.risk_reason,
      displayFingerprint: item.display_fingerprint, createdAt: item.created_at, expiresAt: item.expires_at,
      status: canStartChallenge ? "確認準備中" : "再確認が必要", canStartChallenge,
    });
  } catch { throw new ApprovalInboxUnavailable(); }
}

const html = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Inert list/detail/confirm markup. The decision ceremony is deliberately
 * absent until the durable Web presentation and WebAuthn receipt API exist. */
export function renderApprovalInboxPreview(input: unknown, selectedDetailInput: unknown | null,
  now: string, currentWorkspaceId: string): string {
  try {
    const page = approvalInboxSchema.parse(input);
    const items = page.items;
    const selected = selectedDetailInput === null ? null : approvalInboxDetailSchema.parse(selectedDetailInput).item;
    const rows = items.map(item => {
      const at = utc.parse(now);
      const status = item.state === "pending" && Date.parse(item.created_at) <= Date.parse(at)
        && Date.parse(at) < Date.parse(item.expires_at) ? "確認準備中" : "再確認が必要";
      return `<li><span>${html(item.operation_summary)}</span><span>${html(item.requester)}</span><span>${html(status)}</span></li>`;
    }).join("");
    const detail = selected === null ? "" : (() => {
      const view = approvalInboxView(selected, now, currentWorkspaceId);
      return `<section aria-labelledby="approval-detail-title"><h2 id="approval-detail-title">承認内容の確認</h2>`
        + `<dl><dt>操作種別</dt><dd>${html(view.operationKind)}</dd><dt>概要</dt><dd>${html(view.title)}</dd>`
        + `<dt>対象workspace ID</dt><dd>${html(view.exactTarget.workspace_id)}</dd>`
        + `<dt>対象channel ID</dt><dd>${html(view.exactTarget.channel_id)}</dd>`
        + `<dt>対象thread timestamp</dt><dd>${html(view.exactTarget.thread_ts)}</dd>`
        + `<dt>対象表示名</dt><dd><pre>${html(encodeApprovalDisplay(view.exactTarget.display_name))}</pre></dd>`
        + `<dt>Action ID</dt><dd>${html(view.opaqueActionId)}</dd><dt>投稿本文</dt><dd><pre>${html(encodeApprovalDisplay(view.exactDraft))}</pre></dd>`
        + `<dt>解決済みmention</dt><dd><ul>${view.resolvedMentions.map(mention =>
          `<li><pre>${html(encodeApprovalDisplay(mention.display))}</pre> (${html(mention.target_id)})</li>`).join("")}</ul></dd>`
        + `<dt>依頼者</dt><dd>${html(view.requester)}</dd><dt>リスク</dt><dd>${html(view.risk)}</dd>`
        + `<dt>リスク理由</dt><dd>${html(view.riskReason)}</dd>`
        + `<dt>表示用指紋</dt><dd>${html(view.displayFingerprint)}</dd><dt>作成</dt><dd>${html(view.createdAt)}</dd>`
        + `<dt>期限</dt><dd>${html(view.expiresAt)}</dd></dl><p>\\n・\\t・\\u{...} は投稿内容の制御文字を表します。決定操作は準備中です。</p>`
        + `<button type="button" disabled>承認</button><button type="button" disabled>却下</button></section>`;
    })();
    return `<section aria-labelledby="approval-list-title"><h1 id="approval-list-title">承認待ち</h1><ul>${rows}</ul>`
      + (page.next_cursor === null ? "" : "<p>続きがあります。最新の一覧を確認してください。</p>") + `</section>${detail}`;
  } catch { throw new ApprovalInboxUnavailable(); }
}
