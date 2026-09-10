import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { HerdrProcessClient } from "./herdr.js";
import { ExternalIngressRegistry, ExternalIngressUnavailableError, type ExternalEventSourceRegistration } from "./ingress.js";
import { githubPilotRegistration } from "./providers/github.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
    const notionConnection = database.connections.get(pilot.connectionId);
    if (notionConnection.provider !== "notion") throw new Error("Notion pilot connection must use the notion provider");
    if (notionConnection.capability.kind !== "manual" || notionConnection.capability.cursor) {
      throw new Error("Notion pilot requires a manual non-cursor connection capability");
    }
    if (notionConnection.allowlist.length !== 1) throw new Error("Notion pilot supports exactly one resource per connection");
    if (notionConnection.credentialRef === pilot.verificationCredentialRef) {
      throw new Error("Notion verification credential reference must be separate from the integration credential");
    }
    const providerIds = new Set(database.connections.subscriptions(pilot.connectionId)
      .filter(subscription => subscription.providerId !== null && subscription.revision === notionConnection.revision && subscription.state !== "stopped")
      .map(subscription => subscription.providerId));
    if (providerIds.size > 1) {
      throw new Error("Notion pilot supports exactly one webhook provider ID per connection");
    }
    const secrets = new PrivateFileSecretStore(pilot.secretStoreRoot);
    const verificationReference = (binding: { delivery: { revision: number; generation: number }; verificationEpoch: number }) =>
      `cred_notion_${createHash("sha256").update(`${pilot.verificationCredentialRef}\0${binding.delivery.revision}\0${binding.delivery.generation}\0${binding.verificationEpoch}`).digest("hex")}`;
    registrations.push(createNotionRegistration({ connectionId: pilot.connectionId,
      verificationSecretRef: pilot.verificationCredentialRef,
      secrets: { async get(_reference, event) {
        const connection = database.connections.get(pilot.connectionId);
        let binding;
        try { binding = database.providerRegistration.resolve({ provider: "notion", providerId: event.subscriptionId,
          connectionId: pilot.connectionId, account: event.workspaceId, resource: event.resourceId }); }
        catch (error) {
          if (error instanceof ConnectionError && ["not_found", "not_authorized", "disabled", "revision_conflict"].includes(error.code)) return undefined;
          throw error;
        }
        return { secret: await secrets.read(verificationReference(binding), 1),
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
          const stored = await secrets.read(verificationReference(expected), 1);
          const supplied = Buffer.from(input.token);
          const matches = stored.length === supplied.length && timingSafeEqual(stored, supplied);
          stored.fill(0); supplied.fill(0);
          return matches ? { binding: expected.delivery, providerEventId: eventId,
            occurredAt: new Date(snapshot.createdAt).toISOString() } : undefined;
        }
        const claim = database.providerRegistration.claim(input.attemptId, expected, 30_000);
        try { await secrets.write(verificationReference(expected), 1, input.token); }
        catch {
          const reconciled = await secrets.reconcile(verificationReference(expected), 1, input.token).catch(() => false);
          if (!reconciled) throw new Error("Notion verification secret is unavailable");
        }
        return { binding: expected.delivery, providerEventId: eventId, occurredAt: new Date(snapshot.createdAt).toISOString(),
          commit: () => database.providerRegistration.consume(input.attemptId, claim.claimId, activate) };
      } },
      bindings: { async resolve(input) {
        if (input.integrationId !== pilot.integrationId) return undefined;
        let resolved;
        try { resolved = database.providerRegistration.resolve({ provider: "notion", providerId: input.subscriptionId,
          connectionId: pilot.connectionId, account: input.workspaceId, resource: input.resourceId }); }
        catch (error) {
          if (error instanceof ConnectionError && ["not_found", "not_authorized", "disabled", "revision_conflict"]
            .includes(error.code)) return undefined;
          throw error;
        }
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
  for (const registration of additionalRegistrations) {
    if (registration.source !== "figma") { externalIngressRegistry.register(registration); continue; }
    externalIngressRegistry.register({...registration,async authenticate(request) {
      const verified=await registration.authenticate(request);
      let lookup;
      try {
        const connection=database.connections.get(verified.connectionId);
        lookup={connection,subscriptions:database.connections.subscriptions(connection.id)};
      } catch (error) {
        if (error instanceof ConnectionError && error.code!=="clock_skew") throw error;
        throw new ExternalIngressUnavailableError();
      }
      const {connection,subscriptions}=lookup;
      if (connection.provider!=="figma" || connection.state!=="active" || verified.resourceId===undefined) {
        throw new Error("Figma connection is not active");
      }
      const subscription=subscriptions.filter((candidate)=>candidate.resource===verified.resourceId &&
          candidate.providerId===verified.principal.webhook_id && candidate.revision===connection.revision && candidate.verifiedAt!==null &&
          (candidate.expiresAt===null || candidate.expiresAt>Date.now()) && ["active","expiring","stop_candidate"].includes(candidate.state)).at(-1);
      if (!subscription) throw new Error("Figma subscription is not active");
      return {...verified,connection:{account:connection.account,revision:connection.revision,
        credentialRevision:connection.credentialRevision,resource:verified.resourceId,generation:subscription.generation}};
    }});
  }
  const updateNotificationDatabase = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
  const herdr = new HerdrProcessClient({
    executable: config.herdrPath,
    session: config.herdrSession,
    agentName: config.agentName,
    waitTimeoutMs: config.agentWaitTimeoutMs,
  });
  const worker = new DispatcherWorker(database, herdr, config, workerLogger, config.notionPilot ? { async fetch(row, signal) {
    if (row.source !== "notion") return { outcome: "not_configured" };
    const subject = JSON.parse(row.subject_json) as Record<string, unknown>;
    if (subject.connection_id !== config.notionPilot!.connectionId || typeof subject.entity_id !== "string" ||
      !["page", "database", "data_source"].includes(String(subject.entity_type))) return { outcome: "degraded" };
    const connection = database.connections.get(config.notionPilot!.connectionId);
    const secretStore = new PrivateFileSecretStore(config.notionPilot!.secretStoreRoot);
    let token: Buffer;
    try { token = await secretStore.read(connection.credentialRef, connection.credentialRevision); }
    catch { return { outcome: "credential_unavailable" }; }
    try {
      const kind = subject.entity_type === "page" ? "pages" : subject.entity_type === "database" ? "databases" : "data_sources";
      const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      let requests = 0;
      return fetchLatestNotionState({ async fetch(resourceId) {
        const request = async (url: string, allowPartial = false) => {
          for (let attempt = 0; ; attempt += 1) {
            if (requests >= 100) return allowPartial
              ? { status: 200, value: { results: [], has_more: false, content_truncated: true } }
              : { status: 429 };
            requests += 1;
            let response: Response;
            try { response = await fetch(url, {
              method: "GET", signal: fetchSignal,
              headers: { authorization: `Bearer ${token.toString("utf8")}`, "notion-version": "2025-09-03" } }); }
            catch (error) {
              if (signal.aborted) throw error;
              if (fetchSignal.aborted && allowPartial) return { status: 200, value: { results: [], has_more: false, content_truncated: true } };
              throw error;
            }
            const retry = response.headers.get("retry-after");
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              const retryAfter = retry === null ? undefined : Number(retry);
              if (response.status === 429 && attempt < 2 && Number.isFinite(retryAfter)) {
                try { await delay(Math.max(0, retryAfter! * 1_000), undefined, { signal: fetchSignal }); }
                catch (error) {
                  if (signal.aborted) throw error;
                  if (fetchSignal.aborted && allowPartial) return { status: 200, value: { results: [], has_more: false, content_truncated: true } };
                  throw error;
                }
                continue;
              }
              return { status: response.status, ...(retryAfter === undefined ? {} : { retryAfter }) };
            }
            try { return { status: response.status, value: await response.json() as Record<string, unknown> }; }
            catch (error) {
              if (signal.aborted) throw error;
              if (fetchSignal.aborted && allowPartial) return { status: 200, value: { results: [], has_more: false, content_truncated: true } };
              throw error;
            }
          }
        };
        const resource = await request(`https://api.notion.com/v1/${kind}/${encodeURIComponent(resourceId)}`);
        // coalesce前のevent typeではなくpageのcurrent stateを取得し、混在signalでもcontentを落とさない。
        if (resource.status !== 200 || subject.entity_type !== "page") return resource;
        let blocks = 0, truncated = false;
        const readChildren = async (parentId: string, depth: number): Promise<unknown[] | { failure: typeof resource }> => {
          if (depth > 8 || requests >= 100 || blocks >= 1_000) { truncated = true; return []; }
          const children: unknown[] = [];
          let cursor: string | undefined;
          do {
            if (requests >= 100 || blocks >= 1_000) { truncated = true; break; }
            const url = new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(parentId)}/children`);
            url.searchParams.set("page_size", "100");
            if (cursor) url.searchParams.set("start_cursor", cursor);
            const page = await request(url.toString(), true);
            if (page.status === 404 && depth > 0) { truncated = true; return []; }
            if (page.status !== 200 || !page.value) return { failure: page };
            if (page.value.content_truncated === true) truncated = true;
            const results = Array.isArray(page.value.results) ? page.value.results : [];
            for (const candidate of results) {
              if (blocks >= 1_000) { truncated = true; break; }
              blocks += 1;
              if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).has_children === true &&
                typeof (candidate as Record<string, unknown>).id === "string") {
                const nested = await readChildren(String((candidate as Record<string, unknown>).id), depth + 1);
                if (!Array.isArray(nested)) return nested;
                children.push({ ...(candidate as Record<string, unknown>), children: nested });
              } else children.push(candidate);
            }
            cursor = page.value.has_more === true && typeof page.value.next_cursor === "string"
              ? page.value.next_cursor : undefined;
          } while (cursor);
          return children;
        };
        const children = await readChildren(resourceId, 0);
        if (!Array.isArray(children)) return children.failure;
        const propertyItems: Record<string, unknown> = {};
        const properties = resource.value?.properties;
        if (properties && typeof properties === "object") {
          for (const property of Object.values(properties as Record<string, unknown>)) {
            if (requests >= 100) { truncated = true; break; }
            if (!property || typeof property !== "object" || typeof (property as Record<string, unknown>).id !== "string") continue;
            const propertyId = String((property as Record<string, unknown>).id);
            let propertyPathId: string;
            try { propertyPathId = encodeURIComponent(decodeURIComponent(propertyId)); }
            catch { propertyPathId = encodeURIComponent(propertyId); }
            const items: unknown[] = [];
            let propertyItem: unknown;
            let cursor: string | undefined;
            do {
              if (requests >= 100) { truncated = true; break; }
              const url = new URL(`https://api.notion.com/v1/pages/${encodeURIComponent(resourceId)}/properties/${propertyPathId}`);
              url.searchParams.set("page_size", "100");
              if (cursor) url.searchParams.set("start_cursor", cursor);
              const page = await request(url.toString(), true);
              if (page.status === 404) { truncated = true; break; }
              if (page.status !== 200 || !page.value) return page;
              if (page.value.content_truncated === true) truncated = true;
              if (page.value.property_item !== undefined) propertyItem = page.value.property_item;
              if (Array.isArray(page.value.results)) items.push(...page.value.results);
              else items.push(page.value);
              cursor = page.value.has_more === true && typeof page.value.next_cursor === "string"
                ? page.value.next_cursor : undefined;
            } while (cursor);
            propertyItems[propertyId] = propertyItem === undefined ? items : { results: items, property_item: propertyItem };
          }
        }
        return { ...resource, value: { ...resource.value, children, property_items: propertyItems,
          content_truncated: truncated } };
      } }, subject.entity_id);
    } finally { token.fill(0); }
  }, async quarantine(row) {
    if (row.source !== "notion") return;
    const subject = JSON.parse(row.subject_json) as Record<string, unknown>;
    if (subject.connection_id !== config.notionPilot!.connectionId || typeof subject.entity_id !== "string") return;
    const connection = database.connections.get(config.notionPilot!.connectionId);
    const subscription = database.connections.subscriptions(connection.id).filter(candidate =>
      candidate.resource === subject.entity_id && candidate.revision === connection.revision && candidate.verifiedAt !== null).at(-1);
    if (subscription) database.connections.quarantine(connection.id, connection.revision,
      subscription.resource, subscription.generation, subscription.verificationEpoch);
  }, async degrade(row) {
    if (row.source !== "notion") return;
    const subject = JSON.parse(row.subject_json) as Record<string, unknown>;
    if (subject.connection_id !== config.notionPilot!.connectionId) return;
    const connection = database.connections.get(config.notionPilot!.connectionId);
    database.connections.degrade(connection.id, connection.revision);
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
