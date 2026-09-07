import { ConnectionError, type Connection, type ConnectionConfig } from "./domain.js";
import { ConnectionRegistry } from "./registry.js";
import { PrivateFileSecretStore } from "./secret-store.js";
import { timingSafeEqual } from "node:crypto";
import { stableStringify } from "../validation.js";

export class ProviderRegistrationService {
  constructor(private readonly connections: ConnectionRegistry, private readonly secrets: PrivateFileSecretStore) {}

  private async writeReconciled(config: ConnectionConfig, secret: Uint8Array): Promise<void> {
    try { await this.secrets.write(config.credentialRef, config.credentialRevision, secret); }
    catch (error) {
      const stored = await this.secrets.read(config.credentialRef, config.credentialRevision).catch(() => undefined);
      const expected = Buffer.from(secret);
      const accepted = stored !== undefined && stored.length === expected.length && timingSafeEqual(stored, expected);
      stored?.fill(0); expected.fill(0);
      if (!accepted) throw error;
    }
  }

  private accepted(id: string, config: ConnectionConfig, revision: number): Connection | undefined {
    try {
      const current = this.connections.get(id);
      return current.revision === revision && stableStringify({ ...current, revision: undefined, state: undefined }) ===
        stableStringify({ ...config, revision: undefined, state: undefined }) ? current : undefined;
    } catch { return undefined; }
  }

  async register(config: ConnectionConfig, secret: Uint8Array): Promise<Connection> {
    await this.writeReconciled(config, secret);
    try { return this.connections.register(config); }
    catch (error) {
      const accepted = this.accepted(config.id, config, 1);
      if (accepted) return accepted;
      await this.secrets.discard(config.credentialRef, config.credentialRevision).catch(() => undefined);
      throw error;
    }
  }

  async rotate(id: string, expectedRevision: number, config: ConnectionConfig, secret: Uint8Array): Promise<Connection> {
    const current = this.connections.get(id);
    if (config.credentialRevision <= current.credentialRevision) throw new ConnectionError("revision_conflict");
    await this.writeReconciled(config, secret);
    try { return this.connections.revise(id, expectedRevision, config); }
    catch (error) {
      const accepted = this.accepted(id, config, expectedRevision + 1);
      if (accepted) return accepted;
      await this.secrets.discard(config.credentialRef, config.credentialRevision).catch(() => undefined);
      throw error;
    }
  }
}
