import { ConnectionError, type Connection, type ConnectionConfig } from "./domain.js";
import { ConnectionRegistry } from "./registry.js";
import { PrivateFileSecretStore } from "./secret-store.js";
import { stableStringify } from "../validation.js";

export class ProviderRegistrationService {
  constructor(private readonly connections: ConnectionRegistry, private readonly secrets: PrivateFileSecretStore) {}

  private async writeReconciled(config: ConnectionConfig, secret: Uint8Array): Promise<{ created: boolean }> {
    try { return await this.secrets.write(config.credentialRef, config.credentialRevision, secret); }
    catch (error) {
      if (!(error instanceof ConnectionError) || error.code !== "revision_conflict") throw error;
      const accepted = await this.secrets.reconcile(config.credentialRef, config.credentialRevision, secret).catch(() => false);
      if (!accepted) throw error;
      return { created: false };
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
      // filesystemとSQLiteを跨いだ削除raceを避け、未採用revisionはinactiveなimmutable orphanとして残す。
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
      // 旧revisionをactiveのまま維持し、未採用revisionを自動削除・再利用しない。
      throw error;
    }
  }
}
