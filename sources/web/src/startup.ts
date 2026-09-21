import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseWebPolicy, type WebPolicy } from "./policy.js";
import { WebLoopbackTlsListener } from "./tls-listener.js";
import { type WebTlsMaterialProvider } from "./tls-material.js";
import { WebAuthReadClient } from "./auth-read-client.js";
import { WebAuthWriteClient } from "./auth-write-client.js";
import { WebSessionClient } from "./session-client.js";
import { OidcProtocol, type OidcSecrets, type OidcTransport } from "./oidc.js";
import { type WebServiceCredential } from "./service-auth.js";
import { type BrowserLoginKeys } from "./login-controller.js";
import { assertProtectionKey, type SessionProtectionKey } from "./session-protection.js";
import { identityInventoryVersions } from "./identity-index.js";
import { assertContextSigningKey } from "./context.js";
import { WebJobReadClient } from "./job-read-client.js";

export interface WebStartupProviders {
  keys: BrowserLoginKeys;
  protectedNow(): string;
  serviceSigning(reference: string): WebServiceCredential;
  serviceVersion(reference: string, version: number): WebServiceCredential | undefined;
  oidc: OidcSecrets;
  tls: WebTlsMaterialProvider;
}
export class WebStartupError extends Error {
  constructor() { super("web_startup_unverified"); this.name = "WebStartupError"; }
}
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const maximumStartupMs = 15000;

/** Explicit session restart gate and fixed loopback composition. Providers must
 * already be provisioned/authenticated by the local runtime; this class neither
 * creates credentials nor attests their OS protection. Importing does not start
 * a service. The optional transport is the same trusted OIDC dependency used by
 * protocol fixtures, never an HTTP request or configuration field. */
export class WebLoopbackStartup {
  private readonly policy: WebPolicy;
  private readonly connections;
  private listener: WebLoopbackTlsListener | undefined;
  private state: "new" | "starting" | "listening" | "closed" = "new";
  private startingTask: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private lastTime = -Infinity;
  private clockFailed = false;
  private started = 0;
  constructor(policy: WebPolicy, private readonly providers: WebStartupProviders, transport?: OidcTransport) {
    try {
      this.policy = parseWebPolicy(policy);
      if (this.policy.mode !== "loopback" || this.policy.listener.kind !== "direct_tls") throw Error();
      const scope = { instance_id: this.policy.instance_id, tenant_id: this.policy.tenant_id };
      const signing = () => providers.serviceSigning(this.policy.service_credential_ref);
      const lookup = (value: number) => providers.serviceVersion(this.policy.service_credential_ref, value);
      this.connections = {
        read: new WebAuthReadClient(this.policy.dispatcher_socket_path, scope, signing, lookup, this.now),
        write: new WebAuthWriteClient(this.policy.dispatcher_socket_path, scope, signing, lookup, this.now),
        session: new WebSessionClient(this.policy.dispatcher_socket_path, scope, signing, lookup, this.now),
        jobRead: new WebJobReadClient(this.policy.dispatcher_socket_path, scope, signing, lookup, this.now),
        oidc: new OidcProtocol(this.policy, providers.oidc, transport),
      };
    } catch { throw new WebStartupError(); }
  }
  private now = (): string => {
    try {
      const value = utc.parse(this.providers.protectedNow()), at = Date.parse(value);
      if (this.clockFailed || at < this.lastTime) throw Error();
      this.lastTime = at; return value;
    } catch { this.clockFailed = true; throw new WebStartupError(); }
  };
  private assertStarting(): void {
    if (this.state !== "starting" || performance.now() - this.started >= maximumStartupMs) throw new WebStartupError();
    this.now();
  }
  private configuration(expectedVersions?: readonly number[]): void {
    const keys = this.providers.keys, now = this.now(), at = Date.parse(now);
    const identityVersions = identityInventoryVersions(keys.identities());
    if (identityVersions.length > 128 || (expectedVersions !== undefined
      && JSON.stringify(identityVersions) !== JSON.stringify(expectedVersions))) throw new WebStartupError();
    const cookies = keys.cookies(), retained = z.array(version).min(1).max(128).parse(cookies.retained_versions);
    if (new Set(retained).size !== retained.length || cookies.keys.length !== retained.length
      || new Set(cookies.keys.map(key => key.version)).size !== retained.length) throw new WebStartupError();
    for (const key of cookies.keys) {
      if (!retained.includes(key.version)) throw new WebStartupError();
      assertProtectionKey(key, "web_cookie_index", at, false);
    }
    for (const purpose of ["web_cookie_index", "web_csrf", "web_access_token", "web_login_transaction"] as const) {
      const active = keys.active(purpose); assertProtectionKey(active, purpose, at, true);
      const lookup = keys.protection(purpose, active.version); assertProtectionKey(lookup, purpose, at, true);
      this.sameKey(active, lookup);
      if (purpose === "web_cookie_index") {
        const member = cookies.keys.find(key => key.version === active.version);
        if (!member) throw new WebStartupError(); this.sameKey(active, member);
      }
    }
    assertContextSigningKey(keys.context(), now); this.connections.oidc.assertConfiguration();
  }
  private sameKey(a: SessionProtectionKey, b: SessionProtectionKey): void {
    if (a.version !== b.version || a.purpose !== b.purpose || a.state !== b.state
      || a.activated_at !== b.activated_at || a.signing_expires_at !== b.signing_expires_at
      || !timingSafeEqual(a.secret, b.secret)) throw new WebStartupError();
  }
  private async performStart(): Promise<void> {
    this.assertStarting(); this.configuration();
    const before = await this.connections.read.read({ codec_version: 1, operation: "login_context" });
    this.assertStarting();
    if (before.operation !== "login_context" || before.bff_generation >= Number.MAX_SAFE_INTEGER) throw new WebStartupError();
    this.configuration(before.retained_subject_key_versions);
    const generation = before.bff_generation + 1;
    // Validate TLS material and construct the fixed controllers before the write;
    // no socket is bound by the listener constructor.
    this.listener = new WebLoopbackTlsListener(this.policy, { connections: this.connections, keys: this.providers.keys,
      protectedNow: this.now, generation, tls: this.providers.tls });
    this.assertStarting();
    const written = await this.connections.write.mutate({ codec_version: 1, operation: "restart", expected_generation: before.bff_generation });
    this.assertStarting();
    if (written.operation !== "restart" || written.result.status !== "succeeded" || written.result.kind !== "restarted"
      || written.result.generation !== generation) throw new WebStartupError();
    const after = await this.connections.read.read({ codec_version: 1, operation: "login_context" });
    this.assertStarting();
    if (after.operation !== "login_context" || after.bff_generation !== generation) throw new WebStartupError();
    this.configuration(after.retained_subject_key_versions);
    await this.listener.start(); this.assertStarting(); this.state = "listening";
  }
  start(): Promise<void> {
    if (this.state !== "new") return Promise.reject(new WebStartupError());
    this.state = "starting"; this.started = performance.now();
    this.startingTask = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.performStart(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { this.state = "closed"; void this.listener?.close(); reject(new WebStartupError()); }, maximumStartupMs);
        })]);
      } catch { this.state = "closed"; await this.listener?.close(); throw new WebStartupError(); }
      finally { clearTimeout(timer); }
    })();
    return this.startingTask;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed";
    this.closing = (async () => { await this.listener?.close(); await this.startingTask?.catch(() => {}); })();
    return this.closing;
  }
}
