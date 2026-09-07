import type Database from "better-sqlite3";

// Dispatcher user_version は維持する。独立 component version と additive table のみ。
export function migrateConnections(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS connection_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)`);
    const row = db.prepare("SELECT version FROM connection_schema WHERE singleton=1").get() as { version: number } | undefined;
    if (row && row.version !== 1) throw new Error("Unsupported connection schema");
    if (row?.version === 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_attempts (
          digest TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
          provider TEXT NOT NULL, account TEXT NOT NULL, revision INTEGER NOT NULL,
          credential_revision INTEGER NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL,
          provider_id TEXT NOT NULL, verification_epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','claimed','consumed')),
          claim_id TEXT, claim_until INTEGER, created_at INTEGER NOT NULL, consumed_at INTEGER,
          CHECK((state='pending' AND claim_id IS NULL AND claim_until IS NULL AND consumed_at IS NULL)
            OR (state='claimed' AND claim_id IS NOT NULL AND claim_until IS NOT NULL AND consumed_at IS NULL)
            OR (state='consumed' AND claim_id IS NOT NULL AND claim_until IS NOT NULL AND consumed_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS verification_attempt_expiry_idx ON verification_attempts(state,expires_at);
        CREATE INDEX IF NOT EXISTS verification_attempt_expires_at_idx ON verification_attempts(expires_at);
      `);
      const columns = db.prepare("PRAGMA table_info(verification_attempts)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "verification_epoch"))
        db.exec("ALTER TABLE verification_attempts ADD COLUMN verification_epoch INTEGER NOT NULL DEFAULT 0");
      return;
    }
    db.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, config_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        state TEXT NOT NULL CHECK(state IN ('verification_pending','active','degraded','disabled')),
        last_clock INTEGER NOT NULL
      );
      CREATE INDEX connections_provider_idx ON connections(provider);
      CREATE TABLE connection_subscriptions (
        connection_id TEXT NOT NULL REFERENCES connections(id), resource TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0), revision INTEGER NOT NULL,
        provider_id TEXT, state TEXT NOT NULL CHECK(state IN
          ('verification_pending','active','expiring','renewal_unknown','stop_candidate','stopped')),
        created_at INTEGER NOT NULL, verified_at INTEGER, expires_at INTEGER, renewal_window_ms INTEGER NOT NULL DEFAULT 0, verification_epoch INTEGER NOT NULL DEFAULT 0,
        last_delivery_at INTEGER, last_reconcile_at INTEGER, error TEXT,
        PRIMARY KEY(connection_id,resource,generation), UNIQUE(connection_id,resource,provider_id)
      );
      CREATE INDEX connection_subscription_due_idx ON connection_subscriptions(state,expires_at);
      CREATE TABLE connection_operations (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, resource TEXT NOT NULL,
        generation INTEGER NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','stop')),
        state TEXT NOT NULL CHECK(state IN ('inflight','unknown','done')),
        lease_until INTEGER NOT NULL,
        UNIQUE(connection_id,resource,generation,kind),
        FOREIGN KEY(connection_id,resource,generation) REFERENCES connection_subscriptions(connection_id,resource,generation)
      );
      CREATE INDEX connection_operation_lease_idx ON connection_operations(state,lease_until);
      CREATE TABLE connection_cursors (
        connection_id TEXT NOT NULL REFERENCES connections(id), resource TEXT NOT NULL,
        revision INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version>=0), checkpoint TEXT,
        PRIMARY KEY(connection_id,resource)
      );
      CREATE TABLE connection_event_bindings (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id), connection_id TEXT NOT NULL REFERENCES connections(id),
        revision INTEGER NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL,
        FOREIGN KEY(connection_id,resource,generation) REFERENCES connection_subscriptions(connection_id,resource,generation)
      );
      CREATE INDEX connection_event_binding_idx ON connection_event_bindings(connection_id,revision);
      CREATE TABLE connection_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL REFERENCES connections(id),
        revision INTEGER NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE verification_attempts (
        digest TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
        provider TEXT NOT NULL, account TEXT NOT NULL, revision INTEGER NOT NULL,
        credential_revision INTEGER NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL,
        provider_id TEXT NOT NULL, verification_epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','claimed','consumed')),
        claim_id TEXT, claim_until INTEGER, created_at INTEGER NOT NULL, consumed_at INTEGER,
        CHECK((state='pending' AND claim_id IS NULL AND claim_until IS NULL AND consumed_at IS NULL)
          OR (state='claimed' AND claim_id IS NOT NULL AND claim_until IS NOT NULL AND consumed_at IS NULL)
          OR (state='consumed' AND claim_id IS NOT NULL AND claim_until IS NOT NULL AND consumed_at IS NOT NULL))
      );
      CREATE INDEX verification_attempt_expiry_idx ON verification_attempts(state,expires_at);
      CREATE INDEX verification_attempt_expires_at_idx ON verification_attempts(expires_at);
      INSERT INTO connection_schema VALUES(1,1);
    `);
  }).immediate();
}

// queue の選別と queued→dispatching の同じ SQL 文に適用する。disable/revision 更新と直列化される。
export function connectionDispatchPredicateFor(eventAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(eventAlias)) throw new Error("Unsafe SQL alias");
  return `(NOT EXISTS (SELECT 1 FROM connections managed WHERE managed.provider=${eventAlias}.source)
  OR EXISTS (SELECT 1 FROM connection_event_bindings bound WHERE bound.event_id=${eventAlias}.event_id)) AND NOT EXISTS (
  SELECT 1 FROM connection_event_bindings b JOIN connections c ON c.id=b.connection_id
  LEFT JOIN connection_subscriptions s ON s.connection_id=b.connection_id AND s.resource=b.resource AND s.generation=b.generation
  WHERE b.event_id=${eventAlias}.event_id AND (c.state!='active' OR c.revision!=b.revision OR s.revision!=b.revision
    OR c.last_clock>? OR s.verified_at IS NULL OR s.state NOT IN ('active','expiring','stop_candidate') OR s.expires_at<=?)
)`;
}

export const connectionDispatchPredicate = connectionDispatchPredicateFor("events");
