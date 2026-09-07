import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ConnectionError, identifier, systemClock, type Clock, type ConnectionConfig, type DeliveryBinding } from "./domain.js";

const digest = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const sameBinding = (left: VerificationBinding, right: VerificationBinding): boolean =>
  left.connectionId === right.connectionId && left.provider === right.provider && left.account === right.account &&
  left.revision === right.revision && left.credentialRevision === right.credentialRevision &&
  left.resource === right.resource && left.generation === right.generation && left.providerId === right.providerId;

export interface VerificationBinding extends DeliveryBinding {
  provider: string;
  providerId: string;
}

export interface VerificationClaim {
  claimId: string;
  binding: VerificationBinding;
  claimUntil: number;
}

type AttemptRow = {
  connection_id: string; provider: string; account: string; revision: number; credential_revision: number;
  resource: string; generation: number; provider_id: string; expires_at: number; state: string;
  claim_id: string | null; claim_until: number | null;
};

export class ProviderRegistrationRegistry {
  constructor(private readonly db: Database.Database, private readonly clock: Clock = systemClock) {}

  private binding(input: Readonly<{ provider: string; providerId: string; connectionId?: string; account?: string; resource?: string }>, activeOnly: boolean): VerificationBinding {
    if (!identifier.safeParse(input.providerId).success || !identifier.safeParse(input.provider).success) throw new ConnectionError("invalid_input");
    const now = this.clock.now();
    if (!Number.isSafeInteger(now)) throw new ConnectionError("clock_skew");
    if (input.connectionId) {
      const clock = this.db.prepare("SELECT last_clock FROM connections WHERE id=?").get(input.connectionId) as { last_clock: number } | undefined;
      if (clock && now < clock.last_clock) throw new ConnectionError("clock_skew");
    }
    const rows = this.db.prepare(`SELECT c.id connection_id,c.provider,c.config_json,c.revision,c.last_clock,
      s.resource,s.generation,s.revision subscription_revision,s.provider_id,s.expires_at
      FROM connections c JOIN connection_subscriptions s ON s.connection_id=c.id
      WHERE c.provider=? AND s.provider_id=? AND c.state!='disabled' AND s.revision=c.revision
        AND ((?=1 AND c.state='active' AND s.verified_at IS NOT NULL AND s.state IN ('active','expiring'))
          OR (?=0 AND s.state IN ('verification_pending','active','expiring')))
        AND (s.expires_at IS NULL OR s.expires_at>?)
        AND (? IS NULL OR c.id=?) AND (? IS NULL OR s.resource=?)`)
      .all(input.provider, input.providerId, activeOnly ? 1 : 0, activeOnly ? 1 : 0, now, input.connectionId ?? null, input.connectionId ?? null,
        input.resource ?? null, input.resource ?? null) as Array<{ connection_id: string; provider: string; config_json: string;
          revision: number; last_clock: number; resource: string; generation: number; subscription_revision: number; provider_id: string; expires_at: number | null }>;
    if (rows.some((row) => now < row.last_clock)) throw new ConnectionError("clock_skew");
    const matches = rows.flatMap((row) => {
      const config = JSON.parse(row.config_json) as ConnectionConfig;
      return input.account !== undefined && config.account !== input.account ? [] : [{
        connectionId: row.connection_id, provider: row.provider, account: config.account, revision: row.revision,
        credentialRevision: config.credentialRevision, resource: row.resource, generation: row.generation, providerId: row.provider_id,
      }];
    });
    if (matches.length !== 1) throw new ConnectionError(matches.length === 0 ? "not_authorized" : "invalid_transition");
    return matches[0]!;
  }

  resolve(input: Readonly<{ provider: string; providerId: string; connectionId?: string; account?: string; resource?: string }>): VerificationBinding {
    return this.binding(input, true);
  }

  issue(input: Readonly<{ provider: string; providerId: string; connectionId: string; account: string; resource: string }>, ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new ConnectionError("invalid_input");
    return this.db.transaction(() => {
      const binding = this.binding(input, false), now = this.clock.now();
      this.db.prepare("UPDATE connections SET last_clock=? WHERE id=?").run(now, binding.connectionId);
      // 1回のmaintenanceが長時間lockを保持しないよう削除数をboundedにする。
      this.db.prepare(`DELETE FROM verification_attempts WHERE rowid IN (SELECT rowid FROM verification_attempts
        WHERE expires_at<=? OR state='consumed' ORDER BY expires_at LIMIT 100)`).run(now);
      const token = randomBytes(32).toString("base64url");
      this.db.prepare(`INSERT INTO verification_attempts(digest,connection_id,provider,account,revision,credential_revision,
        resource,generation,provider_id,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`)
        .run(digest(token), binding.connectionId, binding.provider, binding.account, binding.revision,
          binding.credentialRevision, binding.resource, binding.generation, binding.providerId, now + ttlMs, now);
      return token;
    }).immediate();
  }

  claim(token: string, expected: VerificationBinding, leaseMs: number): VerificationClaim {
    if (typeof token !== "string" || token.length < 40 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000)
      throw new ConnectionError("invalid_input");
    return this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.prepare("SELECT * FROM verification_attempts WHERE digest=?").get(digest(token)) as AttemptRow | undefined;
      if (!row || row.expires_at <= now || row.state === "consumed") throw new ConnectionError("not_authorized");
      const actual: VerificationBinding = { connectionId: row.connection_id, provider: row.provider, account: row.account,
        revision: row.revision, credentialRevision: row.credential_revision, resource: row.resource,
        generation: row.generation, providerId: row.provider_id };
      if (!sameBinding(actual, expected)) throw new ConnectionError("not_authorized");
      const current = this.binding({ provider: actual.provider, providerId: actual.providerId, connectionId: actual.connectionId,
        account: actual.account, resource: actual.resource }, false);
      if (current.revision !== actual.revision || current.credentialRevision !== actual.credentialRevision || current.generation !== actual.generation)
        throw new ConnectionError("not_authorized");
      if (row.state === "claimed" && row.claim_until! > now) throw new ConnectionError("operation_pending");
      const claimId = randomUUID(), claimUntil = Math.min(row.expires_at, now + leaseMs);
      const changed = this.db.prepare(`UPDATE verification_attempts SET state='claimed',claim_id=?,claim_until=?
        WHERE digest=? AND state!='consumed' AND expires_at>? AND (state='pending' OR claim_until<=?)`)
        .run(claimId, claimUntil, digest(token), now, now).changes;
      if (changed !== 1) throw new ConnectionError("operation_pending");
      this.db.prepare("UPDATE connections SET last_clock=? WHERE id=?").run(now, actual.connectionId);
      return { claimId, binding: actual, claimUntil };
    }).immediate();
  }

  consume(token: string, claimId: string): VerificationBinding {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.prepare("SELECT * FROM verification_attempts WHERE digest=?").get(digest(token)) as AttemptRow | undefined;
      if (!row || row.state !== "claimed" || row.claim_id !== claimId || row.claim_until! <= now || row.expires_at <= now)
        throw new ConnectionError("not_authorized");
      const actual: VerificationBinding = { connectionId: row.connection_id, provider: row.provider, account: row.account,
        revision: row.revision, credentialRevision: row.credential_revision, resource: row.resource,
        generation: row.generation, providerId: row.provider_id };
      const current = this.binding({ provider: actual.provider, providerId: actual.providerId, connectionId: actual.connectionId,
        account: actual.account, resource: actual.resource }, false);
      if (!sameBinding(current, actual)) throw new ConnectionError("not_authorized");
      const changed = this.db.prepare(`UPDATE verification_attempts SET state='consumed',consumed_at=?
        WHERE digest=? AND state='claimed' AND claim_id=?`).run(now, digest(token), claimId).changes;
      if (changed !== 1) throw new ConnectionError("not_authorized");
      this.db.prepare("UPDATE connections SET last_clock=? WHERE id=?").run(now, actual.connectionId);
      return actual;
    }).immediate();
  }
}
