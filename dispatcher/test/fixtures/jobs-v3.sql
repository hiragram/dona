-- #46 の互換fixture。origin/feature/multi-job-fanout e241fb41087a9b4a6aa5329cf1aaf60148e4c0d0 の v2→v3 migration SQL。

      CREATE TABLE jobs_v3 (
        job_id                TEXT PRIMARY KEY,
        source_event_id       TEXT NOT NULL REFERENCES events(event_id),
        job_key               TEXT NOT NULL DEFAULT 'legacy-default',
        source                TEXT NOT NULL,
        workspace_id          TEXT,
        channel_id            TEXT,
        thread_ts             TEXT,
        actor_id              TEXT,
        objective             TEXT NOT NULL,
        workspace_json        TEXT NOT NULL,
        status                TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'dispatching', 'running', 'retryable_failed', 'blocked', 'completed', 'failed', 'cancelling', 'cancelled', 'needs_review')),
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        available_at          TEXT NOT NULL,
        workspace_path        TEXT NOT NULL,
        result_path           TEXT NOT NULL,
        herdr_workspace_id    TEXT,
        herdr_pane_id         TEXT,
        agent_name            TEXT NOT NULL UNIQUE,
        dispatch_started_at   TEXT,
        prompt_accepted_at    TEXT,
        completed_at          TEXT,
        result_json           TEXT,
        completion_event_id   TEXT REFERENCES events(event_id),
        steer_event_id        TEXT,
        steer_state           TEXT CHECK (steer_state IN ('dispatching', 'accepted') OR steer_state IS NULL),
        last_error_code       TEXT,
        last_error_message    TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        UNIQUE (source_event_id, job_key)
      );
      INSERT INTO jobs_v3 (
        job_id, source_event_id, job_key, source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, workspace_path, result_path,
        herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at, prompt_accepted_at,
        completed_at, result_json, completion_event_id, steer_event_id, steer_state,
        last_error_code, last_error_message, created_at, updated_at
      )
      SELECT
        job_id, source_event_id, 'legacy-default', source, workspace_id, channel_id, thread_ts, actor_id,
        objective, workspace_json, status, attempt_count, available_at, workspace_path, result_path,
        herdr_workspace_id, herdr_pane_id, agent_name, dispatch_started_at, prompt_accepted_at,
        completed_at, result_json, completion_event_id, steer_event_id, steer_state,
        last_error_code, last_error_message, created_at, updated_at
      FROM jobs;


      DROP TABLE jobs;
      ALTER TABLE jobs_v3 RENAME TO jobs;
      CREATE INDEX jobs_run_idx ON jobs(status, available_at, created_at);
      CREATE INDEX jobs_thread_idx ON jobs(workspace_id, channel_id, thread_ts, created_at);
      CREATE INDEX jobs_event_idx ON jobs(source_event_id, created_at);

  CREATE INDEX jobs_runnable_fair_idx
    ON jobs(source_event_id, created_at, job_id, available_at)
    WHERE status = 'queued'
;


      CREATE TABLE job_groups (
        source_event_id       TEXT PRIMARY KEY REFERENCES events(event_id),
        sealed_at             TEXT,
        notification_mode     TEXT NOT NULL CHECK (notification_mode IN ('grouped', 'legacy')),
        attention_event_id    TEXT REFERENCES events(event_id),
        all_terminal_event_id TEXT REFERENCES events(event_id),
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX job_groups_transition_idx
        ON job_groups(notification_mode, sealed_at, updated_at);
      INSERT INTO job_groups (
        source_event_id, sealed_at, notification_mode, attention_event_id,
        all_terminal_event_id, created_at, updated_at
      )
      SELECT
        jobs.source_event_id,
        CASE
          WHEN events.status NOT IN ('dispatching', 'waiting_agent')
            THEN COALESCE(events.completed_at, events.updated_at, MAX(jobs.updated_at))
          ELSE NULL
        END,
        CASE
          WHEN MAX(CASE WHEN jobs.completion_event_id IS NOT NULL THEN 1 ELSE 0 END) = 1
            THEN 'legacy'
          ELSE 'grouped'
        END,
        NULL,
        NULL,
        MIN(jobs.created_at),
        MAX(jobs.updated_at)
      FROM jobs
      JOIN events ON events.event_id = jobs.source_event_id
      GROUP BY jobs.source_event_id;

PRAGMA user_version = 3;
