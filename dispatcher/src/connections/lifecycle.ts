import { stableStringify } from "../validation.js";
import { ConnectionError, type Connection, type Driver, type Operation, type OperationAuthority } from "./domain.js";
import { ConnectionRegistry } from "./registry.js";

export class ConnectionLifecycle {
  constructor(private readonly registry: ConnectionRegistry, private readonly driver: Driver,
    private readonly authority: OperationAuthority, private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new ConnectionError("invalid_input");
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConnectionError("operation_pending")), this.timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async connection(id: string): Promise<Connection> {
    const c = this.registry.get(id);
    if (c.state === "disabled") throw new ConnectionError("disabled");
    if (stableStringify(c.capability) !== stableStringify(this.driver.capability)) throw new ConnectionError("capability_mismatch");
    let available = false;
    try { available = await this.bounded(() => this.driver.credentialAvailable(c)); } catch { /* 非公開 driver error は出力しない */ }
    if (!available) { this.registry.degrade(id, c.revision); throw new ConnectionError("credential_unavailable"); }
    const current = this.registry.get(id);
    if (current.revision !== c.revision || current.state === "disabled") throw new ConnectionError("revision_conflict");
    return c;
  }
  async createOrRenew(id: string, resource: string): Promise<Operation> {
    const c = await this.connection(id);
    const request = { connectionId: id, revision: c.revision, resource, kind: "create" as const };
    let authorized = false;
    try { authorized = await this.bounded(() => this.authority.authorize(request)); } catch { /* fail closed */ }
    if (!authorized) throw new ConnectionError("not_authorized");
    const operation = this.registry.claim(id, c.revision, resource, this.timeoutMs);
    try {
      const result = await this.bounded(() => this.driver.create(c, operation));
      this.registry.observe(id, c.revision, resource, operation.generation, result, operation);
    } catch { this.registry.unknown(operation); }
    return operation;
  }
  async verify(id: string, resource: string, generation: number): Promise<void> {
    const c = await this.connection(id);
    const subscription = this.registry.subscriptions(id).find((s) => s.resource === resource && s.generation === generation);
    if (!subscription || subscription.providerId === null) throw new ConnectionError("not_found");
    let result;
    try { result = await this.bounded(() => this.driver.inspect(c, subscription)); }
    catch { this.registry.degrade(id, c.revision); throw new ConnectionError("not_authorized"); }
    this.registry.observe(id, c.revision, resource, generation, result);
  }
  async reconcile(id: string, operationId: string): Promise<void> {
    const c = await this.connection(id);
    const operation = this.registry.operations(id).find((o) => o.id === operationId);
    if (!operation || operation.revision !== c.revision) throw new ConnectionError("revision_conflict");
    if (operation.state === "done") return;
    if (operation.state === "inflight" && this.registry.clock.now() < operation.leaseUntil) throw new ConnectionError("operation_pending");
    this.registry.unknown(operation);
    // stop の応答不明も read-only lookup で「存在しない」を確認する。blind stop 不可。
    let result;
    try { result = await this.bounded(() => this.driver.lookup(c, operation)); }
    catch { throw new ConnectionError("operation_pending"); }
    if (operation.kind === "stop") {
      if (result !== null) throw new ConnectionError("operation_pending");
      this.registry.reconcileStopped(operation); return;
    }
    if (result === null) throw new ConnectionError("operation_pending");
    this.registry.observe(id, c.revision, operation.resource, operation.generation, result, operation);
  }
  async stop(id: string, resource: string, generation: number): Promise<Operation> {
    const c = await this.connection(id);
    let authorized = false;
    try { authorized = await this.bounded(() => this.authority.authorize({ connectionId: id, revision: c.revision, resource, kind: "stop" })); }
    catch { /* fail closed */ }
    if (!authorized) throw new ConnectionError("not_authorized");
    const operation = this.registry.claim(id, c.revision, resource, this.timeoutMs, "stop", generation);
    const target = this.registry.subscriptions(id).find((s) => s.resource === resource && s.generation === generation)!;
    try {
      await this.bounded(() => this.driver.stop(c, operation, target.providerId!));
      this.registry.stopped(operation);
    } catch { this.registry.unknown(operation); }
    return operation;
  }
}
