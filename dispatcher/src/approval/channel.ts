/** Core-to-adapter DTOs. Projections are transient and may contain exact private
 * draft text only after the gateway proves the bound supervisor's current
 * visibility. They are never audit, outbox, log or long-term DB payloads. */
export interface ApprovalProjection {
  readonly operation: "slack.post_thread_reply.v1";
  readonly target: {
    readonly workspace_id: string;
    readonly channel_id: string;
    readonly thread_ts: string;
    readonly workspace_display_name: string;
    readonly channel_display_name: string;
  };
  readonly exact_draft: string;
  readonly notified_user_ids: readonly string[];
  readonly expires_at: string;
}
export interface ApprovalPresentation {
  readonly request_handle: string;
  readonly presentation_revision: number;
  readonly notification_attempt_id: string;
  readonly projection: ApprovalProjection;
}
export type ApprovalDeliveryEvidence =
  | { readonly kind: "sent"; readonly presentation_ref: string }
  | { readonly kind: "known_rejected"; readonly reason: "forbidden" | "not_found" | "invalid_presentation" }
  | { readonly kind: "acceptance_unknown" };

/** A transport implementation is selected from trusted local configuration.
 * The broker must persist its dispatching fence and revalidate TTL, revisions,
 * requester authorization and supervisor visibility before invoking deliver.
 * This interface itself grants no permission and performs no automatic retry.
 * presentation_ref identifies adapter-persisted exact message identity/proof;
 * it is not a URL, access token or caller-provided supervisor identity. */
export interface ApprovalChannel {
  deliver(presentation: ApprovalPresentation): Promise<ApprovalDeliveryEvidence>;
  reconcile(notificationAttemptId: string): Promise<
    | { readonly kind: "one_exact_match"; readonly presentation_ref: string }
    | { readonly kind: "not_proven" }
    | { readonly kind: "multiple_exact_matches" }
  >;
}

/** The transport verifies its own authenticated provenance, persists it in its
 * durable inbox, then supplies this opaque reference to the broker. The broker
 * resolves it through that trusted adapter and checks current server bindings;
 * user-supplied proof IDs or a matching handle alone never authorize a decision.
 * Raw Slack Socket payloads and WebAuthn assertions stay inside their adapter. */
export interface ApprovalChannelCommand {
  readonly request_handle: string;
  readonly presentation_revision: number;
  readonly action: "approve" | "reject";
  readonly authenticated_inbox_ref: string;
}
