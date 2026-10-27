// ══════════════════════════════════════════════════════════════════
//  Taski Sync API — offline-first, server-authoritative merge
//
//  Clients send an ordered batch of local actions (ops) and the last
//  server sequence they have seen. Every op has a Hybrid Logical Clock
//  (HLC) stamped with the moment the user acted, not the moment the
//  request happened to reach the network.
//
//  Merge rules:
//    • title / completed / position are independent fields (field LWW)
//    • delete is a sticky tombstone; it wins over every other action
//    • op ids are idempotent, so retries can never duplicate actions
//
//  D1 is the source of truth. The old Supabase `tasks` table is read
//  once for migration and used afterwards only to fan out realtime
//  notifications (Supabase Broadcast), never for task state.
// ══════════════════════════════════════════════════════════════════

const HLC_RE = /^(\d{13}):(\d{6}):([a-z0-9_-]{1,32})$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const OP_TYPES = new Set(['create', 'title', 'complete', 'uncomplete', 'position', 'delete']);
const BASELINE = '0000000000000:000000:seed';
const MAX_OPS = 200;
const CHUNK_SIZE = 40;
const INCREMENTAL_LIMIT = 500;
const OP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEED_RETRY_MS = 5 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     completed INTEGER NOT NULL DEFAULT 0,
     completed_at INTEGER,
     position REAL NOT NULL DEFAULT 1000,
     deleted INTEGER NOT NULL DEFAULT 0,
     title_version TEXT NOT NULL DEFAULT '',
     completed_version TEXT NOT NULL DEFAULT '',
     position_version TEXT NOT NULL DEFAULT '',
     deleted_version TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ops (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     op_id TEXT NOT NULL UNIQUE,
     task_id TEXT NOT NULL,
     type TEXT NOT NULL,
     payload TEXT NOT NULL,
     hlc TEXT NOT NULL,
     client_ts INTEGER NOT NULL,
     device_id TEXT NOT NULL,
     received_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ops_received ON ops (received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks (deleted)`,
];

// One schema setup per worker isolate. If it fails, retry on the next request.
let schemaPromise = null;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
  });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function finitePosition(value, fallback = 1000) {
  const n = numberOrNull(value);
  return n === null ? fallback : n;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.batch(SCHEMA.map((sql) => db.prepare(sql)))
      .then(() => true)
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setMeta(db, key, value) {
  return db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .bind(key, String(value))
    .run();
}

async function fetchAllSupabaseTasks(url, key) {
  const rows = [];
  const pageSize = 1000;
  const select = 'id,text,completed,completedAt,position';
  for (let page = 0; page < 25; page += 1) {
    const from = page * pageSize;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetch(`${url}/rest/v1/tasks?select=${encodeURIComponent(select)}&order=id.asc`, {
        signal: controller.signal,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Range: `${from}-${from + pageSize - 1}`,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`Supabase seed HTTP ${res.status}`);
    const pageRows = await res.json();
    if (!Array.isArray(pageRows) || pageRows.length === 0) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return rows;
}

async function seedFromSupabase(db, env) {
  const seeded = await getMeta(db, 'seeded');
  if (seeded) return;

  const lastAttempt = Number(await getMeta(db, 'seed_attempt_at') || 0);
  if (lastAttempt && Date.now() - lastAttempt < SEED_RETRY_MS) return;

  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || '';

  if (!url || !key) {
    await setMeta(db, 'seeded', Date.now());
    return;
  }

  try {
    const rows = await fetchAllSupabaseTasks(url, key);
    const now = Date.now();
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const statements = [];
      for (let j = 0; j < chunk.length; j += 1) {
        const row = chunk[j];
        const position = finitePosition(row.position, (i + j + 1) * 1000);
        const completedAt = parseTimestamp(row.completedAt);
        const payload = JSON.stringify({
          title: String(row.text ?? ''),
          position,
          completed: !!row.completed,
          completedAt,
        });
        statements.push(db.prepare(`
          INSERT OR IGNORE INTO tasks (
            id, title, completed, completed_at, position, deleted,
            title_version, completed_version, position_version, deleted_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)
        `).bind(
          String(row.id),
          String(row.text ?? ''),
          row.completed ? 1 : 0,
          completedAt,
          position,
          BASELINE,
          BASELINE,
          BASELINE,
          now,
        ));
        // Seed rows are also written to the op log so devices that already
        // completed their first full sync still receive migrated tasks.
        statements.push(db.prepare(`
          INSERT OR IGNORE INTO ops (
            op_id, task_id, type, payload, hlc, client_ts, device_id, received_at
          ) VALUES (?, ?, 'create', ?, ?, ?, 'seed', ?)
        `).bind(
          `seed:${row.id}`,
          String(row.id),
          payload,
          BASELINE,
          completedAt || 0,
          now,
        ));
      }
      await db.batch(statements);
    }
    await setMeta(db, 'seeded', Date.now());
    console.log(`[Taski Sync] Seeded ${rows.length} task(s) from Supabase`);
  } catch (err) {
    console.warn('[Taski Sync] Supabase seed failed, local sync continues:', err && err.message ? err.message : err);
    await setMeta(db, 'seed_attempt_at', Date.now());
  }
}

function validateOp(raw, index) {
  const rejected = (reason) => ({ ok: false, index, id: raw && raw.id ? String(raw.id) : null, reason });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rejected('invalid op');
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return rejected('invalid op id');
  const type = String(raw.type || '');
  if (!OP_TYPES.has(type)) return rejected('unsupported op type');
  const taskId = String(raw.taskId || '');
  if (!ID_RE.test(taskId)) return rejected('invalid task id');
  const hlc = String(raw.hlc || '');
  const hlcMatch = HLC_RE.exec(hlc);
  if (!hlcMatch) return rejected('invalid hybrid clock');
  const deviceId = String(raw.deviceId || hlcMatch[3]);
  if (!DEVICE_RE.test(deviceId)) return rejected('invalid device id');

  const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    ? raw.payload
    : {};
  const clientTs = numberOrNull(raw.clientTs) ?? Number(hlcMatch[1]);
  const clean = {
    id,
    type,
    taskId,
    hlc,
    deviceId,
    clientTs,
    payload: {},
  };

  if (type === 'create' || type === 'title') {
    const title = typeof payload.title === 'string' ? payload.title : '';
    if (title.length > 2000) return rejected('title too long');
    clean.payload.title = title;
  }
  if (type === 'create' || type === 'uncomplete' || type === 'position') {
    clean.payload.position = finitePosition(payload.position, 1000);
  }
  if (type === 'create' || type === 'complete' || type === 'uncomplete') {
    clean.payload.completedAt = parseTimestamp(payload.completedAt);
    if (type === 'create') clean.payload.completed = !!payload.completed;
  }

  return { ok: true, op: clean };
}

function opToTaskRow(op, receivedAt) {
  const isDelete = op.type === 'delete';
  const hasTitle = op.type === 'create' || op.type === 'title';
  const hasCompleted = op.type === 'create' || op.type === 'complete' || op.type === 'uncomplete';
  const hasPosition = op.type === 'create' || op.type === 'uncomplete' || op.type === 'position';

  let completed = 0;
  if (op.type === 'create') completed = op.payload.completed ? 1 : 0;
  else if (op.type === 'complete') completed = 1;
  else if (op.type === 'uncomplete') completed = 0;

  return {
    title: hasTitle ? (op.payload.title || '') : '',
    titleVersion: hasTitle ? op.hlc : '',
    completed,
    completedAt: hasCompleted ? (op.payload.completedAt ?? null) : null,
    completedVersion: hasCompleted ? op.hlc : '',
    position: hasPosition ? op.payload.position : 1000,
    positionVersion: hasPosition ? op.hlc : '',
    deleted: isDelete ? 1 : 0,
    deletedVersion: isDelete ? op.hlc : '',
    updatedAt: receivedAt,
  };
}

// Field-level LWW + sticky tombstones, in one atomic upsert per op.
// Empty version strings mean “this op does not touch that field”.
function taskUpsertStatement(db, op, receivedAt) {
  const row = opToTaskRow(op, receivedAt);
  return db.prepare(`
    INSERT INTO tasks (
      id, title, completed, completed_at, position, deleted,
      title_version, completed_version, position_version, deleted_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE
        WHEN tasks.deleted = 0 AND excluded.title_version <> '' AND excluded.title_version > tasks.title_version
        THEN excluded.title ELSE tasks.title END,
      title_version = CASE
        WHEN tasks.deleted = 0 AND excluded.title_version <> '' AND excluded.title_version > tasks.title_version
        THEN excluded.title_version ELSE tasks.title_version END,
      completed = CASE
        WHEN tasks.deleted = 0 AND excluded.completed_version <> '' AND excluded.completed_version > tasks.completed_version
        THEN excluded.completed ELSE tasks.completed END,
      completed_at = CASE
        WHEN tasks.deleted = 0 AND excluded.completed_version <> '' AND excluded.completed_version > tasks.completed_version
        THEN excluded.completed_at ELSE tasks.completed_at END,
      completed_version = CASE
        WHEN tasks.deleted = 0 AND excluded.completed_version <> '' AND excluded.completed_version > tasks.completed_version
        THEN excluded.completed_version ELSE tasks.completed_version END,
      position = CASE
        WHEN tasks.deleted = 0 AND excluded.position_version <> '' AND excluded.position_version > tasks.position_version
        THEN excluded.position ELSE tasks.position END,
      position_version = CASE
        WHEN tasks.deleted = 0 AND excluded.position_version <> '' AND excluded.position_version > tasks.position_version
        THEN excluded.position_version ELSE tasks.position_version END,
      deleted = CASE
        WHEN excluded.deleted_version <> '' AND (tasks.deleted_version IS NULL OR excluded.deleted_version > tasks.deleted_version)
        THEN 1 ELSE tasks.deleted END,
      deleted_version = CASE
        WHEN excluded.deleted_version <> '' AND (tasks.deleted_version IS NULL OR excluded.deleted_version > tasks.deleted_version)
        THEN excluded.deleted_version ELSE tasks.deleted_version END,
      updated_at = excluded.updated_at
    WHERE tasks.deleted = 0 OR excluded.deleted_version <> ''
  `).bind(
    op.taskId,
    row.title,
    row.completed,
    row.completedAt,
    row.position,
    row.deleted,
    row.titleVersion,
    row.completedVersion,
    row.positionVersion,
    row.deletedVersion,
    row.updatedAt,
  );
}

function opInsertStatement(db, op, receivedAt) {
  return db.prepare(`
    INSERT OR IGNORE INTO ops (
      op_id, task_id, type, payload, hlc, client_ts, device_id, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    op.id,
    op.taskId,
    op.type,
    JSON.stringify(op.payload),
    op.hlc,
    op.clientTs,
    op.deviceId,
    receivedAt,
  );
}

async function applyOps(db, ops) {
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    const receivedAt = Date.now();
    const statements = [];
    for (const op of chunk) {
      statements.push(taskUpsertStatement(db, op, receivedAt));
      statements.push(opInsertStatement(db, op, receivedAt));
    }
    await db.batch(statements);
  }
}

async function buildSnapshot(db) {
  const [tasksResult, tombstonesResult, seqResult] = await db.batch([
    db.prepare(`
      SELECT id, title, completed, completed_at, position,
             title_version, completed_version, position_version
      FROM tasks
      WHERE deleted = 0
      ORDER BY position ASC, id ASC
    `),
    db.prepare(`
      SELECT id, deleted_version
      FROM tasks
      WHERE deleted = 1
      ORDER BY id ASC
    `),
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ops'),
  ]);

  return {
    tasks: (tasksResult.results || []).map((row) => ({
      id: row.id,
      title: row.title,
      completed: !!row.completed,
      completedAt: row.completed_at,
      position: row.position,
      versions: {
        title: row.title_version,
        completed: row.completed_version,
        position: row.position_version,
      },
    })),
    tombstones: (tombstonesResult.results || []).map((row) => ({
      id: row.id,
      version: row.deleted_version,
    })),
    cursor: Number(seqResult.results?.[0]?.max_seq || 0),
  };
}

function rowToOp(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || '{}');
  } catch {
    payload = {};
  }
  return {
    seq: row.seq,
    id: row.op_id,
    type: row.type,
    taskId: row.task_id,
    hlc: row.hlc,
    clientTs: row.client_ts,
    deviceId: row.device_id,
    payload,
  };
}

async function broadcastSync(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || '';
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{
          topic: 'taski-sync',
          event: 'sync',
          payload: { at: Date.now() },
        }],
      }),
    });
    if (!res.ok) {
      console.warn('[Taski Sync] Realtime broadcast failed:', res.status);
    }
  } catch (err) {
    console.warn('[Taski Sync] Realtime broadcast unavailable:', err && err.message ? err.message : err);
  }
}

async function maybePrune(db) {
  try {
    const last = Number(await getMeta(db, 'last_prune') || 0);
    const now = Date.now();
    if (last && now - last < PRUNE_INTERVAL_MS) return;
    await db.batch([
      db.prepare('DELETE FROM ops WHERE received_at < ?').bind(now - OP_RETENTION_MS),
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_prune', ?)").bind(String(now)),
    ]);
  } catch (err) {
    console.warn('[Taski Sync] Op log prune failed:', err && err.message ? err.message : err);
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST, OPTIONS' });
  }

  const db = env.TASKI_DB;
  if (!db) {
    return json({ error: 'Sync storage is not configured' }, 503);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 512 * 1024) {
    return json({ error: 'Sync payload too large' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid sync body' }, 400);
  }
  if (Array.isArray(body.ops) && body.ops.length > MAX_OPS) {
    return json({ error: `At most ${MAX_OPS} ops per request` }, 413);
  }

  try {
    await ensureSchema(db);

    // Migration only. The seed is awaited so the very first full snapshot
    // already contains the old Supabase tasks. If Supabase is down, the
    // function gives up quickly and local sync continues.
    await seedFromSupabase(db, env);

    const rawOps = Array.isArray(body.ops) ? body.ops : [];
    const validated = [];
    const rejected = [];
    for (let i = 0; i < rawOps.length; i += 1) {
      const result = validateOp(rawOps[i], i);
      if (result.ok) validated.push(result.op);
      else rejected.push({ id: result.id, index: result.index, reason: result.reason });
    }

    if (validated.length) {
      await applyOps(db, validated);
    }

    const cursor = Number(body.cursor) || 0;
    const wantsFull = body.full === true || cursor <= 0;
    const maxRow = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ops').first();
    const minRow = await db.prepare('SELECT MIN(seq) AS min_seq FROM ops').first();
    const maxSeq = Number(maxRow?.max_seq || 0);
    const minSeq = Number(minRow?.min_seq || 0);

    let full = wantsFull || cursor > maxSeq;
    if (!full && minSeq > 0 && cursor < minSeq - 1) full = true;

    let response;
    if (full) {
      const snapshot = await buildSnapshot(db);
      response = {
        ok: true,
        serverTime: Date.now(),
        cursor: snapshot.cursor,
        acked: validated.map((op) => op.id),
        rejected,
        snapshot: {
          tasks: snapshot.tasks,
          tombstones: snapshot.tombstones,
        },
        hasMore: false,
      };
    } else {
      const result = await db.prepare(`
        SELECT seq, op_id, task_id, type, payload, hlc, client_ts, device_id
        FROM ops
        WHERE seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `).bind(cursor, INCREMENTAL_LIMIT + 1).all();

      const rows = result.results || [];
      const hasMore = rows.length > INCREMENTAL_LIMIT;
      const visible = hasMore ? rows.slice(0, INCREMENTAL_LIMIT) : rows;
      const ops = visible.map(rowToOp);
      response = {
        ok: true,
        serverTime: Date.now(),
        cursor: ops.length ? ops[ops.length - 1].seq : cursor,
        acked: validated.map((op) => op.id),
        rejected,
        ops,
        hasMore,
      };
    }

    if (validated.length && context.waitUntil) {
      context.waitUntil(broadcastSync(env));
      context.waitUntil(maybePrune(db));
    }

    return json(response);
  } catch (err) {
    console.error('[Taski Sync] Request failed:', err);
    return json({ error: 'Sync failed' }, 500);
  }
}
