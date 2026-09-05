import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeSlackEvent } from "../src/normalize.js";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: "Ev0123456789",
    team_id: "T01234567",
    authorizations: [{ user_id: "U_BOT" }],
    event: {
      type: "app_mention",
      user: "U01234567",
      channel: "C01234567",
      ts: "1756722030.123456",
      event_ts: "1756722030.123456",
      text: "今週の未処理事項を整理して",
    },
    ...overrides,
  };
}

describe("normalizeSlackEvent", () => {
  test("creates the common event envelope and preserves thread targeting", () => {
    const result = normalizeSlackEvent(payload(), new Date("2026-09-01T00:00:00Z"), "socket-envelope-1");
    assert.ok(result);
    assert.equal(result.envelope.external_event_id, "Ev0123456789");
    assert.equal(result.envelope.subject.thread_ts, "1756722030.123456");
    assert.equal(result.envelope.reply_target.thread_ts, "1756722030.123456");
    assert.deepEqual(result.envelope.payload, {
      text: "今週の未処理事項を整理して",
      event_ts: "1756722030.123456",
    });
    assert.deepEqual(result.envelope.trace, { socket_envelope_id: "socket-envelope-1" });
  });

  test("removes the bot mention from app_mention text", () => {
    const withMention = payload();
    (withMention.event as Record<string, unknown>).text = "<@U_BOT> 今週の未処理事項を整理して";
    const result = normalizeSlackEvent(withMention);
    assert.ok(result);
    assert.equal(result.envelope.payload.text, "今週の未処理事項を整理して");
  });

  test("ignores duplicate channel message events for app mentions but preserves DMs", () => {
    for (const channelType of ["channel", "group"]) {
      assert.equal(
        normalizeSlackEvent(
          payload({
            event: {
              type: "message",
              user: "U1",
              channel: "C1",
              channel_type: channelType,
              ts: "1.0",
              text: "<@U_BOT> hello",
            },
          }),
        ),
        null,
      );
    }

    const directMessage = normalizeSlackEvent(
      payload({
        event: {
          type: "message",
          user: "U1",
          channel: "D1",
          channel_type: "im",
          ts: "1.0",
          text: "<@U_BOT> hello",
        },
      }),
    );
    assert.ok(directMessage);
  });

  test("preserves safe file metadata without private download URLs", () => {
    const withFile = payload();
    (withFile.event as Record<string, unknown>).files = [
      {
        id: "F123",
        name: "diagram.png",
        title: "Architecture",
        mimetype: "image/png",
        filetype: "png",
        size: 2048,
        url_private: "https://files.slack.com/secret",
      },
    ];
    const result = normalizeSlackEvent(withFile);
    assert.ok(result);
    assert.deepEqual(result.envelope.payload.files, [
      {
        file_id: "F123",
        name: "diagram.png",
        title: "Architecture",
        mimetype: "image/png",
        filetype: "png",
        size_bytes: 2048,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result.envelope), /url_private|files\.slack\.com/);
  });

  test("accepts user-authored file_share messages", () => {
    const result = normalizeSlackEvent(
      payload({
        event: {
          type: "message",
          subtype: "file_share",
          user: "U1",
          channel: "C1",
          channel_type: "channel",
          ts: "1.0",
          text: "see file",
          files: [{ id: "F1", mimetype: "image/png" }],
        },
      }),
    );
    assert.ok(result);
    assert.equal(result.envelope.subject.channel_type, "channel");
    assert.deepEqual(result.envelope.payload.files, [
      { file_id: "F1", mimetype: "image/png" },
    ]);
  });

  test("preserves allow-listed Slack channel types for addressing decisions", () => {
    const directMessage = normalizeSlackEvent(
      payload({
        event: {
          type: "message",
          user: "U1",
          channel: "D1",
          channel_type: "im",
          ts: "1.0",
          text: "こんにちは",
        },
      }),
    );
    assert.ok(directMessage);
    assert.equal(directMessage.envelope.subject.channel_type, "im");

    const unknownType = normalizeSlackEvent(
      payload({
        event: {
          type: "message",
          user: "U1",
          channel: "C1",
          channel_type: "unexpected",
          ts: "1.0",
          text: "hello",
        },
      }),
    );
    assert.ok(unknownType);
    assert.equal(unknownType.envelope.subject.channel_type, undefined);
  });

  test("ignores bot, subtype, and non-allow-listed events", () => {
    assert.equal(
      normalizeSlackEvent(payload({ event: { type: "message", bot_id: "B1", channel: "C1", ts: "1.0" } })),
      null,
    );
    assert.equal(
      normalizeSlackEvent(payload({ event: { type: "message", subtype: "message_changed", channel: "C1", ts: "1.0" } })),
      null,
    );
    assert.equal(normalizeSlackEvent(payload({ event: { type: "reaction_added" } })), null);
    assert.equal(
      normalizeSlackEvent(payload({ event: { type: "message", user: "U_BOT", channel: "C1", ts: "1.0" } })),
      null,
    );
  });

  test("falls back to receive time when Slack timestamp is invalid", () => {
    const receivedAt = new Date("2026-09-01T00:00:00Z");
    const result = normalizeSlackEvent(
      payload({ event: { type: "message", user: "U1", channel: "C1", ts: "invalid", text: "hello" } }),
      receivedAt,
    );
    assert.ok(result);
    assert.equal(result.usedReceivedAt, true);
    assert.equal(result.envelope.occurred_at, receivedAt.toISOString());
    assert.deepEqual(result.envelope.trace, { occurred_at_source: "received_at" });
  });
});
