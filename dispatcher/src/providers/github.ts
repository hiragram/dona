import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ExternalIngressAuthenticationError,
  ExternalIngressValidationError,
  type ExternalEventSourceRegistration,
  type NormalizedExternalEvent,
  type RawIngressRequest,
  type VerifiedIngressPrincipal,
} from "../ingress.js";

const deliveryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventPattern = /^[a-z][a-z0-9_]{0,63}$/;

const repositorySchema = z.strictObject({ id: z.number().int().positive(), full_name: z.string().min(3).max(255) });
const installationSchema = z.strictObject({ id: z.number().int().positive() });
const payloadSchema = z.object({
  action: z.string().min(1).max(64),
  installation: installationSchema,
  repository: repositorySchema,
  issue: z.strictObject({ updated_at: z.string().datetime({ offset: true }) }),
}).passthrough();

export interface GitHubPilotConfig {
  readonly connectionId: string;
  readonly account: string;
  readonly connectionRevision: number;
  readonly credentialRevision: number;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly events: Readonly<Record<string, readonly string[]>>;
  readonly resolveWebhookSecret: () => Promise<Buffer>;
}

type GitHubPrincipal = {
  deliveryId: string;
  event: string;
  secretRevision: number;
};

function oneHeader(request: RawIngressRequest, name: string): string {
  const values = request.headers.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);
  if (values.length !== 1 || !values[0]) throw new ExternalIngressAuthenticationError();
  return values[0];
}

export function verifyGitHubSignature(body: Buffer, signature: string, secret: Buffer): void {
  if (!signature.startsWith("sha256=")) throw new ExternalIngressAuthenticationError();
  const encoded = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new ExternalIngressAuthenticationError();
  const supplied = Buffer.from(encoded, "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ExternalIngressAuthenticationError();
  }
}

function principal(verified: VerifiedIngressPrincipal): GitHubPrincipal {
  const parsed = z.strictObject({
    deliveryId: z.string(), event: z.string(), secretRevision: z.number().int().positive(),
  }).safeParse(verified.principal);
  if (!parsed.success) throw new ExternalIngressValidationError();
  return parsed.data;
}

export function githubPilotRegistration(config: GitHubPilotConfig): ExternalEventSourceRegistration {
  if (!Number.isSafeInteger(config.repositoryId) || config.repositoryId <= 0 || config.repositoryFullName.length < 3) {
    throw new Error("GitHub pilot repository allowlist is invalid");
  }
  return {
    source: "github",
    maxBodyBytes: 1_048_576,
    bodyTimeoutMs: 2_000,
    processingTimeoutMs: 9_500,
    async authenticate(request) {
      const deliveryId = oneHeader(request, "x-github-delivery");
      const event = oneHeader(request, "x-github-event");
      const signature = oneHeader(request, "x-hub-signature-256");
      if (!deliveryPattern.test(deliveryId) || !eventPattern.test(event) || !(event in config.events)) {
        throw new ExternalIngressAuthenticationError();
      }
      const secret = Buffer.from(await config.resolveWebhookSecret());
      try {
        if (secret.length < 32) throw new ExternalIngressAuthenticationError();
        verifyGitHubSignature(request.body, signature, secret);
      } finally {
        secret.fill(0);
      }
      return {
        connectionId: config.connectionId,
        resourceId: String(config.repositoryId),
        connection: {
          account: config.account,
          revision: config.connectionRevision,
          credentialRevision: config.credentialRevision,
          resource: String(config.repositoryId),
          generation: 1,
        },
        principal: { deliveryId, event, secretRevision: config.credentialRevision },
      };
    },
    normalize(request, verified) {
      const identity = principal(verified);
      let raw: unknown;
      try { raw = JSON.parse(request.body.toString("utf8")); } catch { throw new ExternalIngressValidationError(); }
      const payload = payloadSchema.safeParse(raw);
      if (!payload.success || payload.data.repository.id !== config.repositoryId ||
          payload.data.repository.full_name !== config.repositoryFullName ||
          !config.events[identity.event]?.includes(payload.data.action)) {
        throw new ExternalIngressValidationError();
      }
      return {
        providerEventId: identity.deliveryId,
        type: `${identity.event}.${payload.data.action}`,
        occurredAt: new Date(payload.data.issue.updated_at).toISOString(),
        subject: {
          installation_id: payload.data.installation.id,
          repository_id: payload.data.repository.id,
          repository_full_name: payload.data.repository.full_name,
        },
        payload: { action: payload.data.action },
        replyTarget: null,
        trace: { github_delivery_id: identity.deliveryId },
      };
    },
    parseNormalized(input) { return input as NormalizedExternalEvent; },
    buildAcknowledgement(receipt) {
      return { statusCode: 202, body: { schema_version: 1, outcome: receipt.outcome, event_id: receipt.eventId } };
    },
  };
}

export interface GitHubInstallationTokenProvider { token(): Promise<string>; }

export class GitHubReadOnlyInstallationClient {
  constructor(
    private readonly repositoryFullName: string,
    private readonly tokens: GitHubInstallationTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
      throw new Error("GitHub repository allowlist is invalid");
    }
  }

  async get(path: string): Promise<unknown> {
    if (!/^\/[A-Za-z0-9_./?=&%-]*$/.test(path) || path.includes("..")) throw new Error("GitHub API path is invalid");
    const token = await this.tokens.token();
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repositoryFullName}${path}`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
    return response.json();
  }
}
