'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, BASELINE, STORAGE_KEYS } = require('../sync.js');

// ── helpers ──────────────────────────────────────────────────────

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    dump(key) { return map.get(key); },
  };
}

function hlc(ms, counter = 0, device = 'test') {
  return `${String(ms).padStart(13, '0')}:${String(counter).padStart(6, '0')}:${device}`;
}

function task(id, overrides = {}) {
  return {
    id,
    title: 'Task ' + id,
    completed: false,
    completedAt: null,
    position: 1000,
    _sync: { t: BASELINE, c: BASELINE, p: BASELINE },
    ...overrides,
  };
}

function makeEngine({ tasks = [], now = () => 1_700_000_000_000, storage = memoryStorage(), initialSyncDone = false } = {}) {
  let list = tasks;
  if (initialSyncDone) {
    storage.setItem(STORAGE_KEYS.STATE_KEY, JSON.stringify({
      version: 1,
      deviceId: 'test-device',
      cursor: 1,
      initialSyncDone: true,
      lastHlcMs: 0,
      lastHlcCounter: 0,
      clockOffset: 0,
      tombstones: {},
    }));
  }
  let uuidCounter = 0;
  const engine = create({
    storage,
    fetch: null,
    now,
    getTasks: () => list,
    setTasks: (next) => { list = next; },
    onPersist: () => {},
    onRemoteChange: () => {},
    onStatus: () => {},
    isOnline: () => false,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    randomUUID: () => {
      uuidCounter += 1;
      return `${String(uuidCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
    },
  });
  engine.initLocalState();
  return {
    engine,
    get tasks() { return list; },
    set tasks(next) { list = next; },
  };
}

function op(type, taskId, version, payload = {}) {
  return { id: `op-${taskId}-${type}-${version}`, type, taskId, hlc: version, payload };
}

// ── HLC ──────────────────────────────────────────────────────────

test('HLC is strictly monotonic even when the wall clock stalls', () => {
  const { engine } = makeEngine({ now: () => 1_700_000_000_000 });
  const first = engine._internal.nextHlc();
  const second = engine._internal.nextHlc();
  const third = engine._internal.nextHlc();

  assert.ok(second > first);
  assert.ok(third > second);

  const fourth = engine._internal.nextHlc();
  assert.match(fourth, /^1700000000000:000003:[a-z0-9_-]+$/);
});

test('HLC moves forward when the wall clock jumps backwards', () => {
  let now = 1_700_000_000_000;
  const { engine } = makeEngine({ now: () => now });
  const before = engine._internal.nextHlc();
  now -= 60_000;
  const after = engine._internal.nextHlc();
  assert.ok(after > before, `${after} should sort after ${before}`);
});

// ── field-level last-writer-wins ─────────────────────────────────

test('complete vs uncomplete converges in either delivery order', () => {
  const t1 = 1_700_000_000_100;
  const t2 = 1_700_000_000_200;

  const a = makeEngine({ tasks: [task('a')] });
  a.engine.applyOp(op('complete', 'a', hlc(t1), { completedAt: t1 }));
  a.engine.applyOp(op('uncomplete', 'a', hlc(t2), { position: 2000 }));
  assert.equal(a.tasks[0].completed, false);
  assert.equal(a.tasks[0].completedAt, null);
  assert.equal(a.tasks[0].position, 2000);

  const b = makeEngine({ tasks: [task('a')] });
  b.engine.applyOp(op('uncomplete', 'a', hlc(t2), { position: 2000 }));
  b.engine.applyOp(op('complete', 'a', hlc(t1), { completedAt: t1 }));
  assert.equal(b.tasks[0].completed, false);
  assert.equal(b.tasks[0].position, 2000);
});

test('reorder and complete touch independent fields', () => {
  const t1 = 1_700_000_000_100;
  const t2 = 1_700_000_000_200;

  const a = makeEngine({ tasks: [task('a')] });
  a.engine.applyOp(op('position', 'a', hlc(t1), { position: 2500 }));
  a.engine.applyOp(op('complete', 'a', hlc(t2), { completedAt: t2 }));
  assert.equal(a.tasks[0].completed, true);
  assert.equal(a.tasks[0].position, 2500);

  const b = makeEngine({ tasks: [task('a')] });
  b.engine.applyOp(op('complete', 'a', hlc(t2), { completedAt: t2 }));
  b.engine.applyOp(op('position', 'a', hlc(t1), { position: 2500 }));
  assert.equal(b.tasks[0].completed, true);
  assert.equal(b.tasks[0].position, 2500);
});

test('duplicate ops are idempotent', () => {
  const h = makeEngine({ tasks: [] });
  const createOp = op('create', 'a', hlc(1), {
    title: 'A',
    position: 1000,
    completed: false,
    completedAt: null,
  });

  assert.equal(h.engine.applyOp(createOp), true);
  assert.equal(h.engine.applyOp(createOp), false);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].title, 'A');
});

// ── deletes are terminal ────────────────────────────────────────

test('complete at 08:00 then delete at 08:15 ends deleted', () => {
  const h = makeEngine({ tasks: [task('a')] });
  h.engine.applyOp(op('complete', 'a', hlc(1_700_000_000_000), { completedAt: 1_700_000_000_000 }));
  h.engine.applyOp(op('delete', 'a', hlc(1_700_000_900_000)));
  assert.equal(h.tasks.length, 0);
});

test('delete at 08:15 then complete at 08:00 still ends deleted', () => {
  const h = makeEngine({ tasks: [task('a')] });
  h.engine.applyOp(op('delete', 'a', hlc(1_700_000_900_000)));
  h.engine.applyOp(op('complete', 'a', hlc(1_700_000_000_000), { completedAt: 1_700_000_000_000 }));
  assert.equal(h.tasks.length, 0);
  assert.ok(h.engine.getState().tombstoneCount >= 1);
});

test('a later complete cannot resurrect a deleted task', () => {
  const h = makeEngine({ tasks: [task('a')] });
  h.engine.applyOp(op('delete', 'a', hlc(1_700_000_000_000)));
  h.engine.applyOp(op('complete', 'a', hlc(1_700_000_900_000), { completedAt: 1_700_000_900_000 }));
  h.engine.applyOp(op('create', 'a', hlc(1_700_001_000_000), {
    title: 'zombie',
    position: 1000,
    completed: false,
    completedAt: null,
  }));
  assert.equal(h.tasks.length, 0);
});

test('an older delete still beats a locally newer completed task', () => {
  const h = makeEngine({
    tasks: [task('a', {
      completed: true,
      completedAt: 1_700_000_900_000,
      _sync: { t: BASELINE, c: hlc(1_700_000_900_000, 0, 'other'), p: BASELINE },
    })],
  });
  h.engine.applyOp(op('delete', 'a', hlc(1_700_000_000_000, 0, 'other')));
  assert.equal(h.tasks.length, 0);
});

// ── snapshots and offline outbox ────────────────────────────────

test('snapshot tombstones override tasks from the same snapshot', () => {
  const h = makeEngine({ tasks: [task('a')] });
  h.engine.applySnapshot({
    tasks: [{
      id: 'a',
      title: 'A',
      completed: true,
      completedAt: 123,
      position: 1000,
      versions: { title: hlc(1), completed: hlc(2), position: hlc(3) },
    }],
    tombstones: [{ id: 'a', version: hlc(4) }],
  }, 10);

  assert.equal(h.tasks.length, 0);
  assert.equal(h.engine.getState().tombstoneCount, 1);
});

test('pending outbox ops survive a snapshot and are re-applied', () => {
  const store = memoryStorage();
  const h = makeEngine({ storage: store });
  const local = task('a');
  h.tasks.push(local);
  h.engine.markCreate(local);
  h.engine.markComplete(local);

  const pending = h.engine._internal.loadOutbox();
  assert.equal(pending.length, 2);
  assert.equal(h.tasks.length, 1);

  // Simulate the server snapshot arriving without those ops.
  h.engine.applySnapshot({ tasks: [], tombstones: [] }, 5);
  assert.equal(h.tasks.length, 0);

  for (const pendingOp of pending) h.engine.applyOp(pendingOp);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].completed, true);
});

test('deleting a task drops its pending edits and keeps one tombstone op', () => {
  const store = memoryStorage();
  const h = makeEngine({ storage: store });
  const local = task('a');
  h.tasks.push(local);
  h.engine.markCreate(local);
  h.engine.markPosition(local, 2000);
  assert.equal(h.engine._internal.loadOutbox().length, 2);

  h.engine.markDelete('a');

  const pending = h.engine._internal.loadOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'delete');
  assert.equal(h.tasks.length, 0);
  assert.equal(store.getItem(STORAGE_KEYS.STATE_KEY).includes('"a"'), true);
});

test('outbox survives a process restart', () => {
  const store = memoryStorage();
  const first = makeEngine({ storage: store });
  first.engine.markCreate(task('a'));

  const second = makeEngine({ storage: store });
  const pending = second.engine._internal.loadOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'create');

  for (const pendingOp of pending) second.engine.applyOp(pendingOp);
  assert.equal(second.tasks.length, 1);
});

test('markUncomplete stamps both completed and position', () => {
  const t = 1_700_000_000_500;
  const h = makeEngine({
    now: () => t,
    initialSyncDone: true,
    tasks: [task('a', {
      completed: true,
      completedAt: t - 1000,
      _sync: { t: BASELINE, c: BASELINE, p: BASELINE },
    })],
  });

  h.engine.markUncomplete(h.tasks[0], 4000);

  const pending = h.engine._internal.loadOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'uncomplete');
  assert.equal(pending[0].payload.position, 4000);
  assert.equal(pending[0].payload.completedAt, null);
  assert.equal(h.tasks[0].completed, false);
  assert.equal(h.tasks[0].position, 4000);
});
