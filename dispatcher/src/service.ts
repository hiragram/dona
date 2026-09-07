import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { HerdrProcessClient } from "./herdr.js";
import { ExternalIngressRegistry, type ExternalEventSourceRegistration } from "./ingress.js";
import { githubPilotRegistration } from "./providers/github.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { ConnectionError } from "./connections/domain.js";
import { createNotionRegistration, fetchLatestNotionState } from "./notion.js";
import { PrivateFileSecretStore } from "./connections/secret-store.js";
import { readPrivateBuffer } from "./private-token.js";
import { HerdrJobAgentRuntime } from "./job-runtime.js";
import { JobSupervisor } from "./job-supervisor.js";
import { createLogger } from "./logger.js";
import { DispatcherWorker } from "./worker.js";
import { UpdaterClient } from "./updater-client.js";
import {
  SlackAdapterNotificationClient,
  UpdateNotificationDatabase,
  UpdateNotificationWorker,
} from "./update-notification.js";

export function serviceExternalIngressRegistry(config: DispatcherConfig, database: DispatcherDatabase): ExternalIngressRegistry {
  const registrations = config.githubPilot ? [githubPilotRegistration({
    connectionId: config.githubPilot.connectionId,
    installationId: config.githubPilot.installationId,
    repositoryId: config.githubPilot.repositoryId,
    repositoryFullName: config.githubPilot.repositoryFullName,
    events: config.githubPilot.events,
    async resolveBinding() {
      const connection = database.connections.get(config.githubPilot!.connectionId);
      if (connection.provider !== "github" || connection.state !== "active" ||
        connection.account !== `installation:${config.githubPilot!.installationId}`) throw new Error("GitHub connection is not active");
      const resource = String(config.githubPilot!.repositoryId);
      const subscription = database.connections.subscriptions(connection.id).filter(candidate =>
        candidate.resource === resource && candidate.revision === connection.revision && candidate.verifiedAt !== null &&
        ["active", "expiring", "stop_candidate"].includes(candidate.state)).at(-1);
      if (!subscription) throw new Error("GitHub subscription is not active");
      return { account: connection.account, revision: connection.revision,
        credentialRevision: connection.credentialRevision, generation: subscription.generation };
    },
    async resolveWebhookSecret(credentialRevision) {
      const connection = database.connections.get(config.githubPilot!.connectionId);
      if (connection.credentialRevision !== credentialRevision) throw new Error("GitHub credential revision changed");
      const secret = await readPrivateBuffer(config.githubPilot!.webhookSecretPath);
      if (!secret) throw new Error("GitHub webhook secret is unavailable");
      return secret;
    },
  })] : [];
  if (config.notionPilot) {
    const pilot = config.notionPilot;
    const secrets = new PrivateFileSecretStore(pilot.secretStoreRoot);
    registrations.push(createNotionRegistration({ connectionId: pilot.connectionId,
      verificationSecretRef: pilot.verificationCredentialRef,
      secrets: { async get() {
        const connection = database.connections.get(pilot.connectionId);
        return { secret: await secrets.read(pilot.verificationCredentialRef, connection.credentialRevision),
          credentialRevision: connection.credentialRevision };
      } },
      verification: { async claim(input) {
        const snapshot = database.providerRegistration.inspectAttempt(input.attemptId);
        const expected = snapshot.binding;
        if (expected.provider !== "notion" || expected.delivery.connectionId !== pilot.connectionId) return undefined;
        const activate = () => database.connections.observe(expected.delivery.connectionId, expected.delivery.revision,
          expected.delivery.resource, expected.delivery.generation,
          { providerId: expected.providerId, expiresAt: null, verified: true, cutoverConfirmed: false },
          undefined, expected.verificationEpoch);
        const eventId = `verification:${createHash("sha256").update(input.attemptId).digest("hex")}`;
        if (snapshot.state === "consumed") {
          const stored = await secrets.read(pilot.verificationCredentialRef, expected.delivery.credentialRevision);
          const supplied = Buffer.from(input.token);
          const matches = stored.length === supplied.length && timingSafeEqual(stored, supplied);
          stored.fill(0); supplied.fill(0);
          if (matches) activate();
          return matches ? { binding: expected.delivery, providerEventId: eventId,
            occurredAt: new Date(snapshot.createdAt).toISOString() } : undefined;
        }
        const claim = database.providerRegistration.claim(input.attemptId, expected, 30_000);
        try { await secrets.write(pilot.verificationCredentialRef, expected.delivery.credentialRevision, input.token); }
        catch {
          const reconciled = await secrets.reconcile(pilot.verificationCredentialRef,
            expected.delivery.credentialRevision, input.token).catch(() => false);
          if (!reconciled) throw new Error("Notion verification secret is unavailable");
        }
        const consumed = database.providerRegistration.consume(input.attemptId, claim.claimId);
        activate();
        return { binding: consumed.delivery, providerEventId: eventId, occurredAt: new Date(snapshot.createdAt).toISOString() };
      } },
      bindings: { async resolve(input) {
        if (input.integrationId !== pilot.integrationId) return undefined;
        let resolved;
        try { resolved = database.providerRegistration.resolve({ provider: "notion", providerId: input.subscriptionId,
          connectionId: pilot.connectionId, account: input.workspaceId, resource: input.resourceId }); }
        catch (error) { if (error instanceof ConnectionError) return undefined; throw error; }
        if (input.credentialRevision !== undefined && input.credentialRevision !== resolved.delivery.credentialRevision) return undefined;
        const connection = database.connections.get(pilot.connectionId);
        const allowed = connection.allowlist.find(candidate => candidate.resource === input.resourceId)?.events.includes(input.eventType);
        return allowed ? resolved.delivery : undefined;
      } } }));
  }
  return new ExternalIngressRegistry(registrations);
}

export async function runService(
  config: DispatcherConfig,
  externalIngressRegistry?: ExternalIngressRegistry,
  additionalRegistrations: readonly ExternalEventSourceRegistration[] = [],
): Promise<void> {
  const apiLogger = createLogger("dispatcher_api");
  const workerLogger = createLogger("dispatcher_worker");
  const database = new DispatcherDatabase(config.databasePath, config.queuePolicy);
  externalIngressRegistry ??= serviceExternalIngressRegistry(config, database);
  for (const registration of additionalRegistrations) externalIngressRegistry.register(registration);
  const updateNotificationDatabase = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
  const herdr = new HerdrProcessClient({
    executable: config.herdrPath,
    session: config.herdrSession,
    agentName: config.agentName,
    waitTimeoutMs: config.agentWaitTimeoutMs,
  });
  const worker = new DispatcherWorker(database, herdr, config, workerLogger, config.notionPilot ? { async fetch(row) {
    if (row.source !== "notion") return { outcome: "degraded" };
    const subject = JSON.parse(row.subject_json) as Record<string, unknown>;
    if (subject.connection_id !== config.notionPilot!.connectionId || typeof subject.entity_id !== "string" ||
      !["page", "database", "data_source"].includes(String(subject.entity_type))) return { outcome: "degraded" };
    const connection = database.connections.get(config.notionPilot!.connectionId);
    const secretStore = new PrivateFileSecretStore(config.notionPilot!.secretStoreRoot);
    const token = await secretStore.read(connection.credentialRef, connection.credentialRevision);
    try {
      const kind = subject.entity_type === "page" ? "pages" : subject.entity_type === "database" ? "databases" : "data_sources";
      return fetchLatestNotionState({ async fetch(resourceId) {
        const response = await fetch(`https://api.notion.com/v1/${kind}/${encodeURIComponent(resourceId)}`, {
          method: "GET", headers: { authorization: `Bearer ${token.toString("utf8")}`, "notion-version": "2025-09-03" } });
        const retry = response.headers.get("retry-after");
        return { status: response.status, ...(retry === null ? {} : { retryAfter: Number(retry) }),
          ...(response.ok ? { value: await response.json() as Record<string, unknown> } : {}) };
      } }, subject.entity_id);
    } finally { token.fill(0); }
  } } : undefined);
  const jobSupervisor = new JobSupervisor(
    database,
    new HerdrJobAgentRuntime(config),
    config,
    createLogger("dispatcher_jobs"),
    () => worker.wake(),
  );
  const updateNotificationWorker = new UpdateNotificationWorker(
    database,
    updateNotificationDatabase,
    new SlackAdapterNotificationClient(config),
    config,
    createLogger("dispatcher_update_notifications"),
  );
  const api = new DispatcherApi(
    database,
    worker,
    jobSupervisor,
    config,
    apiLogger,
    new UpdaterClient(config.updaterSocketPath, config.jobCommandTimeoutMs),
    {
      async quiesce() {
        worker.quiesceAfterCurrent();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
      },
    },
    updateNotificationWorker,
    externalIngressRegistry,
  );

  try {
    await api.start();
    worker.start();
    jobSupervisor.start();
    updateNotificationWorker.start();
  } catch (error) {
    if (updateNotificationWorker.isRunning()) await updateNotificationWorker.stop();
    if (jobSupervisor.isRunning()) await jobSupervisor.stop();
    if (worker.isRunning()) await worker.stop();
    database.close();
    updateNotificationDatabase.close();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return;
      stopping = true;
      apiLogger.info("Graceful shutdown started", { signal });
      try {
        api.beginShutdown();
        await api.stop();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
        await worker.stop();
        database.close();
        updateNotificationDatabase.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}
