# Taski sync architecture

Taski is offline-first. Every tap is applied to the UI immediately, written to
a durable local outbox, and replayed to the server when the device has network.
The server (Cloudflare D1) is the source of truth; Supabase is used only for a
one-time migration of the old `tasks` table and for optional realtime wake-ups.

```
 user action
     │
     ▼
 local UI + localStorage cache      ← instant, works fully offline
     │
     ▼
 outbox (taski_outbox_v1)           ← survives reload / app kill
     │  HLC-stamped op
     ▼
 POST /api/sync ──► D1 merge ──► op log ──► Supabase Broadcast (optional)
     │                              │
     └──────── snapshot / ops ◄─────┘
```

## Why this design

* **Instant launch**: the app shell, fonts and supabase-js are self-hosted and
  precached by the service worker. The task cache is rendered before any
  network request is made.
* **Offline writes**: all mutations go through an outbox in `localStorage`.
  Nothing depends on a live socket; a failed request only delays the replay.
* **Deterministic conflict resolution**: actions carry a Hybrid Logical Clock
  (HLC) version stamped when the user acted, not when the request happened to
  reach the network.
* **Sticky deletes**: once a task is deleted, no field update can bring it
  back. This avoids zombie tasks and is the only rule that makes the
  complete-vs-delete example unambiguous.
* **Fast realtime feel**: Supabase Broadcast wakes every open client as soon as
  an op is accepted. A 3-second poll is the safety net if Broadcast is
  unavailable, and every reconnect/visibility change also triggers a sync.

## Version format

```
013-digit epoch ms : 6-digit counter : device-session
1700000000000:000003:abc123-def456
```

The clock is monotonic: if the wall clock stalls or moves backwards, the
counter is incremented instead. Versions are compared as strings (fixed-width
fields) on both the client and in SQL. Each tab appends a random session suffix
so two tabs on the same device cannot mint identical versions.

The client also learns the server clock offset from the sync response. This
keeps HLCs and `completedAt` timestamps comparable across devices without
trusting phone clocks blindly.

## Merge rules

Each field has its own version:

| Field | Operations | Conflict rule |
| --- | --- | --- |
| title | create, title | latest HLC wins |
| completed / completedAt | create, complete, uncomplete | latest HLC wins |
| position | create, position, uncomplete | latest HLC wins |
| deleted | delete | **terminal**; any delete beats every other action |

The server applies field-level last-writer-wins in one upsert per op. Once
`deleted = 1`, the `WHERE` clause prevents any create/complete/uncomplete/
position/title op from modifying the row. The tombstone is kept permanently so
a device that was offline for months still learns about the deletion.

The client materialises exactly the same rules locally in `sync.js`, so the
optimistic UI and the eventual snapshot agree.

### The 08:00 / 08:15 example

Device A completes a task offline at 08:00. Device B deletes it offline at
08:15. Either device may reconnect first:

* A reconnects first: the server stores `completed = 1`. B reconnects later;
  the delete sets `deleted = 1`, and the task disappears everywhere.
* B reconnects first: the server stores `deleted = 1`. A reconnects later; its
  complete op is ignored because the tombstone is terminal. The task stays
  deleted everywhere.

An older delete also wins over a newer complete, because deletion is not part
of the field-LWW race.

## Outbox and snapshots

* `taski_outbox_v1` stores pending ops. Each op has a unique id, so retries and
  duplicate deliveries are idempotent (`INSERT OR IGNORE` in the op log).
* A task deletion removes all pending edits for that task and queues only the
  tombstone: once a task is deleted, replaying an older edit is wasted work.
* On a full sync the server returns a snapshot of live tasks plus all
  tombstones. The client replaces its materialised tasks, then re-applies any
  still-unacknowledged outbox ops. A response that races with a local tap can
  therefore never lose that tap.
* If the server cannot return a usable cursor range (for example the op log was
  pruned), it automatically falls back to a full snapshot.
* Op ids are removed from the outbox only after the server acknowledges or
  explicitly rejects them.

## Realtime and polling

1. Supabase Broadcast on topic `taski-sync` wakes clients to pull immediately.
2. A 3-second poll runs while the page is visible.
3. `online`, `focus` and `visibilitychange` also trigger a sync.
4. Failures retry with exponential backoff (2s → 30s) and retry immediately on
   reconnect.
5. `pagehide` attempts a `keepalive` flush. If the browser drops it, the outbox
   is still on disk and the next launch replays it.

Broadcast is only a notification: if it is down or blocked by RLS, polling
keeps every device convergent.

## Storage keys

| Key | Contents |
| --- | --- |
| `taski_tasks` | last materialised task list (instant paint + migration) |
| `taski_sync_v1` | device id, cursor, HLC clock, tombstones, sync metadata |
| `taski_outbox_v1` | pending actions |
| `taski_supabase_env` | cached realtime URL/key |
| `taski_theme` | device-local theme (never synced) |

## API

`POST /api/sync`

```json
{
  "deviceId": "…",
  "cursor": 0,
  "full": true,
  "ops": [
    {
      "id": "op-…",
      "type": "complete",
      "taskId": "…",
      "hlc": "1700000000000:000000:device-session",
      "clientTs": 1700000000000,
      "deviceId": "…",
      "payload": { "completedAt": 1700000000000 }
    }
  ],
  "clientTime": 1700000000000
}
```

Response (snapshot or incremental):

```json
{
  "ok": true,
  "serverTime": 1700000000000,
  "cursor": 42,
  "acked": ["op-…"],
  "rejected": [],
  "snapshot": {
    "tasks": [
      {
        "id": "…",
        "title": "…",
        "completed": false,
        "completedAt": null,
        "position": 1000,
        "versions": { "title": "…", "completed": "…", "position": "…" }
      }
    ],
    "tombstones": [{ "id": "…", "version": "…" }]
  }
}
```

Incremental responses use `ops` instead of `snapshot` and may set
`"hasMore": true`; the client immediately pulls the next page.

The API is public, matching the existing anon-key deployment. It validates ids,
op types, HLC format, title length, positions and timestamps, and limits
requests to 200 ops / 512 KiB.

## Limits and trade-offs

* `localStorage` is used for durability because it is synchronous and available
  everywhere the current app runs. A future native wrapper would use SQLite.
* Device clocks are corrected against the server, but a client that has never
  synced can still be skewed. HLC monotonicity prevents it from minting older
  versions after it has seen any remote version.
* The tombstone table grows forever. For a personal task list this is tiny; if
  it ever matters, tombstones can be compacted once every known device has
  advanced past them (requires device tracking).
* There are no accounts. Any holder of the URL can read/write the shared task
  list, exactly like the previous public Supabase table.

## Testing

```bash
node --test tests/*.test.js
```

The client suite covers HLC monotonicity, complete/uncomplete and
complete/delete in both delivery orders, zombie prevention, field independence,
duplicate ops, snapshot tombstones, outbox replay after a snapshot, delete
superseding pending edits, restart durability and uncomplete versioning.

For an end-to-end check:

```bash
npx wrangler pages dev . --port 8788
curl -s http://127.0.0.1:8788/api/sync \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"test","cursor":0,"full":true,"ops":[]}'
```

## Deployment

```bash
npx wrangler pages deploy . --project-name taski
```

`wrangler.toml` binds D1 (`TASKI_DB`), KV (`TASKI_KV`) and the Supabase URL/key
vars. The schema is created lazily on the first request. Supabase tasks are
seeded once into D1 and also written to the op log, so devices that already
completed a first sync still receive them.
