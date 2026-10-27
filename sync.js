// ══════════════════════════════════════════════════════════════════
//  Taski offline-first sync engine
//
//  Local actions are applied instantly, stamped with a Hybrid Logical
//  Clock (HLC), persisted in an outbox, and replayed to /api/sync.
//
//  The server merges field-by-field (title / completed / position) and
//  keeps sticky tombstones for deletions. The engine here materialises
//  exactly the same rules locally so the UI is always optimistic.
//
//  Exported for the Node test-suite when loaded outside a browser.
// ══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const STATE_KEY = 'taski_sync_v1';
  const OUTBOX_KEY = 'taski_outbox_v1';
  const BASELINE = '0000000000000:000000:legacy';
  const HLC_RE = /^(\d{13}):(\d{6}):([a-z0-9_-]{1,32})$/;
  const MAX_BATCH = 100;
  const POLL_MS = 3000;
  const REQUEST_TIMEOUT_MS = 10000;
  const MAX_RETRY_MS = 30000;

  const defaultState = () => ({
    version: 1,
    deviceId: '',
    cursor: 0,
    lastHlcMs: 0,
    lastHlcCounter: 0,
    clockOffset: 0,
    tombstones: {},
    initialSyncDone: false,
    lastSyncAt: 0,
    updatedAt: 0,
  });

  function pad(value, length) {
    return String(value).padStart(length, '0');
  }

  function compareVersion(a, b) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }

  function isVersion(value) {
    return typeof value === 'string' && HLC_RE.test(value);
  }

  function parseVersion(value) {
    const match = HLC_RE.exec(String(value || ''));
    if (!match) return null;
    return { ms: Number(match[1]), counter: Number(match[2]), device: match[3] };
  }

  function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function readJSON(storage, key, fallback) {
    try {
      const raw = storage && storage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    try {
      if (!storage) return false;
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[Taski Sync] Could not persist', key, err && err.name ? err.name : err);
      return false;
    }
  }

  function randomToken(randomUUID, cryptoObj) {
    try {
      if (typeof randomUUID === 'function') {
        return String(randomUUID()).replace(/-/g, '').slice(0, 12).toLowerCase();
      }
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        return String(cryptoObj.randomUUID()).replace(/-/g, '').slice(0, 12).toLowerCase();
      }
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);
        cryptoObj.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {
      // fall through
    }
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(-12);
  }

  function normalizeLocalTask(task) {
    if (!task || typeof task !== 'object') return task;
    delete task._lastMutatedAt;
    if (!task._sync || typeof task._sync !== 'object') {
      task._sync = { t: BASELINE, c: BASELINE, p: BASELINE };
    }
    if (!isVersion(task._sync.t)) task._sync.t = BASELINE;
    if (!isVersion(task._sync.c)) task._sync.c = BASELINE;
    if (!isVersion(task._sync.p)) task._sync.p = BASELINE;
    task.completed = !!task.completed;
    task.completedAt = normalizeTimestamp(task.completedAt);
    const position = Number(task.position);
    task.position = Number.isFinite(position) ? position : 1000;
    if (typeof task.title !== 'string') task.title = '';
    return task;
  }

  function createTaskiSync(options = {}) {
    const storage = options.storage || (typeof global.localStorage !== 'undefined' ? global.localStorage : null);
    const fetchImpl = options.fetch || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    const nowFn = options.now || (() => Date.now());
    const randomUUID = options.randomUUID || null;
    const cryptoObj = options.crypto || global.crypto || null;
    const getTasks = options.getTasks || (() => []);
    const setTasks = options.setTasks || (() => {});
    const onPersist = options.onPersist || (() => {});
    const onRemoteChange = options.onRemoteChange || (() => {});
    const onStatus = options.onStatus || (() => {});
    const isOnline = options.isOnline || (() => (typeof global.navigator === 'undefined' ? true : global.navigator.onLine !== false));
    const pollMs = options.pollMs || POLL_MS;
    const setTimeoutFn = options.setTimeout || global.setTimeout.bind(global);
    const clearTimeoutFn = options.clearTimeout || global.clearTimeout.bind(global);
    const setIntervalFn = options.setInterval || global.setInterval.bind(global);
    const clearIntervalFn = options.clearInterval || global.clearInterval.bind(global);

    let state = loadState();
    let outbox = loadOutbox();
    let started = false;
    let disposed = false;
    let inFlight = false;
    let inFlightPromise = null;
    let rerun = false;
    let pollTimer = null;
    let retryTimer = null;
    let retryDelay = 0;
    let nextAttemptAt = 0;
    let lastError = null;
    let lastPersistedSignature = null;
    // Each tab gets a session suffix so two tabs on the same device can
    // never mint the same HLC version. The persisted device id stays
    // stable so the server can still attribute ops to one device.
    const sessionId = randomToken(randomUUID, cryptoObj).slice(0, 6);
    const hlcDevice = `${state.deviceId}-${sessionId}`.slice(0, 32);
    try {
      if (storage && storage.getItem(STATE_KEY)) lastPersistedSignature = stateSignature();
    } catch { /* ignore */ }

    function loadState() {
      const stored = readJSON(storage, STATE_KEY, null);
      const base = defaultState();
      if (stored && typeof stored === 'object') {
        base.deviceId = typeof stored.deviceId === 'string' ? stored.deviceId : '';
        base.cursor = Number.isFinite(Number(stored.cursor)) ? Number(stored.cursor) : 0;
        base.lastHlcMs = Number.isFinite(Number(stored.lastHlcMs)) ? Number(stored.lastHlcMs) : 0;
        base.lastHlcCounter = Number.isFinite(Number(stored.lastHlcCounter)) ? Number(stored.lastHlcCounter) : 0;
        base.clockOffset = Number.isFinite(Number(stored.clockOffset)) ? Number(stored.clockOffset) : 0;
        base.tombstones = stored.tombstones && typeof stored.tombstones === 'object' ? { ...stored.tombstones } : {};
        base.initialSyncDone = !!stored.initialSyncDone;
        base.lastSyncAt = Number(stored.lastSyncAt) || 0;
        base.updatedAt = Number(stored.updatedAt) || 0;
      }
      if (!base.deviceId) base.deviceId = randomToken(randomUUID, cryptoObj);
      for (const [id, version] of Object.entries(base.tombstones)) {
        if (!isVersion(version)) delete base.tombstones[id];
      }
      return base;
    }

    function loadOutbox() {
      const stored = readJSON(storage, OUTBOX_KEY, []);
      if (!Array.isArray(stored)) return [];
      return stored.filter((op) => op && typeof op === 'object' && op.id && op.type && op.taskId && isVersion(op.hlc));
    }

    function mergeStoredState() {
      const stored = readJSON(storage, STATE_KEY, null);
      if (!stored || typeof stored !== 'object') return;
      if (stored.deviceId && stored.deviceId !== state.deviceId) return;

      const storedMs = Number(stored.lastHlcMs) || 0;
      const storedCounter = Number(stored.lastHlcCounter) || 0;
      if (storedMs > state.lastHlcMs || (storedMs === state.lastHlcMs && storedCounter > state.lastHlcCounter)) {
        state.lastHlcMs = storedMs;
        state.lastHlcCounter = storedCounter;
      }
      if (Number(stored.lastSyncAt) > state.lastSyncAt) state.lastSyncAt = Number(stored.lastSyncAt);
      if (stored.initialSyncDone) state.initialSyncDone = true;
      if (stored.tombstones && typeof stored.tombstones === 'object') {
        for (const [id, version] of Object.entries(stored.tombstones)) {
          if (!isVersion(version)) continue;
          if (!state.tombstones[id] || compareVersion(version, state.tombstones[id]) > 0) {
            state.tombstones[id] = version;
          }
        }
      }
    }

    function stateSignature() {
      return JSON.stringify({
        deviceId: state.deviceId,
        cursor: state.cursor,
        lastHlcMs: state.lastHlcMs,
        lastHlcCounter: state.lastHlcCounter,
        clockOffset: Math.round(state.clockOffset),
        tombstones: state.tombstones,
        initialSyncDone: state.initialSyncDone,
      });
    }

    function persistState(force = false) {
      mergeStoredState();
      const signature = stateSignature();
      if (!force && signature === lastPersistedSignature) return;
      lastPersistedSignature = signature;
      state.updatedAt = nowFn();
      writeJSON(storage, STATE_KEY, state);
    }

    function persistOutbox() {
      writeJSON(storage, OUTBOX_KEY, outbox);
    }

    function emitStatus() {
      // Read the real outbox length in case another tab flushed or queued ops.
      outbox = loadOutbox();
      onStatus({
        online: !!isOnline(),
        pending: outbox.length,
        syncing: inFlight,
        lastError,
        lastSyncAt: state.lastSyncAt,
      });
    }

    function currentNow() {
      return nowFn() + state.clockOffset;
    }

    function nextHlc() {
      const wall = currentNow();
      let ms = Math.max(0, Math.floor(wall));
      let counter = 0;
      if (ms <= state.lastHlcMs) {
        ms = state.lastHlcMs;
        counter = state.lastHlcCounter + 1;
        if (counter > 999999) {
          ms += 1;
          counter = 0;
        }
      }
      state.lastHlcMs = ms;
      state.lastHlcCounter = counter;
      persistState();
      return `${pad(ms, 13)}:${pad(counter, 6)}:${hlcDevice}`;
    }

    function observeHlc(hlc) {
      const parsed = parseVersion(hlc);
      if (!parsed) return;
      if (parsed.ms > state.lastHlcMs) {
        state.lastHlcMs = parsed.ms;
        state.lastHlcCounter = parsed.counter;
      } else if (parsed.ms === state.lastHlcMs && parsed.counter > state.lastHlcCounter) {
        state.lastHlcCounter = parsed.counter;
      }
    }

    function newOpId() {
      return `op-${state.deviceId}-${nowFn().toString(36)}-${randomToken(randomUUID, cryptoObj)}`;
    }

    function mergeOutboxFromStorage() {
      const stored = loadOutbox();
      if (!stored.length) return;
      const known = new Set(outbox.map((item) => item.id));
      for (const op of stored) {
        if (!known.has(op.id)) {
          outbox.push(op);
          known.add(op.id);
        }
      }
    }

    function enqueue(op) {
      if (!op || !op.id) return;
      // Another tab may have queued actions since we last read storage.
      // Union instead of overwriting so neither tab loses its work.
      mergeOutboxFromStorage();
      if (!outbox.some((item) => item.id === op.id)) outbox.push(op);
      persistOutbox();
      emitStatus();
    }

    function removeOps(ids) {
      const drop = new Set(ids);
      if (!drop.size) return;
      outbox = loadOutbox().filter((op) => !drop.has(op.id));
      persistOutbox();
    }

    function removeOpsForTask(taskId) {
      outbox = loadOutbox().filter((op) => op.taskId !== taskId);
      persistOutbox();
    }

    function makeOp(type, task, hlc, payload) {
      return {
        id: newOpId(),
        type,
        taskId: task.id,
        hlc,
        clientTs: currentNow(),
        deviceId: state.deviceId,
        payload: payload || {},
      };
    }

    function initLocalState() {
      state = loadState();
      outbox = loadOutbox();
      // Persist the generated device id immediately so it survives a
      // reload even if the first sync never completes.
      persistState(true);
      for (const version of Object.values(state.tombstones)) observeHlc(version);
      const tasks = getTasks();
      for (const task of tasks) normalizeLocalTask(task);
      onPersist();
      if (!state.initialSyncDone) bootstrapLocalTasks();
      emitStatus();
    }

    function bootstrapLocalTasks() {
      mergeOutboxFromStorage();
      const tasks = getTasks();
      const pendingCreates = new Set(
        outbox.filter((op) => op.type === 'create').map((op) => op.taskId),
      );
      let added = false;
      for (const task of tasks) {
        if (!task || !task.id) continue;
        if (state.tombstones[task.id]) continue;
        if (pendingCreates.has(task.id)) continue;
        const opId = `boot:${task.id}`;
        if (outbox.some((op) => op.id === opId)) continue;
        outbox.push({
          id: opId,
          type: 'create',
          taskId: task.id,
          hlc: BASELINE,
          clientTs: normalizeTimestamp(task.completedAt) || 0,
          deviceId: state.deviceId,
          payload: {
            title: task.title || '',
            position: task.position,
            completed: !!task.completed,
            completedAt: normalizeTimestamp(task.completedAt),
          },
        });
        added = true;
      }
      if (added) persistOutbox();
      emitStatus();
    }

    function markCreate(task) {
      if (!task || !task.id) return;
      normalizeLocalTask(task);
      const hlc = nextHlc();
      task._sync = { t: hlc, c: hlc, p: hlc };
      enqueue(makeOp('create', task, hlc, {
        title: task.title || '',
        position: task.position,
        completed: !!task.completed,
        completedAt: normalizeTimestamp(task.completedAt),
      }));
      onPersist();
      requestSync('local-create');
    }

    function markComplete(task) {
      if (!task || !task.id || state.tombstones[task.id]) return;
      normalizeLocalTask(task);
      const hlc = nextHlc();
      task.completed = true;
      task.completedAt = currentNow();
      task._sync.c = hlc;
      enqueue(makeOp('complete', task, hlc, { completedAt: task.completedAt }));
      onPersist();
      requestSync('local-complete');
    }

    function markUncomplete(task, position) {
      if (!task || !task.id || state.tombstones[task.id]) return;
      normalizeLocalTask(task);
      const hlc = nextHlc();
      const nextPosition = Number.isFinite(Number(position)) ? Number(position) : task.position;
      task.completed = false;
      task.completedAt = null;
      task.position = nextPosition;
      task._sync.c = hlc;
      task._sync.p = hlc;
      enqueue(makeOp('uncomplete', task, hlc, {
        position: nextPosition,
        completedAt: null,
      }));
      onPersist();
      requestSync('local-uncomplete');
    }

    function markPosition(task, position) {
      if (!task || !task.id || state.tombstones[task.id]) return;
      normalizeLocalTask(task);
      const hlc = nextHlc();
      const nextPosition = Number.isFinite(Number(position)) ? Number(position) : task.position;
      task.position = nextPosition;
      task._sync.p = hlc;
      enqueue(makeOp('position', task, hlc, { position: nextPosition }));
      onPersist();
      requestSync('local-position');
    }

    function markDelete(taskId) {
      if (!taskId || state.tombstones[taskId]) return;
      const hlc = nextHlc();
      state.tombstones[taskId] = hlc;
      persistState();

      const list = getTasks();
      const index = list.findIndex((task) => task.id === taskId);
      if (index >= 0) list.splice(index, 1);

      // A deletion supersedes every pending edit for that task. Only the
      // tombstone needs to reach the server (it wins over all field ops).
      removeOpsForTask(taskId);
      enqueue({
        id: newOpId(),
        type: 'delete',
        taskId,
        hlc,
        clientTs: currentNow(),
        deviceId: state.deviceId,
        payload: {},
      });
      onPersist();
      requestSync('local-delete');
    }

    function applyOp(op) {
      if (!op || typeof op !== 'object' || !op.taskId || !isVersion(op.hlc)) return false;
      observeHlc(op.hlc);

      const list = getTasks();
      const index = list.findIndex((task) => task.id === op.taskId);
      const existing = index >= 0 ? normalizeLocalTask(list[index]) : null;
      const tombstone = state.tombstones[op.taskId];

      if (op.type === 'delete') {
        let changed = false;
        if (!tombstone || compareVersion(op.hlc, tombstone) > 0) {
          state.tombstones[op.taskId] = op.hlc;
          changed = true;
        }
        if (existing) {
          list.splice(index, 1);
          changed = true;
        }
        return changed;
      }

      // Deletions are terminal. No field action can resurrect a task.
      if (tombstone) return false;

      const payload = op.payload && typeof op.payload === 'object' ? op.payload : {};

      if (op.type === 'create') {
        if (!existing) {
          const task = normalizeLocalTask({
            id: op.taskId,
            title: typeof payload.title === 'string' ? payload.title : '',
            completed: !!payload.completed,
            completedAt: normalizeTimestamp(payload.completedAt),
            position: Number.isFinite(Number(payload.position)) ? Number(payload.position) : 1000,
            _sync: { t: op.hlc, c: op.hlc, p: op.hlc },
          });
          list.push(task);
          return true;
        }
        let changed = false;
        if (compareVersion(op.hlc, existing._sync.t) > 0) {
          existing.title = typeof payload.title === 'string' ? payload.title : existing.title;
          existing._sync.t = op.hlc;
          changed = true;
        }
        if (compareVersion(op.hlc, existing._sync.c) > 0) {
          existing.completed = !!payload.completed;
          existing.completedAt = normalizeTimestamp(payload.completedAt);
          existing._sync.c = op.hlc;
          changed = true;
        }
        if (compareVersion(op.hlc, existing._sync.p) > 0) {
          if (Number.isFinite(Number(payload.position))) existing.position = Number(payload.position);
          existing._sync.p = op.hlc;
          changed = true;
        }
        return changed;
      }

      if (!existing) return false;

      if (op.type === 'title') {
        if (compareVersion(op.hlc, existing._sync.t) <= 0) return false;
        existing.title = typeof payload.title === 'string' ? payload.title : existing.title;
        existing._sync.t = op.hlc;
        return true;
      }

      if (op.type === 'complete') {
        if (compareVersion(op.hlc, existing._sync.c) <= 0) return false;
        existing.completed = true;
        existing.completedAt = normalizeTimestamp(payload.completedAt)
          ?? (parseVersion(op.hlc) ? parseVersion(op.hlc).ms : currentNow());
        existing._sync.c = op.hlc;
        return true;
      }

      if (op.type === 'uncomplete') {
        let changed = false;
        if (compareVersion(op.hlc, existing._sync.c) > 0) {
          existing.completed = false;
          existing.completedAt = null;
          existing._sync.c = op.hlc;
          changed = true;
        }
        if (compareVersion(op.hlc, existing._sync.p) > 0) {
          if (Number.isFinite(Number(payload.position))) existing.position = Number(payload.position);
          existing._sync.p = op.hlc;
          changed = true;
        }
        return changed;
      }

      if (op.type === 'position') {
        if (compareVersion(op.hlc, existing._sync.p) <= 0) return false;
        if (Number.isFinite(Number(payload.position))) existing.position = Number(payload.position);
        existing._sync.p = op.hlc;
        return true;
      }

      return false;
    }

    function applyOps(ops) {
      let changed = false;
      for (const op of ops) {
        try {
          if (applyOp(op)) changed = true;
        } catch (err) {
          console.warn('[Taski Sync] Skipped malformed remote op', err);
        }
      }
      return changed;
    }

    function applySnapshot(snapshot, cursor) {
      if (!snapshot || !Array.isArray(snapshot.tasks)) return false;

      const mergedTombstones = {};
      for (const raw of snapshot.tombstones || []) {
        if (!raw || !raw.id || !isVersion(raw.version)) continue;
        mergedTombstones[raw.id] = raw.version;
        observeHlc(raw.version);
      }
      for (const [id, version] of Object.entries(state.tombstones)) {
        if (!isVersion(version)) continue;
        if (!mergedTombstones[id] || compareVersion(version, mergedTombstones[id]) > 0) {
          mergedTombstones[id] = version;
        }
      }
      state.tombstones = mergedTombstones;

      const nextTasks = [];
      for (const raw of snapshot.tasks) {
        if (!raw || !raw.id) continue;
        if (mergedTombstones[raw.id]) continue;
        const versions = raw.versions && typeof raw.versions === 'object' ? raw.versions : {};
        const task = normalizeLocalTask({
          id: String(raw.id),
          title: typeof raw.title === 'string' ? raw.title : '',
          completed: !!raw.completed,
          completedAt: normalizeTimestamp(raw.completedAt),
          position: Number.isFinite(Number(raw.position)) ? Number(raw.position) : 1000,
          _sync: {
            t: isVersion(versions.title) ? versions.title : BASELINE,
            c: isVersion(versions.completed) ? versions.completed : BASELINE,
            p: isVersion(versions.position) ? versions.position : BASELINE,
          },
        });
        observeHlc(task._sync.t);
        observeHlc(task._sync.c);
        observeHlc(task._sync.p);
        nextTasks.push(task);
      }

      setTasks(nextTasks);
      if (Number.isFinite(Number(cursor))) state.cursor = Number(cursor);
      state.initialSyncDone = true;
      return true;
    }

    function scheduleRetry() {
      if (retryTimer) clearTimeoutFn(retryTimer);
      const delay = retryDelay || 2000;
      nextAttemptAt = nowFn() + delay;
      retryTimer = setTimeoutFn(() => {
        retryTimer = null;
        requestSync('retry');
      }, delay);
    }

    function clearRetry() {
      if (retryTimer) {
        clearTimeoutFn(retryTimer);
        retryTimer = null;
      }
      retryDelay = 0;
      nextAttemptAt = 0;
      lastError = null;
    }

    async function runFlush(keepalive) {
      if (disposed) return false;
      if (!isOnline()) {
        emitStatus();
        return false;
      }
      if (!fetchImpl) {
        lastError = 'Fetch unavailable';
        emitStatus();
        return false;
      }
      if (nowFn() < nextAttemptAt) return false;

      inFlight = true;
      emitStatus();

      const t0 = nowFn();
      let batch = [];
      let sentIds = [];
      try {
        outbox = loadOutbox();
        batch = outbox.slice(0, MAX_BATCH);
        sentIds = batch.map((op) => op.id);
        const cursor = Number(state.cursor) || 0;
        const full = !state.initialSyncDone || cursor <= 0;

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeout = controller ? setTimeoutFn(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        let response;
        try {
          response = await fetchImpl('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: state.deviceId,
              cursor,
              full,
              ops: batch,
              clientTime: nowFn(),
            }),
            signal: controller ? controller.signal : undefined,
            keepalive: !!keepalive,
          });
        } finally {
          if (timeout) clearTimeoutFn(timeout);
        }

        if (!response || !response.ok) {
          const status = response ? response.status : 0;
          throw Object.assign(new Error(`Sync HTTP ${status}`), { status });
        }
        const data = await response.json();
        const t1 = nowFn();

        if (typeof data.serverTime === 'number') {
          const rtt = Math.max(0, t1 - t0);
          const offset = data.serverTime - (t0 + rtt / 2);
          if (Number.isFinite(offset)) {
            // Ignore sub-second jitter so a quiet poll does not rewrite
            // sync state (and wake every other tab) every few seconds.
            if (!state.clockOffset || Math.abs(offset - state.clockOffset) > 1000) {
              state.clockOffset = offset;
            }
          }
        }

        const acked = Array.isArray(data.acked) ? data.acked : sentIds;
        const rejected = Array.isArray(data.rejected) ? data.rejected : [];
        const rejectedIds = rejected.map((item) => item && item.id).filter(Boolean);
        removeOps([...acked, ...rejectedIds]);
        if (rejectedIds.length) {
          console.warn('[Taski Sync] Server rejected ops:', rejected);
        }

        let changed = false;
        if (data.snapshot) {
          changed = applySnapshot(data.snapshot, data.cursor);
          // The snapshot already contains every op the server accepted.
          // Re-apply only still-unacknowledged local actions so an
          // optimistic edit is never lost if the response raced.
          outbox = loadOutbox();
          for (const op of outbox) {
            try { if (applyOp(op)) changed = true; } catch { /* ignore malformed local op */ }
          }
          changed = true;
        } else if (Array.isArray(data.ops)) {
          changed = applyOps(data.ops);
          if (Number.isFinite(Number(data.cursor))) {
            state.cursor = Math.max(Number(state.cursor) || 0, Number(data.cursor));
          }
        }

        state.initialSyncDone = true;
        state.lastSyncAt = nowFn();
        clearRetry();
        persistState();

        if (changed) onRemoteChange();
        else onPersist();

        emitStatus();

        outbox = loadOutbox();
        if (outbox.length > 0 || data.hasMore) rerun = true;
        return true;
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
        retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_RETRY_MS) : 2000;
        emitStatus();
        scheduleRetry();
        return false;
      } finally {
        inFlight = false;
        inFlightPromise = null;
        if (rerun) {
          rerun = false;
          requestSync('follow-up');
        }
      }
    }

    function requestSync(reason) {
      if (disposed) return Promise.resolve(false);
      if (!isOnline()) {
        emitStatus();
        return Promise.resolve(false);
      }
      if (inFlight) {
        rerun = true;
        return inFlightPromise || Promise.resolve(false);
      }
      if (nowFn() < nextAttemptAt) return Promise.resolve(false);
      inFlightPromise = runFlush(false);
      return inFlightPromise;
    }

    function flushOnce(keepalive = false) {
      if (inFlight) {
        rerun = true;
        return inFlightPromise || Promise.resolve(false);
      }
      inFlightPromise = runFlush(keepalive);
      return inFlightPromise;
    }

    function onOnline() {
      clearRetry();
      requestSync('online');
    }

    function onOffline() {
      emitStatus();
    }

    function onVisibility() {
      if (typeof global.document !== 'undefined' && global.document.visibilityState === 'visible') {
        requestSync('visible');
      }
    }

    function onPageHide() {
      if (!isOnline()) return;
      outbox = loadOutbox();
      if (outbox.length > 0) flushOnce(true);
    }

    function onStorage(event) {
      if (!event) return;
      if (event.key === OUTBOX_KEY) {
        outbox = loadOutbox();
        emitStatus();
        return;
      }
      if (event.key === STATE_KEY) {
        mergeStoredState();
        emitStatus();
      }
    }

    function start() {
      if (started || disposed) return;
      started = true;

      if (typeof global.addEventListener === 'function') {
        global.addEventListener('online', onOnline);
        global.addEventListener('offline', onOffline);
        global.addEventListener('focus', () => requestSync('focus'));
        global.addEventListener('pagehide', onPageHide);
        global.addEventListener('storage', onStorage);
      }
      if (typeof global.document !== 'undefined' && typeof global.document.addEventListener === 'function') {
        global.document.addEventListener('visibilitychange', onVisibility);
      }
      pollTimer = setIntervalFn(() => {
        if (typeof global.document !== 'undefined' && global.document.visibilityState === 'hidden') return;
        requestSync('poll');
      }, pollMs);

      emitStatus();
      requestSync('start');
    }

    function stop() {
      disposed = true;
      if (pollTimer) clearIntervalFn(pollTimer);
      pollTimer = null;
      if (retryTimer) clearTimeoutFn(retryTimer);
      retryTimer = null;
      if (typeof global.removeEventListener === 'function') {
        global.removeEventListener('online', onOnline);
        global.removeEventListener('offline', onOffline);
        global.removeEventListener('pagehide', onPageHide);
        global.removeEventListener('storage', onStorage);
      }
    }

    function forceFullSync() {
      state.cursor = 0;
      state.initialSyncDone = false;
      persistState();
      clearRetry();
      return requestSync('force-full');
    }

    function getState() {
      return {
        deviceId: state.deviceId,
        cursor: state.cursor,
        lastHlcMs: state.lastHlcMs,
        lastHlcCounter: state.lastHlcCounter,
        clockOffset: state.clockOffset,
        tombstoneCount: Object.keys(state.tombstones).length,
        pending: loadOutbox().length,
        initialSyncDone: state.initialSyncDone,
        lastSyncAt: state.lastSyncAt,
        lastError,
        online: !!isOnline(),
      };
    }

    return {
      initLocalState,
      start,
      stop,
      markCreate,
      markComplete,
      markUncomplete,
      markPosition,
      markDelete,
      applyOp,
      applyOps,
      applySnapshot,
      requestSync,
      flushOnce,
      forceFullSync,
      getState,
      // exposed for tests / debugging
      _internal: {
        loadState,
        loadOutbox,
        nextHlc,
        observeHlc,
        BASELINE,
        STORAGE_KEYS: { STATE_KEY, OUTBOX_KEY },
      },
    };
  }

  const api = { create: createTaskiSync, BASELINE, STORAGE_KEYS: { STATE_KEY, OUTBOX_KEY } };
  global.TaskiSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
