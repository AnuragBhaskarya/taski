let supabaseUrl = '';
let supabaseKey = '';
let db = null;

const DOM = {
  themeToggle: document.getElementById('themeToggle'),
  themeIconMoon: document.getElementById('themeIconMoon'),
  themeIconSun: document.getElementById('themeIconSun'),
  taskList: document.getElementById('taskList'),
  main: document.querySelector('main'),
  fabContainer: document.getElementById('fabContainer'),
  fabAdd: document.getElementById('fabAdd'),
  addModal: document.getElementById('addModal'),
  modalInput: document.getElementById('modalInput'),
  modalCancel: document.getElementById('modalCancel'),
  modalConfirm: document.getElementById('modalConfirm'),
  completedBtn: document.getElementById('completedBtn'),
  completedPanel: document.getElementById('completedPanel'),
  completedClose: document.getElementById('completedClose'),
  completedList: document.getElementById('completedList'),
  completedEmpty: document.getElementById('completedEmpty'),
};

// ══════════════════════════════════
//  Task Completion Lock (1 Hour Rule)
// ══════════════════════════════════

const ONE_HOUR_MS = 60 * 60 * 1000;

function getTaskCompletionTime(task) {
  if (!task.completed || !task.completedAt) return null;
  if (typeof task.completedAt === 'number') return task.completedAt;
  const parsed = new Date(task.completedAt).getTime();
  return isNaN(parsed) ? null : parsed;
}

function isTaskLocked(task) {
  const completedTime = getTaskCompletionTime(task);
  if (!completedTime) return false;
  return (Date.now() - completedTime) >= ONE_HOUR_MS;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getTaskDateKey(timestamp) {
  if (!timestamp) return 'earlier';
  const d = new Date(typeof timestamp === 'number' ? timestamp : Number(timestamp) || timestamp);
  if (isNaN(d.getTime())) return 'earlier';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatCompletedDateHeader(timestamp) {
  if (!timestamp) return 'Earlier';
  const d = new Date(typeof timestamp === 'number' ? timestamp : Number(timestamp) || timestamp);
  if (isNaN(d.getTime())) return 'Earlier';

  const day = d.getDate();
  const month = MONTH_NAMES[d.getMonth()];
  const year = d.getFullYear();
  const dateStr = `${day} ${month}, ${year}`;

  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `Today · ${dateStr}`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday · ${dateStr}`;
  }
  return dateStr;
}

function formatCompletedTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(typeof timestamp === 'number' ? timestamp : Number(timestamp) || timestamp);
  if (isNaN(d.getTime())) return '';

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  const hoursStr = String(hours ? hours : 12).padStart(2, '0');
  return `${hoursStr}:${minutes} ${ampm}`;
}

function createDateHeaderElement(timestamp) {
  const li = document.createElement('li');
  li.className = 'completed-date-header';
  li.textContent = formatCompletedDateHeader(timestamp);
  return li;
}

// ══════════════════════════════════════════════════════════════════
//  Active List — first-load / scroll reveal
//  Active tasks stay fully rendered, but their hidden transform makes
//  IntersectionObserver unreliable (the translated box can sit outside
//  the root). So layout offsets are cached once per render/resize and a
//  rAF-throttled scroll pass only touches the few cards near the
//  viewport. Cards re-arm after they leave, so scrolling either way
//  animates the incoming cards. Rebuilds and tick/untick never replay
//  the entrance for a card that is already known.
// ══════════════════════════════════════════════════════════════════

const ACTIVE_REVEAL_INSET = 8;    // px inside the viewport where the reveal starts
const ACTIVE_REVEAL_RESET = 0;    // re-arm as soon as a card is fully out
const ACTIVE_STAGGER = 35;
const ACTIVE_STAGGER_MAX = 140;
const REVEAL_EXIT_MS = 850;       // slightly longer than the 0.8s transform

let activeCards = [];
let activeRevealed = new Set();
let activeRevealRaf = 0;
let activeRevealInitial = true;
let activeGeometryRaf = 0;
const revealedActiveTaskIds = new Set();

function getActiveViewport() {
  const viewTop = DOM.main.scrollTop;
  return { viewTop, viewBottom: viewTop + DOM.main.clientHeight };
}

// Binary search: cards are in DOM order and do not overlap. tops and
// bottoms are both sorted, so the visible slice can be found without
// ever walking the full task list on scroll.
function getActiveRange(topLimit, bottomLimit) {
  const last = activeCards.length - 1;
  if (last < 0) return { start: 0, end: -1 };

  let low = 0;
  let high = last;
  let start = last + 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (activeCards[mid].bottom > topLimit) {
      start = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  low = start;
  high = last;
  let end = start - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (activeCards[mid].top < bottomLimit) {
      end = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { start, end };
}

function rebuildActiveGeometry() {
  const list = DOM.taskList;
  const main = DOM.main;
  // scrollTop is measured from the scroll container's content edge, so
  // the list must be too. Using list.offsetTop alone adds the header
  // height, which made cards reset while still visible at the bottom.
  const base = list.getBoundingClientRect().top
    - main.getBoundingClientRect().top
    - main.clientTop
    + main.scrollTop;
  const cards = [];

  for (const el of list.children) {
    if (!el.classList.contains('topic-item')) continue;
    const top = base + el.offsetTop;
    const card = { el, top, bottom: top + el.offsetHeight };
    el.__activeCard = card;
    cards.push(card);
  }

  activeCards = cards;
  for (const el of activeRevealed) {
    if (!el.isConnected) activeRevealed.delete(el);
  }
}

function revealActiveTaskNow(el, taskId) {
  if (!el || !taskId) return;
  if (el.__activeRevealTimer) {
    clearTimeout(el.__activeRevealTimer);
    el.__activeRevealTimer = null;
  }
  revealedActiveTaskIds.add(taskId);
  el.classList.add('is-instant', 'is-visible');
  el.style.willChange = 'auto';
  activeRevealed.add(el);
}

function resetActiveTask(el) {
  if (el.__activeRevealTimer) {
    clearTimeout(el.__activeRevealTimer);
    el.__activeRevealTimer = null;
  }
  // Play the entrance backwards instead of snapping to hidden. The
  // card is already fully outside the viewport, so this mostly matters
  // when the user reverses direction mid-exit.
  el.classList.remove('is-instant', 'is-visible');
  el.style.transitionDelay = '';
  el.style.willChange = 'transform, opacity';
  activeRevealed.delete(el);

  el.__activeRevealTimer = setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.add('is-instant');
    el.style.willChange = 'auto';
    el.__activeRevealTimer = null;
  }, REVEAL_EXIT_MS);
}

function showActiveTask(el, delay) {
  if (!el.isConnected) return false;
  el.classList.remove('is-instant');
  el.style.willChange = 'transform, opacity';
  void el.offsetWidth;
  el.style.transitionDelay = `${delay}ms`;
  el.classList.add('is-visible');
  activeRevealed.add(el);
  revealedActiveTaskIds.add(el.dataset.id);

  if (el.__activeRevealTimer) clearTimeout(el.__activeRevealTimer);
  el.__activeRevealTimer = setTimeout(() => {
    if (!el.isConnected) return;
    el.style.transitionDelay = '';
    el.style.willChange = 'auto';
    el.__activeRevealTimer = null;
  }, 1000 + delay);
  return true;
}

function updateActiveReveal() {
  if (!activeCards.length) return;

  const { viewTop, viewBottom } = getActiveViewport();
  if (viewBottom <= viewTop) return;

  // Re-arm cards that are now clearly out of view so a direction
  // reversal animates them again instead of showing a solid row.
  for (const el of activeRevealed) {
    const card = el.__activeCard;
    if (!el.isConnected || !card) {
      activeRevealed.delete(el);
      continue;
    }
    // The lifted card lives on <body> while dragging; never reset it.
    if (el.classList.contains('drag-active')) continue;
    if (card.bottom < viewTop - ACTIVE_REVEAL_RESET ||
        card.top > viewBottom + ACTIVE_REVEAL_RESET) {
      resetActiveTask(el);
    }
  }

  const isInitial = activeRevealInitial;
  const inset = isInitial ? 0 : ACTIVE_REVEAL_INSET;
  const range = getActiveRange(viewTop + inset, viewBottom - inset);
  const toReveal = [];

  for (let i = range.start; i <= range.end; i++) {
    const el = activeCards[i].el;
    if (el.classList.contains('drag-active')) continue;
    if (!el.classList.contains('is-visible')) toReveal.push(el);
  }

  if (!toReveal.length) return;
  activeRevealInitial = false;

  requestAnimationFrame(() => {
    let revealed = 0;
    for (let i = 0; i < toReveal.length; i++) {
      const el = toReveal[i];
      if (!el.isConnected || el.classList.contains('is-visible')) continue;
      const delay = isInitial
        ? Math.min((revealed % 5) * ACTIVE_STAGGER, ACTIVE_STAGGER_MAX)
        : 0;
      if (showActiveTask(el, delay)) revealed++;
    }
  });
}

function scheduleActiveReveal() {
  if (activeRevealRaf) return;
  activeRevealRaf = requestAnimationFrame(() => {
    activeRevealRaf = 0;
    updateActiveReveal();
  });
}

// After a rebuild, visible cards that were already seen must stay
// instant. Off-screen cards remain hidden and re-arm for the next entry.
function primeActiveRevealOnRebuild() {
  const { viewTop, viewBottom } = getActiveViewport();
  const range = getActiveRange(viewTop, viewBottom);
  for (let i = range.start; i <= range.end; i++) {
    const el = activeCards[i].el;
    if (revealedActiveTaskIds.has(el.dataset.id)) {
      revealActiveTaskNow(el, el.dataset.id);
    }
  }
}

DOM.main.addEventListener('scroll', scheduleActiveReveal, { passive: true });

if (typeof ResizeObserver !== 'undefined') {
  const activeResizeObserver = new ResizeObserver(() => {
    if (activeGeometryRaf) return;
    activeGeometryRaf = requestAnimationFrame(() => {
      activeGeometryRaf = 0;
      rebuildActiveGeometry();
      scheduleActiveReveal();
    });
  });
  activeResizeObserver.observe(DOM.main);
}

let tasks = JSON.parse(localStorage.getItem('taski_tasks') || '[]');

// Instant Paint! Render cache immediately before any network requests
if (tasks.length > 0) {
  renderActiveTasks();
}

let renderBatchTimer = null;
let pendingRemoteRender = false;
let completedDrag = null;

function scheduleRender() {
  if (renderBatchTimer) return;
  
  if (document.body.classList.contains('is-dragging') || completedDrag) {
    pendingRemoteRender = true;
    return;
  }
  
  renderBatchTimer = requestAnimationFrame(() => {
    renderBatchTimer = null;
    if (document.body.classList.contains('is-dragging') || completedDrag) {
      pendingRemoteRender = true;
      return;
    }
    pendingRemoteRender = false;
    
    tasks.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.completed) return (b.completedAt || 0) - (a.completedAt || 0);
      return a.position - b.position;
    });
    
    saveTasks();
    renderActiveTasks();
    renderCompletedTasks();
  });
}

async function initApp() {
  try {
    const res = await fetch('/api/env');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const env = await res.json();
    if (!env || !env.url || !env.key) throw new Error('Missing environment credentials');
    supabaseUrl = env.url;
    supabaseKey = env.key;
    if (window.supabase) {
      db = window.supabase.createClient(supabaseUrl, supabaseKey);
      
      db
        .channel('tasks')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, payload => {
          if (payload.eventType === 'INSERT') {
            if (!tasks.find(t => t.id === payload.new.id)) {
              tasks.push({ ...payload.new, _lastMutatedAt: 0 });
              scheduleRender();
            }
          } else if (payload.eventType === 'UPDATE') {
            const localTask = tasks.find(t => t.id === payload.new.id);
            if (localTask) {
              if (Date.now() - (localTask._lastMutatedAt || 0) < 2000) return;
              Object.assign(localTask, {
                title: payload.new.text,
                completed: payload.new.completed,
                completedAt: payload.new.completedAt,
                position: payload.new.position
              });
              scheduleRender();
            }
          } else if (payload.eventType === 'DELETE') {
            const localTask = tasks.find(t => t.id === payload.old.id);
            if (localTask) {
              if (Date.now() - (localTask._lastMutatedAt || 0) < 2000) return;
              tasks = tasks.filter(t => t.id !== payload.old.id);
              scheduleRender();
            }
          }
        })
        .subscribe();

      await loadTasks();
    }
  } catch (e) {
    console.warn('[Taski] Remote database sync offline or not configured. Running in local-first mode.', e);
  }
}

initApp();

async function loadTasks() {
  if (!db) return;
  try {
    const { data, error } = await db.from('tasks').select('*').order('position', { ascending: true });
    if (!error && data) {
      const newTasks = data.map(d => ({
        id: d.id,
        title: d.text,
        completed: d.completed,
        completedAt: d.completedAt,
        position: d.position
      }));
      
      // Sort both identically for stable comparison
      const sortFn = (a, b) => a.id.localeCompare(b.id);
      const stableLocal = [...tasks].sort(sortFn);
      const stableRemote = [...newTasks].sort(sortFn);
      
      // Simple diff to prevent DOM flash if data is identical
      if (JSON.stringify(stableLocal) === JSON.stringify(stableRemote)) {
        return;
      }
      
      tasks = newTasks;
      saveTasks(); // Update cache with fresh data
      renderActiveTasks();
      renderCompletedTasks();
    }
  } catch (e) {
    console.error('Failed to load tasks', e);
  }
}

function saveTasks() {
  localStorage.setItem('taski_tasks', JSON.stringify(tasks));
}


// ── Theme ──
function applyThemeIcons(isDark) {
  DOM.themeIconMoon.style.display = isDark ? 'none' : 'block';
  DOM.themeIconSun.style.display  = isDark ? 'block' : 'none';
}

const currentTheme = localStorage.getItem('taski_theme') || 'light';
if (currentTheme === 'dark') {
  document.documentElement.classList.add('dark');
}
applyThemeIcons(currentTheme === 'dark');

DOM.themeToggle.addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('taski_theme', isDark ? 'dark' : 'light');
  applyThemeIcons(isDark);
});

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}


// ══════════════════════════════════════════════════
//  Spring Physics (matches Framer Motion Reorder)
//  type:"spring", stiffness:350, damping:30
// ══════════════════════════════════════════════════

// Spring animation constants for drag-and-drop shifting
const STIFFNESS = 350;
const DAMPING = 30;
const REST_DELTA = 0.5;
const REST_VELOCITY = 0.5;

const springs = new WeakMap();
function spring(el) {
  if (!springs.has(el)) springs.set(el, { y: 0, vy: 0, target: 0, onUpdate: null, onComplete: null });
  return springs.get(el);
}

const alive = new Set();
let loopId = 0;

function runLoop() {
  let prev = performance.now();
  const id = ++loopId;

  (function tick(now) {
    if (id !== loopId) return;
    const dt = Math.min((now - prev) / 1000, 0.032);
    prev = now;

    for (const el of alive) {
      const s = spring(el);
      const x = s.y - s.target;
      const a = (-STIFFNESS * x - DAMPING * s.vy);
      s.vy += a * dt;
      s.y  += s.vy * dt;

      if (s.onUpdate) {
        s.onUpdate(s.y, el);
      } else {
        // Use the individual translate property so the drag FLIP does
        // not fight the reveal animation's transform transition.
        el.style.translate = `0 ${s.y}px`;
      }

      if (Math.abs(s.y - s.target) < REST_DELTA && Math.abs(s.vy) < REST_VELOCITY) {
        s.y = s.target;
        s.vy = 0;
        
        if (s.onUpdate) {
          s.onUpdate(s.y, el);
        } else {
          el.style.translate = s.target === 0 ? '' : `0 ${s.target}px`;
        }
        
        alive.delete(el);
        if (s.onComplete) {
          s.onComplete(el);
          s.onComplete = null;
        }
        s.onUpdate = null;
      }
    }

    if (alive.size) requestAnimationFrame(tick);
    else loopId = 0;
  })(prev);
}

function animateSpring(el, startY, target = 0, onUpdate = null, onComplete = null) {
  const s = spring(el);
  s.y = startY;
  s.target = target;
  s.onUpdate = onUpdate;
  s.onComplete = onComplete;
  alive.add(el);
  if (!loopId) runLoop();
}


// ══════════════════════════════════
//  FLIP helper
// ══════════════════════════════════

function captureRects(elements) {
  const map = new Map();
  for (const el of elements) {
    // Layout position, not the animated rect: reveal/FLIP transforms
    // must not affect drag sorting.
    map.set(el, el.offsetTop);
  }
  return map;
}

function flipAnimate(elements, oldTops) {
  for (const el of elements) {
    const oldTop = oldTops.get(el);
    if (oldTop === undefined) continue;

    const s = spring(el);
    const currentY = s.onUpdate ? 0 : (s.y || 0);
    const dy = oldTop - el.offsetTop;
    if (Math.abs(dy) < 1) continue;

    animateSpring(el, currentY + dy);
  }
}


// ══════════════════════════════════════════════════
//  Removal ripple
//  Detached rows are animated by CSS; only rows that were visible
//  get the stagger, so the work stays bounded by the viewport.
// ══════════════════════════════════════════════════

const RISE_STAGGER_MS = 24;
const RISE_STAGGER_MAX_MS = 192;

function currentTranslateY(el) {
  const value = getComputedStyle(el).translate;
  if (!value || value === 'none') return 0;
  const y = parseFloat(value.split(' ')[1] || '0');
  return Number.isFinite(y) ? y : 0;
}

function applyRowRise(moves) {
  const live = moves.filter(move => move.el.isConnected);
  if (!live.length) return;
  live.sort((a, b) => a.order - b.order);

  // Read any in-flight offsets before writing classes. If a second task
  // is removed during a ripple, rows continue from where they are.
  for (let i = 0; i < live.length; i++) {
    const move = live[i];
    move.carried = move.el.classList.contains('row-rise')
      ? currentTranslateY(move.el)
      : 0;
  }

  for (let i = 0; i < live.length; i++) {
    const move = live[i];
    const el = move.el;
    const offset = Math.max(0, move.delta + move.carried);
    el.classList.remove('row-rise');
    el.style.setProperty('--rise-offset', `${offset.toFixed(2)}px`);
    el.style.setProperty('--rise-delay', `${Math.min(i * RISE_STAGGER_MS, RISE_STAGGER_MAX_MS)}ms`);
  }

  // Resolve the held starting positions, then let CSS take over.
  void document.body.offsetWidth;
  for (let i = 0; i < live.length; i++) {
    live[i].el.classList.add('row-rise');
  }
}

document.addEventListener('animationend', (e) => {
  if (e.animationName !== 'row-rise') return;
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('row-rise')) return;
  el.classList.remove('row-rise');
  el.style.removeProperty('--rise-offset');
  el.style.removeProperty('--rise-delay');
});

function captureActiveRiseBelow(anchorEl) {
  const { viewTop, viewBottom } = getActiveViewport();
  const anchorTop = anchorEl.offsetTop;
  const items = [];

  for (const card of activeCards) {
    if (card.el === anchorEl) continue;
    if (card.el.offsetTop <= anchorTop) continue;
    if (card.bottom <= viewTop || card.top >= viewBottom) continue;
    items.push({ el: card.el, oldTop: card.top });
  }

  return items;
}

function applyActiveRise(items) {
  if (!items.length) return;
  const moves = [];

  for (const item of items) {
    const el = item.el;
    if (!el.isConnected) continue;
    const card = el.__activeCard;
    if (!card) continue;
    const delta = item.oldTop - card.top;
    if (delta <= 0.5) continue;

    // A drag spring may still own this row's translate; release it so
    // the CSS ripple can finish without snapping back.
    const s = springs.get(el);
    if (s) {
      s.y = 0;
      s.vy = 0;
      s.target = 0;
      s.onUpdate = null;
      s.onComplete = null;
    }
    alive.delete(el);
    el.style.translate = '';

    moves.push({ el, delta, order: card.top });
  }

  applyRowRise(moves);
}

function animateCardAway(el, transform = 'translateX(-50%) scale(0.85)') {
  const rect = el.getBoundingClientRect();

  el.style.position = 'fixed';
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.margin = '0';
  el.style.zIndex = '9600';
  el.style.pointerEvents = 'none';
  el.style.transform = 'none';
  el.style.opacity = '1';
  el.style.willChange = 'transform, opacity';
  document.body.appendChild(el);

  void el.offsetWidth;
  el.style.transition = 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.24s ease';
  el.style.transform = transform;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 320);
}

function animateDetachedCard(el, transform = 'scale(0) rotate(-15deg)') {
  el.style.transition = 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.24s ease';
  el.style.willChange = 'transform, opacity';
  void el.offsetWidth;
  el.style.transform = transform;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 320);
}

function detachActiveCard(el) {
  if (el.__activeRevealTimer) {
    clearTimeout(el.__activeRevealTimer);
    el.__activeRevealTimer = null;
  }
  activeRevealed.delete(el);
  el.__activeCard = null;
}


// ══════════════════════════════════
//  Strict iOS Zoom & Selection Prevention
// ══════════════════════════════════
document.addEventListener('selectstart', (e) => {
  if (!e.target.closest('input, textarea')) {
    e.preventDefault();
  }
});

document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) {
    e.preventDefault();
  }
});

let lastTouchTime = 0;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) {
    e.preventDefault(); // Kill pinch-to-zoom
  }
}, { passive: false });

document.addEventListener('touchend', (e) => {
  // Completely bypass JS interference for interactive elements.
  // This allows native rapid tapping (spamming checkboxes/buttons) 
  // without artificially triggering programmatic clicks or blocking them.
  if (e.target.closest('button, input, label, .header-icon-btn, .cb-hit')) {
    return;
  }

  const now = Date.now();
  if (now - lastTouchTime <= 300) {
    e.preventDefault(); // Kill double-tap zoom on background areas
  }
  lastTouchTime = now;
}, { passive: false });

// ══════════════════════════════════
//  DOM Elements
// ══════════════════════════════════

function createTaskElement(task, forCompletedPanel = false) {
  const li = document.createElement('li');
  li.className = `topic-item ${task.completed ? 'topic-item--complete' : ''}`;
  li.dataset.id = task.id;

  const locked = forCompletedPanel && isTaskLocked(task);
  const timeHtml = task.completedAt ? formatCompletedTime(task.completedAt) : '';

  li.innerHTML = `
    <label class="cb-hit ${locked ? 'cb-hit--locked' : ''}">
      <input type="checkbox" class="topic-item__checkbox" ${task.completed ? 'checked' : ''} ${locked ? 'disabled' : ''}>
    </label>
    <div class="task-content">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-time">${timeHtml}</div>
    </div>
  `;

  const cb = li.querySelector('.topic-item__checkbox');
  const cbHit = li.querySelector('.cb-hit');

  if (forCompletedPanel) {
    if (locked) {
      // Locked tasks (completed >= 1hr ago) cannot be unticked
      cbHit.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove('item--locked-shake');
        void li.offsetWidth;
        li.classList.add('item--locked-shake');
      });
    } else {
      cb.addEventListener('change', () => handleUntick(li, task.id));
    }

    // Drag to delete outside panel (applies to ALL completed tasks, including locked ones)
    li.addEventListener('pointerdown', onCompletedPointerDown);
  } else {
    // In main list: ticking triggers dismiss animation
    cb.addEventListener('change', e => handleTaskComplete(e, li, task.id));
    // Explicit entry animations (new task / untick) clean up after themselves
    li.addEventListener('animationend', () => li.classList.remove('card--animate-in'), { once: true });
    // Drag
    li.addEventListener('pointerdown', onPointerDown);
  }

  return li;
}

function updateZebraStripes(listElement = DOM.taskList) {
  let visibleIndex = 0;
  for (const item of listElement.children) {
    if (!item.classList.contains('topic-item') || item.style.pointerEvents === 'none') continue;
    item.classList.toggle('is-odd', visibleIndex % 2 === 0);
    item.classList.toggle('is-even', visibleIndex % 2 !== 0);
    visibleIndex++;
  }
}

function renderActiveTasks() {
  DOM.taskList.innerHTML = '';

  tasks.filter(t => !t.completed).forEach(t => {
    DOM.taskList.appendChild(createTaskElement(t));
  });

  rebuildActiveGeometry();
  primeActiveRevealOnRebuild();
  scheduleActiveReveal();
  updateZebraStripes(DOM.taskList);
}

// ══════════════════════════════════════════════════════════════════
//  Completed List — O(viewport) virtualizer with content-aware heights
//  Only the rows near the viewport exist in the DOM. Heights are
//  estimated from the real wrapped title width, then corrected by
//  measuring mounted rows. This keeps 10k+ completed tasks smooth and
//  keeps memory flat (off-screen rows are detached and released).
// ══════════════════════════════════════════════════════════════════

const COMPLETED_OVERSCAN = 320;    // px mounted above/below the viewport
const COMPLETED_REVEAL_INSET = 8;  // px inside the viewport where the reveal starts
const COMPLETED_REVEAL_RESET = 0;  // re-arm as soon as a row is fully out
const COMPLETED_STAGGER = 35;
const COMPLETED_STAGGER_MAX = 140;

let completedVirtualizer = null;
let lastCompletedSignature = '';
let completedTextCtx = null;
let completedMeasureFont = null;
let completedMeasureSpacing = null;

function getCompletedTextContext() {
  if (!completedTextCtx) {
    completedTextCtx = document.createElement('canvas').getContext('2d');
  }
  return completedTextCtx;
}

// Split text into the same break opportunities the browser uses for
// normal wrapping: whitespace and hyphens/slashes. Long words still
// overflow on one line (CSS default), which this mirrors.
function getWrapTokens(text) {
  const tokens = [];
  let chunk = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (chunk) { tokens.push(chunk); chunk = ''; }
      tokens.push(' ');
    } else {
      chunk += ch;
      if (ch === '-' || ch === '/' || ch === '—' || ch === '–' ||
          (ch >= '\u2E80' && ch <= '\u9FFF') ||
          (ch >= '\u3040' && ch <= '\u30FF') ||
          (ch >= '\uAC00' && ch <= '\uD7AF')) {
        tokens.push(chunk);
        chunk = '';
      }
    }
  }
  if (chunk) tokens.push(chunk);
  return tokens;
}

function countWrappedLines(text, maxWidth, font, letterSpacing) {
  if (!text) return 1;
  if (!(maxWidth > 0)) return 1;

  const ctx = getCompletedTextContext();
  if (!ctx) return Math.max(1, Math.ceil((text.length * 8) / maxWidth));

  // Font parsing is expensive; this context is reused for every title
  // in the list, so only touch it when the typography actually changes.
  if (completedMeasureFont !== font) {
    ctx.font = font;
    completedMeasureFont = font;
  }
  const supportsLetterSpacing = 'letterSpacing' in ctx;
  if (supportsLetterSpacing && completedMeasureSpacing !== letterSpacing) {
    ctx.letterSpacing = `${letterSpacing}px`;
    completedMeasureSpacing = letterSpacing;
  }
  const spacingPerChar = supportsLetterSpacing ? 0 : letterSpacing;

  // Fast path: the overwhelming majority of titles fit on one line.
  const fullWidth = ctx.measureText(text).width + spacingPerChar * text.length;
  if (fullWidth <= maxWidth + 0.5) return 1;

  const measure = (str) => ctx.measureText(str).width;

  const tokens = getWrapTokens(text);
  const spaceWidth = measure(' ') + spacingPerChar * 2;
  let lines = 1;
  let lineWidth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === ' ') {
      if (lineWidth > 0) lineWidth += spaceWidth;
      continue;
    }

    const width = measure(token) + spacingPerChar * token.length;

    if (lineWidth === 0) {
      lineWidth = width;
    } else if (lineWidth + width <= maxWidth + 0.5) {
      lineWidth += width;
    } else {
      lines++;
      lineWidth = width;
    }
  }

  return lines;
}

function buildCompletedItems(completed) {
  const items = [];
  let lastDateKey = null;
  let ordinal = 0;
  const totalTasks = completed.length;

  for (let i = 0; i < totalTasks; i++) {
    const task = completed[i];
    const dateKey = getTaskDateKey(task.completedAt);

    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      items.push({
        type: 'header',
        key: `h:${dateKey}:${items.length === 0 ? 'first' : 'normal'}`,
        timestamp: task.completedAt,
        isFirst: items.length === 0
      });
    }

    items.push({
      type: 'task',
      key: `t:${task.id}:${task.title.length}:${i === totalTasks - 1 ? 'L' : 'M'}`,
      task,
      ordinal,
      isLast: i === totalTasks - 1
    });
    ordinal++;
  }

  return items;
}

class CompletedVirtualizer {
  constructor(container) {
    this.container = container;
    this.items = [];
    this.heights = new Float64Array(0);
    this.offsets = new Float64Array(1);
    this.totalHeight = 0;
    this.mounted = new Map();
    this.heightCache = new Map();
    this.metrics = null;
    this.metricsWidth = -1;
    this.pendingStripes = [];
    this.previousStripes = null;

    this.topSpacer = document.createElement('li');
    this.topSpacer.className = 'completed-spacer';
    this.bottomSpacer = document.createElement('li');
    this.bottomSpacer.className = 'completed-spacer';

    this.scrollRaf = 0;
    this.resizeRaf = 0;

    this.onScroll = this.onScroll.bind(this);
    container.addEventListener('scroll', this.onScroll, { passive: true });

    this.resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (this.resizeRaf) return;
        this.resizeRaf = requestAnimationFrame(() => {
          this.resizeRaf = 0;
          if (!this.items.length) return;
          if (this.container.clientWidth === this.metricsWidth) return;
          this.invalidateLayout();
        });
      })
      : null;
    if (this.resizeObserver) this.resizeObserver.observe(container);
  }

  onScroll() {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.updateWindow(false, false);
    });
  }

  renderItem(item) {
    if (item.type === 'header') {
      const el = createDateHeaderElement(item.timestamp);
      if (item.isFirst) el.classList.add('completed-date-header--first');
      return el;
    }

    const el = createTaskElement(item.task, true);
    const stripe = item.ordinal % 2 === 0 ? 'is-odd' : 'is-even';
    const previous = this.previousStripes && this.previousStripes.get(item.task.id);
    if (previous && previous !== stripe) {
      // Start from the row's old stripe so a rebuild after a deletion
      // can fade to the new parity instead of snapping.
      el.classList.add(previous);
      this.pendingStripes.push({ el, stripe });
    } else {
      el.classList.add(stripe);
    }
    if (item.isLast) el.classList.add('is-last');
    return el;
  }

  flushStripeTransitions() {
    this.previousStripes = null;
    if (!this.pendingStripes.length) return;

    // Resolve the carried-over colours before swapping classes. One
    // layout flush lets the background-color transition interpolate
    // from the old stripe to the new one.
    void this.container.offsetWidth;
    const pending = this.pendingStripes;
    this.pendingStripes = [];
    for (let i = 0; i < pending.length; i++) {
      const { el, stripe } = pending[i];
      if (!el.isConnected) continue;
      el.classList.remove('is-odd', 'is-even');
      el.classList.add(stripe);
    }
  }

  flushRowRise(oldRise) {
    if (!oldRise || !oldRise.size) return;

    // Map rebuilt task rows by id. All rows are fresh elements now, so
    // the starting offset must come from the captured visual position.
    const rows = new Map();
    for (const [idx, el] of this.mounted) {
      const item = this.items[idx];
      if (!item || item.type !== 'task') continue;
      if (!el.isConnected || el.parentNode !== this.container) continue;
      rows.set(item.task.id, {
        el,
        top: this.offsets[idx] - this.container.scrollTop
      });
    }

    const moves = [];
    for (const [id, old] of oldRise) {
      const row = rows.get(id);
      if (!row) continue;
      const delta = old.top - row.top;
      if (delta <= 0.5) continue;
      moves.push({ el: row.el, delta, order: row.top });
    }

    applyRowRise(moves);
  }

  measureMetrics() {
    const width = this.container.clientWidth;
    if (width <= 0) {
      this.metrics = null;
      return;
    }

    const containerStyle = getComputedStyle(this.container);
    const padLeft = parseFloat(containerStyle.paddingLeft) || 0;
    const padRight = parseFloat(containerStyle.paddingRight) || 0;

    // Absolute probes live inside the real list, so they inherit the
    // exact fonts, wrapping width, borders, padding and theme.
    const probe = document.createElement('li');
    probe.className = 'topic-item topic-item--complete';
    probe.style.cssText = `position:absolute;left:${padLeft}px;right:${padRight}px;top:0;visibility:hidden;pointer-events:none;z-index:-1;`;
    probe.innerHTML = `
      <label class="cb-hit"><input type="checkbox" class="topic-item__checkbox" checked></label>
      <div class="task-content">
        <div class="task-title">M</div>
        <div class="task-time">12:00 PM</div>
      </div>
    `;

    const headerProbe = document.createElement('li');
    headerProbe.className = 'completed-date-header';
    headerProbe.textContent = 'Today · 26 Oct, 2026';
    headerProbe.style.cssText = `position:absolute;left:${padLeft}px;right:${padRight}px;top:0;visibility:hidden;pointer-events:none;z-index:-1;`;

    // Keep probes before the bottom spacer so :last-child does not
    // strip the real card margin.
    this.container.insertBefore(probe, this.bottomSpacer);
    this.container.insertBefore(headerProbe, this.bottomSpacer);

    const titleEl = probe.querySelector('.task-title');
    const contentEl = probe.querySelector('.task-content');
    const timeEl = probe.querySelector('.task-time');
    const titleStyle = getComputedStyle(titleEl);
    const timeStyle = getComputedStyle(timeEl);

    const font = `${titleStyle.fontStyle} ${titleStyle.fontWeight} ${titleStyle.fontSize} ${titleStyle.fontFamily}`;
    const fontSize = parseFloat(titleStyle.fontSize) || 16;
    const lineHeight = parseFloat(titleStyle.lineHeight) || fontSize * 1.35;
    const letterSpacing = titleStyle.letterSpacing === 'normal'
      ? 0
      : (parseFloat(titleStyle.letterSpacing) || 0);

    const cardBase = probe.offsetHeight;
    const timeBlock = timeEl.offsetHeight > 0
      ? timeEl.offsetHeight + (parseFloat(timeStyle.marginTop) || 0)
      : 0;
    const marginBottom = parseFloat(getComputedStyle(probe).marginBottom) || 0;
    const titleWidth = contentEl.clientWidth;

    const headerHeight = headerProbe.offsetHeight;
    headerProbe.style.paddingTop = '2px';
    const firstHeaderHeight = headerProbe.offsetHeight;

    probe.remove();
    headerProbe.remove();

    this.metrics = {
      cardBase,
      titleWidth,
      lineHeight,
      letterSpacing,
      font,
      timeBlock,
      marginBottom,
      headerHeight,
      firstHeaderHeight
    };
    this.metricsWidth = width;
  }

  estimateHeight(item) {
    const metrics = this.metrics;
    if (!metrics) return item.type === 'header' ? 40 : 86;

    if (item.type === 'header') {
      return item.isFirst ? metrics.firstHeaderHeight : metrics.headerHeight;
    }

    const lines = countWrappedLines(
      item.task.title || '',
      metrics.titleWidth,
      metrics.font,
      metrics.letterSpacing
    );

    let height = metrics.cardBase + Math.max(0, lines - 1) * metrics.lineHeight;
    if (!item.task.completedAt) height -= metrics.timeBlock;
    if (!item.isLast) height += metrics.marginBottom;
    return height;
  }

  heightFor(item) {
    let height = this.heightCache.get(item.key);
    if (height === undefined) {
      height = this.estimateHeight(item);
      this.heightCache.set(item.key, height);
    }
    return height;
  }

  rebuildOffsets(fromIndex) {
    const count = this.items.length;
    let total = fromIndex > 0 ? this.offsets[fromIndex] : 0;

    for (let i = fromIndex; i < count; i++) {
      this.offsets[i] = total;
      total += this.heights[i];
    }

    this.offsets[count] = total;
    this.totalHeight = total;
  }

  setItems(items, { animateInitial = false, resetScroll = false, riseFromId = null } = {}) {
    const oldScrollTop = this.container.scrollTop;

    // Remember the stripe each mounted task had before the rebuild.
    // Deletions shift every following ordinal, so recreating the rows
    // must carry the old colour over to keep the parity change smooth.
    const previousStripes = new Map();
    for (const [idx, el] of this.mounted) {
      const oldItem = this.items[idx];
      if (!oldItem || oldItem.type !== 'task') continue;
      if (!el.isConnected || el.parentNode !== this.container) continue;
      previousStripes.set(
        oldItem.task.id,
        el.classList.contains('is-odd') ? 'is-odd' : 'is-even'
      );
    }
    this.previousStripes = previousStripes.size ? previousStripes : null;
    this.pendingStripes = [];

    // Capture the visible rows below a removed task so they can be
    // held at their old offsets and released upward after the rebuild.
    let oldRise = null;
    if (riseFromId) {
      let removedIndex = -1;
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        if (item.type === 'task' && item.task.id === riseFromId) {
          removedIndex = i;
          break;
        }
      }

      if (removedIndex >= 0) {
        const viewTop = this.container.scrollTop;
        const viewBottom = viewTop + this.container.clientHeight;
        oldRise = new Map();
        for (const [idx, el] of this.mounted) {
          if (idx <= removedIndex) continue;
          const oldItem = this.items[idx];
          if (!oldItem || oldItem.type !== 'task') continue;
          if (!el.isConnected || el.parentNode !== this.container) continue;
          const top = this.offsets[idx];
          const bottom = top + this.heights[idx];
          if (bottom <= viewTop || top >= viewBottom) continue;
          // Store the on-screen offset (and any in-flight ripple) so
          // the rebuilt row can continue from exactly where it is.
          oldRise.set(oldItem.task.id, {
            top: top - oldScrollTop + currentTranslateY(el)
          });
        }
      }
    }

    this.items = items;

    const liveKeys = new Set(items.map(item => item.key));
    for (const key of this.heightCache.keys()) {
      if (!liveKeys.has(key)) this.heightCache.delete(key);
    }

    // Drop every mounted row (and its event listeners) before rebuilding.
    this.mounted.clear();
    this.container.replaceChildren(this.topSpacer, this.bottomSpacer);

    // Reserve a rough height first so the container's scrollbar state
    // (and therefore the measured card width) matches the final list.
    this.setSpacer(this.topSpacer, 0);
    this.setSpacer(this.bottomSpacer, items.length * 96);

    if (this.container.clientWidth !== this.metricsWidth) {
      this.metrics = null;
      this.metricsWidth = this.container.clientWidth;
      this.heightCache.clear();
    }
    if (!this.metrics) this.measureMetrics();

    const count = items.length;
    this.heights = new Float64Array(count);
    this.offsets = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      this.heights[i] = this.heightFor(items[i]);
    }
    this.rebuildOffsets(0);

    this.setSpacer(this.topSpacer, 0);
    this.setSpacer(this.bottomSpacer, this.totalHeight);

    this.container.scrollTop = resetScroll
      ? 0
      : Math.min(oldScrollTop, Math.max(0, this.container.scrollHeight - this.container.clientHeight));

    this.updateWindow(true, animateInitial);
    this.flushStripeTransitions();
    this.flushRowRise(oldRise);
  }

  getVisibleRange(scrollTop, viewportHeight) {
    const minY = Math.max(0, scrollTop - COMPLETED_OVERSCAN);
    const maxY = scrollTop + viewportHeight + COMPLETED_OVERSCAN;
    const count = this.items.length;

    let low = 0;
    let high = count - 1;
    let startIndex = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.offsets[mid + 1] > minY) {
        startIndex = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    low = startIndex;
    high = count - 1;
    let endIndex = startIndex;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.offsets[mid] < maxY) {
        endIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (endIndex < startIndex) endIndex = startIndex;
    return { startIndex, endIndex };
  }

  setSpacer(spacer, height) {
    if (height > 0.5) {
      spacer.style.display = 'block';
      spacer.style.height = `${height}px`;
    } else {
      spacer.style.display = 'none';
      spacer.style.height = '0px';
    }
  }

  measureMountedRows(rows) {
    const previousScroll = this.container.scrollTop;
    let scrollShift = 0;
    let firstChanged = this.items.length;

    for (let i = 0; i < rows.length; i++) {
      const idx = rows[i][0];
      const el = rows[i][1];
      const margin = el.classList.contains('completed-date-header')
        ? 0
        : (el.classList.contains('is-last') ? 0 : (this.metrics?.marginBottom || 0));
      const actual = el.offsetHeight + margin;
      const previous = this.heights[idx];

      if (Math.abs(actual - previous) > 0.5) {
        if (this.offsets[idx] < previousScroll - 0.5) {
          scrollShift += actual - previous;
        }
        this.heights[idx] = actual;
        this.heightCache.set(this.items[idx].key, actual);
        if (idx < firstChanged) firstChanged = idx;
      }
    }

    if (firstChanged < this.items.length) {
      this.rebuildOffsets(firstChanged);
      if (scrollShift) {
        this.container.scrollTop = Math.max(0, previousScroll + scrollShift);
      }
    }

    return scrollShift;
  }

  updateWindow(isInitial = false, animateInitial = false, depth = 0) {
    const count = this.items.length;
    if (!count) {
      this.setSpacer(this.topSpacer, 0);
      this.setSpacer(this.bottomSpacer, 0);
      return;
    }

    const viewportHeight = this.container.clientHeight || 520;
    let scrollTop = this.container.scrollTop;
    let { startIndex, endIndex } = this.getVisibleRange(scrollTop, viewportHeight);

    for (const [idx, el] of this.mounted) {
      if (idx < startIndex || idx > endIndex) {
        el.remove();
        this.mounted.delete(idx);
      }
    }

    const newRows = [];
    for (let idx = startIndex; idx <= endIndex; idx++) {
      if (this.mounted.has(idx)) continue;

      const el = this.renderItem(this.items[idx]);

      let anchor = this.bottomSpacer;
      for (let next = idx + 1; next <= endIndex; next++) {
        const nextEl = this.mounted.get(next);
        if (nextEl) {
          anchor = nextEl;
          break;
        }
      }

      this.container.insertBefore(el, anchor);
      this.mounted.set(idx, el);
      newRows.push([idx, el]);
    }

    if (newRows.length) {
      const shift = this.measureMountedRows(newRows);
      if (shift && depth < 2) {
        this.updateWindow(isInitial, animateInitial, depth + 1);
        return;
      }
    }

    scrollTop = this.container.scrollTop;

    this.setSpacer(this.topSpacer, this.offsets[startIndex]);
    this.setSpacer(
      this.bottomSpacer,
      Math.max(0, this.totalHeight - this.offsets[endIndex + 1])
    );

    this.revealItems(
      scrollTop,
      viewportHeight,
      isInitial ? animateInitial : true,
      isInitial
    );
  }

  revealItems(scrollTop, viewportHeight, animate, isInitial) {
    const viewTop = scrollTop;
    const viewBottom = scrollTop + viewportHeight;
    // On open, any partially visible row may animate. While scrolling,
    // wait until a few pixels are actually inside the viewport so the
    // swoop is visible on screen instead of firing below the fold.
    const revealTop = isInitial ? viewTop : viewTop + COMPLETED_REVEAL_INSET;
    const revealBottom = isInitial ? viewBottom : viewBottom - COMPLETED_REVEAL_INSET;
    const toReveal = [];

    for (const [idx, el] of this.mounted) {
      const itemTop = this.offsets[idx];
      const itemBottom = itemTop + this.heights[idx];

      if (el.classList.contains('is-visible')) {
        // Re-arm rows once they are clearly outside the viewport, so
        // reversing scroll direction animates them again instead of
        // showing a few pre-revealed solid cards next to the viewport.
        // Remove is-visible (not is-instant) so they play the entrance
        // backwards on the way out instead of popping away.
        if (itemBottom < viewTop - COMPLETED_REVEAL_RESET ||
            itemTop > viewBottom + COMPLETED_REVEAL_RESET) {
          if (el.__completedExitTimer) {
            clearTimeout(el.__completedExitTimer);
            el.__completedExitTimer = null;
          }
          el.classList.remove('is-instant', 'is-visible');
          el.style.transitionDelay = '';
          el.style.willChange = 'transform, opacity';
          el.__completedExitTimer = setTimeout(() => {
            if (!el.isConnected) return;
            el.classList.add('is-instant');
            el.style.willChange = 'auto';
            el.__completedExitTimer = null;
          }, REVEAL_EXIT_MS);
        }
        continue;
      }

      if (itemBottom >= revealTop && itemTop <= revealBottom) {
        toReveal.push([idx, el]);
      }
    }

    if (!toReveal.length) return;
    toReveal.sort((a, b) => a[0] - b[0]);

    if (!animate) {
      for (let i = 0; i < toReveal.length; i++) {
        const el = toReveal[i][1];
        if (el.__completedExitTimer) {
          clearTimeout(el.__completedExitTimer);
          el.__completedExitTimer = null;
        }
        el.classList.add('is-instant', 'is-visible');
        el.style.willChange = 'auto';
      }
      return;
    }

    requestAnimationFrame(() => {
      let revealed = 0;
      for (let i = 0; i < toReveal.length; i++) {
        const el = toReveal[i][1];
        if (!el.isConnected || el.classList.contains('is-visible')) continue;

        if (el.__completedExitTimer) {
          clearTimeout(el.__completedExitTimer);
          el.__completedExitTimer = null;
        }
        el.classList.remove('is-instant');
        void el.offsetWidth;
        const delay = isInitial
          ? Math.min((revealed % 5) * COMPLETED_STAGGER, COMPLETED_STAGGER_MAX)
          : 0;
        el.style.transitionDelay = `${delay}ms`;
        el.classList.add('is-visible');
        revealed++;

        setTimeout(() => {
          if (!el.isConnected) return;
          el.style.transitionDelay = '';
          el.style.willChange = 'auto';
        }, 1000);
      }
    });
  }

  invalidateLayout() {
    this.metrics = null;
    this.metricsWidth = -1;
    this.heightCache.clear();
    if (!this.items.length) return;
    this.setItems(this.items, { animateInitial: false, resetScroll: false });
  }

  clear() {
    if (this.scrollRaf) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    this.items = [];
    this.heights = new Float64Array(0);
    this.offsets = new Float64Array(1);
    this.totalHeight = 0;
    this.mounted.clear();
    this.container.replaceChildren();
  }
}

function getCompletedVirtualizer() {
  if (!completedVirtualizer) {
    completedVirtualizer = new CompletedVirtualizer(DOM.completedList);
  }
  return completedVirtualizer;
}

function renderCompletedTasks({ animate = false, resetScroll = false, riseFromId = null } = {}) {
  // The panel is closed: no DOM work is needed until it opens.
  if (DOM.completedPanel.classList.contains('hidden') && !animate) return;
  if (completedDrag) return;

  const completed = tasks
    .filter(t => t.completed)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  const now = Date.now();
  const signatureParts = new Array(completed.length + 1);
  signatureParts[0] = new Date(now).toDateString();
  for (let i = 0; i < completed.length; i++) {
    const task = completed[i];
    const completedAt = getTaskCompletionTime(task) || 0;
    const locked = completedAt && now - completedAt >= ONE_HOUR_MS ? 1 : 0;
    signatureParts[i + 1] = `${task.id}\u0001${completedAt}\u0001${task.title}\u0001${locked}`;
  }
  const signature = signatureParts.join('\u0002');

  if (!animate && !resetScroll && signature === lastCompletedSignature) return;
  lastCompletedSignature = signature;

  DOM.completedEmpty.style.display = completed.length ? 'none' : 'block';

  const virtualizer = getCompletedVirtualizer();
  virtualizer.setItems(buildCompletedItems(completed), {
    animateInitial: animate,
    resetScroll,
    riseFromId
  });
}


// ── Modal logic ──
function openAddModal(e) {
  DOM.addModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  DOM.modalInput.value = '';
  DOM.modalInput.focus();
}

DOM.fabAdd.addEventListener('click', openAddModal);

function closeModal() {
  DOM.addModal.classList.add('hidden');
  document.body.style.overflow = '';
}

DOM.modalCancel.addEventListener('click', closeModal);
DOM.addModal.addEventListener('click', e => {
  if (e.target === DOM.addModal) closeModal();
});

DOM.modalConfirm.addEventListener('click', () => {
  const title = DOM.modalInput.value.trim();
  if (!title) return;

  const activeTasks = tasks.filter(t => !t.completed);
  const pos = activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].position + 1000 : 1000;

  const newTask = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    title,
    completed: false,
    completedAt: null,
    position: pos,
    _lastMutatedAt: Date.now()
  };

  tasks.push(newTask);
  saveTasks(); // instant cache
  const el = createTaskElement(newTask);
  revealActiveTaskNow(el, newTask.id);
  el.classList.add('card--animate-in');
  DOM.taskList.appendChild(el);
  rebuildActiveGeometry();
  scheduleActiveReveal();
  updateZebraStripes(DOM.taskList);
  closeModal();

  DOM.modalConfirm.disabled = true;
  
  if (db) {
    db.from('tasks').insert([{
      id: newTask.id,
      text: newTask.title,
      completed: newTask.completed,
      completedAt: newTask.completedAt,
      position: newTask.position
    }]).then(({error}) => { 
      DOM.modalConfirm.disabled = false;
      if (error && error.code !== '23505') console.error(error); 
    }).catch(err => {
      DOM.modalConfirm.disabled = false;
      console.warn('Supabase insert failed', err);
    });
  } else {
    DOM.modalConfirm.disabled = false;
  }

  DOM.modalInput.value = '';
  closeModal();
});

DOM.modalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') DOM.modalConfirm.click();
  if (e.key === 'Escape') closeModal();
});


// ══════════════════════════════════
//  Completed Panel
// ══════════════════════════════════

let completedScrim = null;
let preventScrimClose = false;
let completedPanelTimer = null;
let completedClearTimer = null;

function openCompletedPanel() {
  if (completedClearTimer) {
    clearTimeout(completedClearTimer);
    completedClearTimer = null;
  }
  DOM.completedPanel.classList.remove('hidden');

  // Lock task list scroll while panel is open
  DOM.main.style.overflow = 'hidden';

  // Create scrim
  if (!completedScrim) {
    completedScrim = document.createElement('div');
    completedScrim.className = 'completed-scrim';
    completedScrim.innerHTML = `
      <div class="completed-trash-zone">
        <div class="completed-trash-circle">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </div>
      </div>
    `;
    completedScrim.addEventListener('click', () => {
      if (preventScrimClose) return;
      closeCompletedPanel();
    });
    document.body.appendChild(completedScrim);
  }

  // Force reflow then show
  completedScrim.offsetHeight;
  completedScrim.classList.remove('hidden');

  renderCompletedTasks({ animate: true, resetScroll: true });

  if (completedPanelTimer) clearInterval(completedPanelTimer);
  completedPanelTimer = setInterval(renderCompletedTasks, 30000);
}

function closeCompletedPanel() {
  DOM.completedPanel.classList.add('hidden');
  DOM.main.style.overflow = '';
  if (completedScrim) {
    completedScrim.classList.remove('completed-scrim--delete-mode', 'completed-scrim--hovered');
    completedScrim.classList.add('hidden');
  }
  if (completedPanelTimer) {
    clearInterval(completedPanelTimer);
    completedPanelTimer = null;
  }
  // Let the panel finish sliding out, then release every mounted row
  // and its listeners. Reopening cancels this cleanup.
  if (completedClearTimer) clearTimeout(completedClearTimer);
  completedClearTimer = setTimeout(() => {
    completedClearTimer = null;
    if (!DOM.completedPanel.classList.contains('hidden')) return;
    if (completedVirtualizer) completedVirtualizer.clear();
  }, 380);
}

DOM.completedBtn.addEventListener('click', openCompletedPanel);
DOM.completedClose.addEventListener('click', closeCompletedPanel);


// ══════════════════════════════════
//  Tick → Dismiss Animation
// ══════════════════════════════════

function handleTaskComplete(e, li, id) {
  e.preventDefault();
  const cb = e.target;
  cb.checked = true;

  const task = tasks.find(t => t.id === id);
  if (task) {
    task.completed = true;
    task.completedAt = Date.now();
    task._lastMutatedAt = Date.now();
    saveTasks(); // instant cache
    if (db) db.from('tasks').update({ completed: true, completedAt: task.completedAt }).eq('id', task.id).then();
  }

  li.classList.add('topic-item--complete', 'topic-item--celebrate');
  const td = li.querySelector('.task-time');
  if (td) td.innerHTML = formatCompletedTime(task.completedAt);

  // Confetti + flash + ripple
  spawnConfetti(li, cb);
  spawnFlash(li);
  spawnRipple(li, cb);

  // After the celebration: detach the card from the flow, let it fall
  // away, and ripple the visible rows below into the freed slot.
  setTimeout(() => {
    li.classList.remove('topic-item--celebrate');

    // The completed styling expanded this card's time block, so the
    // cached card offsets are now stale. Refresh them before capture
    // or the rows below would jump up by the grown amount.
    rebuildActiveGeometry();

    const rise = captureActiveRiseBelow(li);
    const scrollTop = DOM.main.scrollTop;

    detachActiveCard(li);
    animateCardAway(li);

    // Undo any scroll anchoring caused by the instant detach.
    DOM.main.scrollTop = scrollTop;

    updateZebraStripes(DOM.taskList);
    rebuildActiveGeometry();
    scheduleActiveReveal();
    applyActiveRise(rise);
    renderCompletedTasks();

    setTimeout(() => {
      DOM.completedBtn.classList.remove('header-icon-btn--flash');
      requestAnimationFrame(() => {
        DOM.completedBtn.classList.add('header-icon-btn--flash');
        DOM.completedBtn.addEventListener('animationend', () => {
          DOM.completedBtn.classList.remove('header-icon-btn--flash');
        }, { once: true });
      });
    }, 80);
  }, 80);
}


// ══════════════════════════════════
//  Untick (from completed panel)
// ══════════════════════════════════

function handleUntick(li, id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  if (isTaskLocked(task)) return;
  
  // Immediately disable to prevent double-tap
  li.style.pointerEvents = 'none';
  
  task.completed = false;
  task.completedAt = null;
  const activeTasks = tasks.filter(t => !t.completed);
  task.position = activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].position + 1000 : 1000;
  task._lastMutatedAt = Date.now();
  saveTasks();
  if (db) db.from('tasks').update({ completed: false, completedAt: null, position: task.position }).eq('id', task.id).then();

  // Lift the row out of the completed list, then ripple the rows below
  // upward while the removed row drifts away.
  animateCardAway(li, 'translateX(50%) scale(0.85)');

  // Rebuild the virtual list (also removes an empty date header) and
  // stagger the visible rows beneath the removed task.
  renderCompletedTasks({ riseFromId: id });

  // Add back to main list. This is not a first-entrance reveal, so
  // keep it instant and let the existing return animation play.
  const newEl = createTaskElement(task);
  revealActiveTaskNow(newEl, task.id);
  newEl.classList.add('card--animate-in');
  DOM.taskList.appendChild(newEl);
  rebuildActiveGeometry();
  scheduleActiveReveal();
  updateZebraStripes(DOM.taskList);
}


// ══════════════════════════════════
//  Celebrations (Pure CSS — Zero JS per frame)
// ══════════════════════════════════

const CONFETTI_COLORS = ['#2a9c73','#34d399','#10b981','#059669','#6ee7b7','#a7f3d0','#d1fae5','#065f46'];
const PARTICLE_COUNT = 16;

function spawnConfetti(label, cb) {
  const r = cb.getBoundingClientRect();
  const ox = r.left + r.width / 2;
  const oy = r.top + r.height / 2;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'css-particle';

    const angle = Math.random() * Math.PI * 2; // full 360 degree outward splash
    const dist = 40 + Math.random() * 80;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    const sz = 6 + Math.random() * 8;
    const rot = (Math.random() - 0.5) * 720;
    const dur = 0.5 + Math.random() * 0.3;

    el.style.cssText = `
      left:${ox}px;top:${oy}px;
      width:${sz}px;height:${sz * (0.4 + Math.random() * 0.6)}px;
      background:${CONFETTI_COLORS[Math.random() * CONFETTI_COLORS.length | 0]};
      border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
      --tx:${tx}px;--ty:${ty}px;--rot:${rot}deg;
      animation-duration:${dur}s;
    `;

    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }
}

function spawnFlash(li) {
  const f = document.createElement('div'); f.className='topic-item__flash';
  li.appendChild(f); setTimeout(()=>f.remove(),650);
}

function spawnRipple(li, cb) {
  const lr = li.getBoundingClientRect(), cr = cb.getBoundingClientRect();
  const rip = document.createElement('div'); rip.className='topic-item__ripple';
  rip.style.left = (cr.left-lr.left+cr.width/2)+'px';
  rip.style.top  = (cr.top -lr.top +cr.height/2)+'px';
  li.appendChild(rip); setTimeout(()=>rip.remove(),550);
}


// ══════════════════════════════════════════════════
//  Drag Reorder with FLIP + Spring
// ══════════════════════════════════════════════════

let drag = null;
let potentialDrag = null;
let longPressTimeout = null;

function itemsInList() {
  return Array.from(DOM.taskList.querySelectorAll('.topic-item'));
}

function onPointerDown(e) {
  if (e.target.closest('.cb-hit') || e.target.closest('input') || drag) return;
  const item = e.currentTarget;

  item.setPointerCapture(e.pointerId);

  potentialDrag = {
    item,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    rect: item.getBoundingClientRect()
  };

  longPressTimeout = setTimeout(() => {
    if (!potentialDrag) return;
    if (navigator.vibrate) navigator.vibrate(50);
    startDrag(potentialDrag, true);
  }, 100);

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup',   onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function startDrag(pd, isReordering) {
  clearTimeout(longPressTimeout);
  
  const item = pd.item;
  const rect = pd.rect;

  // Kill any running spring
  const s = spring(item);
  s.y = 0; s.vy = 0; s.target = 0;
  alive.delete(item);
  item.style.transform = '';
  item.style.translate = '';

  // Placeholder
  const ph = document.createElement('li');
  ph.className = 'drag-placeholder';
  ph.style.height = rect.height + 'px';
  ph.style.marginBottom = getComputedStyle(item).marginBottom;
  
  // Inner content for swipe-to-delete trash icon
  const phContent = document.createElement('div');
  phContent.className = 'drag-placeholder__content';
  phContent.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>
  `;
  ph.appendChild(phContent);

  item.parentNode.insertBefore(ph, item);

  // Lift item
  item.classList.add('drag-active');
  item.style.position = 'fixed';
  item.style.width = rect.width + 'px';
  item.style.left = rect.left + 'px';
  item.style.top  = rect.top  + 'px';
  item.style.margin = '0';
  item.style.zIndex = '9000';
  item.style.pointerEvents = 'none';
  item.style.transition = 'box-shadow 0.25s ease';
  document.body.appendChild(item);

  drag = {
    item, ph,
    isReordering,
    pointerId: pd.pointerId,
    ox: pd.startX - rect.left,
    oy: pd.startY - rect.top,
    isDeleting: false,
    startY: pd.startY,
    clientY: pd.startY,
    clientX: pd.startX,
    initialLeft: rect.left,
    itemWidth: rect.width
  };

  // Hide FAB during drag
  document.body.classList.add('is-dragging');
  document.getElementById('fabContainer').classList.add('fab-hide');

  // The lifted card left the list, so rebuild now to keep reveal
  // geometry aligned with the placeholder gap.
  rebuildActiveGeometry();
  scheduleActiveReveal();

  drag.scrollRAF = requestAnimationFrame(autoScrollLoop);
  potentialDrag = null;
}

function updatePlaceholder(dragY) {
  if (!drag) return;

  // Lock vertical sorting if the user is swiping left.
  // If the placeholder DOM node moves while swiping, it resets the CSS keyframe animations!
  const swipeLeftDistance = drag.initialLeft - drag.clientX;
  if (swipeLeftDistance > drag.itemWidth * 0.05) return;

  const children = Array.from(DOM.taskList.children);
  const listTop = DOM.taskList.getBoundingClientRect().top;
  let newIdx = children.length;

  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c === drag.ph) continue;
    const mid = listTop + c.offsetTop + c.offsetHeight / 2;
    if (dragY < mid) { newIdx = i; break; }
  }

  const phIdx = children.indexOf(drag.ph);
  if (newIdx !== phIdx) {
    const items = itemsInList();
    const before = captureRects(items);

    if (newIdx >= children.length) DOM.taskList.appendChild(drag.ph);
    else DOM.taskList.insertBefore(drag.ph, children[newIdx] === drag.ph ? children[newIdx+1] : children[newIdx]);

    flipAnimate(itemsInList(), before);
    // Moving the placeholder shifts every card between slots; refresh
    // the reveal cache so auto-scroll reveals the right rows.
    rebuildActiveGeometry();
    scheduleActiveReveal();
  }
}

function autoScrollLoop() {
  if (!drag) return;
  
  let scrolled = false;
  const topEdge = 100;
  const bottomEdge = window.innerHeight - 100;

  if (drag.clientY < topEdge) { 
    // Scroll faster the closer they get to the edge
    const speed = Math.max(5, (topEdge - drag.clientY) * 0.3);
    DOM.main.scrollBy(0, -speed); 
    scrolled = true; 
  } else if (drag.clientY > bottomEdge) { 
    const speed = Math.max(5, (drag.clientY - bottomEdge) * 0.3);
    DOM.main.scrollBy(0, speed); 
    scrolled = true; 
  }
  
  if (scrolled) {
    updatePlaceholder(drag.clientY);
  }
  
  drag.scrollRAF = requestAnimationFrame(autoScrollLoop);
}

function onPointerMove(e) {
  if (potentialDrag && !drag) {
    const dx = e.clientX - potentialDrag.startX;
    const dy = e.clientY - potentialDrag.startY;
    
    // If user moves significantly before the long-press timer triggers
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(longPressTimeout);
      
      // If mostly horizontal, trigger swipe-to-delete drag
      if (Math.abs(dx) > Math.abs(dy)) {
        startDrag(potentialDrag, false);
      } else {
        // If mostly vertical, let the browser scroll natively.
        // We cancel potential drag completely.
        try { potentialDrag.item.releasePointerCapture(potentialDrag.pointerId); } catch(_) {}
        potentialDrag = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup',   onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        return;
      }
    } else {
      // Haven't moved enough to cancel timer, wait.
      return;
    }
  }

  if (!drag) return;
  const { item, ph, ox, oy, initialLeft, itemWidth } = drag;
  drag.clientY = e.clientY;
  drag.clientX = e.clientX;

  item.style.left = (e.clientX - ox) + 'px';
  item.style.top  = (e.clientY - oy) + 'px';

  // Calculate left swipe distance relative to item's starting position
  const currentItemLeft = e.clientX - ox;
  const swipeLeftDistance = initialLeft - currentItemLeft;

  // Hysteresis threshold latching to eliminate flickering during drag
  const enterDeleteThreshold = itemWidth * 0.32; // Trigger ON at 32% left swipe
  const exitDeleteThreshold  = itemWidth * 0.20; // Trigger OFF only when pulled back right past 20%
  const startRed             = itemWidth * 0.08; // Red starts glowing at 8% left swipe
  
  // Calculate progress for smooth red gradient blending
  let progress = 0;
  if (swipeLeftDistance > startRed) {
    progress = Math.min(1, (swipeLeftDistance - startRed) / (enterDeleteThreshold - startRed));
  }
  drag.ph.style.setProperty('--red-progress', progress);

  // Continuously scale down and rotate the item card as we swipe left
  const currentScale = 1 - (0.15 * progress);
  const currentRotate = -3 * progress;
  item.style.transform = `scale(${currentScale}) rotate(${currentRotate}deg)`;

  // Latch delete state with buffer zone
  let inDeleteZone = drag.isDeleting;
  if (!drag.isDeleting && swipeLeftDistance >= enterDeleteThreshold) {
    inDeleteZone = true;
  } else if (drag.isDeleting && swipeLeftDistance < exitDeleteThreshold) {
    inDeleteZone = false;
  }

  const phContent = drag.ph.querySelector('.drag-placeholder__content');
  
  if (inDeleteZone !== drag.isDeleting) {
    drag.isDeleting = inDeleteZone;
    if (inDeleteZone) {
      if (phContent) {
        phContent.classList.add('delete-active');
      }
      item.style.boxShadow = '0 5px 15px rgba(0,0,0,0.1)'; 
    } else {
      if (phContent) {
        phContent.classList.remove('delete-active');
      }
      item.style.boxShadow = '0 15px 30px rgba(0,0,0,0.15)'; 
    }
  }

  updatePlaceholder(drag.clientY);
}

function onPointerUp(e) {
  if (potentialDrag && !drag) {
    clearTimeout(longPressTimeout);
    try { potentialDrag.item.releasePointerCapture(potentialDrag.pointerId); } catch(_) {}
    potentialDrag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup',   onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    return;
  }

  if (!drag) return;
  const { item, ph, pointerId } = drag;

  try { item.releasePointerCapture(pointerId); } catch(_) {}
  
  cancelAnimationFrame(drag.scrollRAF);

  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup',   onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);

  // Restore FAB
  document.getElementById('fabContainer').classList.remove('fab-hide');
  document.body.classList.remove('is-dragging');

  if (drag.isDeleting) {
    // Capture the visible rows below the placeholder before the slot
    // disappears, then release them in a CSS ripple.
    const rise = captureActiveRiseBelow(ph);
    const scrollTop = DOM.main.scrollTop;

    animateDetachedCard(item);
    ph.remove();

    const task = tasks.find(t => t.id === item.dataset.id);
    if (task) task._lastMutatedAt = Date.now();
    tasks = tasks.filter(t => t.id !== item.dataset.id);
    saveTasks(); // instant cache
    if (db) db.from('tasks').delete().eq('id', item.dataset.id).then();

    DOM.main.scrollTop = scrollTop;
    rebuildActiveGeometry();
    scheduleActiveReveal();
    updateZebraStripes(DOM.taskList);
    applyActiveRise(rise);

    drag = null;
    return;
  }

  // Fly item back to slot
  const pr = ph.getBoundingClientRect();
  item.style.transition = 'left .25s cubic-bezier(.25,1,.5,1), top .25s cubic-bezier(.25,1,.5,1), transform .25s cubic-bezier(.25,1,.5,1)';
  item.style.left = pr.left + 'px';
  item.style.top  = pr.top  + 'px';
  item.style.transform = 'scale(1)';

  function settle() {
    item.removeEventListener('transitionend', settle);
    clearTimeout(fallback);

    item.classList.remove('drag-active');
    item.style.cssText = '';
    DOM.taskList.insertBefore(item, ph);
    ph.remove();
    rebuildActiveGeometry();
    scheduleActiveReveal();

    // Sync data
    const nodes = Array.from(DOM.taskList.querySelectorAll('.topic-item'));
    const newDOMIdx = nodes.indexOf(item);
    const droppedTask = tasks.find(t => t.id === item.dataset.id);
    
    let newPos = 1000;
    if (nodes.length === 1) {
      newPos = 1000;
    } else if (newDOMIdx === 0) {
      const nextId = nodes[1].dataset.id;
      const nextTask = tasks.find(t => t.id === nextId);
      newPos = nextTask.position / 2;
    } else if (newDOMIdx === nodes.length - 1) {
      const prevId = nodes[nodes.length - 2].dataset.id;
      const prevTask = tasks.find(t => t.id === prevId);
      newPos = prevTask.position + 1000;
    } else {
      const prevId = nodes[newDOMIdx - 1].dataset.id;
      const nextId = nodes[newDOMIdx + 1].dataset.id;
      const prevTask = tasks.find(t => t.id === prevId);
      const nextTask = tasks.find(t => t.id === nextId);
      newPos = (prevTask.position + nextTask.position) / 2;
    }
    droppedTask.position = newPos;
    droppedTask._lastMutatedAt = Date.now();

    tasks.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.completed) return (b.completedAt || 0) - (a.completedAt || 0);
      return a.position - b.position;
    });

    saveTasks(); // instant cache
    if (db) db.from('tasks').update({ position: newPos }).eq('id', droppedTask.id).then();
    updateZebraStripes(DOM.taskList);
    drag = null;
    
    if (pendingRemoteRender) {
      scheduleRender();
    }
  }

  item.addEventListener('transitionend', settle, { once: true });
  const fallback = setTimeout(settle, 300);
}


// ══════════════════════════════════════════════════
//  Completed Task Drag-to-Delete Outside Panel
// ══════════════════════════════════════════════════

let potentialCompletedDrag = null;
let completedLongPressTimeout = null;

function onCompletedPointerDown(e) {
  if (e.target.closest('.cb-hit') || e.target.closest('input') || completedDrag || drag) return;
  const item = e.currentTarget;

  item.setPointerCapture(e.pointerId);

  potentialCompletedDrag = {
    item,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    rect: item.getBoundingClientRect()
  };

  completedLongPressTimeout = setTimeout(() => {
    if (!potentialCompletedDrag) return;
    if (navigator.vibrate) navigator.vibrate(50);
    startCompletedDrag(potentialCompletedDrag);
  }, 100);

  window.addEventListener('pointermove', onCompletedPointerMove);
  window.addEventListener('pointerup',   onCompletedPointerUp);
  window.addEventListener('pointercancel', onCompletedPointerUp);
}

function startCompletedDrag(pd) {
  clearTimeout(completedLongPressTimeout);

  const item = pd.item;
  const rect = pd.rect;

  // Placeholder in completedList (preserves scroll position and slot)
  const ph = document.createElement('li');
  ph.className = 'completed-drag-placeholder';
  ph.style.height = rect.height + 'px';
  ph.style.marginBottom = getComputedStyle(item).marginBottom;
  item.parentNode.insertBefore(ph, item);

  // Lift item
  item.classList.add('completed-drag-active');
  item.style.position = 'fixed';
  item.style.width = rect.width + 'px';
  item.style.left = rect.left + 'px';
  item.style.top  = rect.top  + 'px';
  item.style.margin = '0';
  item.style.zIndex = '9500';
  item.style.pointerEvents = 'none';
  document.body.appendChild(item);

  completedDrag = {
    item,
    ph,
    pointerId: pd.pointerId,
    ox: pd.startX - rect.left,
    oy: pd.startY - rect.top,
    isOutside: false,
    startX: pd.startX,
    startY: pd.startY,
    clientX: pd.startX,
    clientY: pd.startY
  };

  potentialCompletedDrag = null;

  // Reveal red delete zone smoothly on the scrim outside completed panel
  if (completedScrim) {
    completedScrim.classList.add('completed-scrim--delete-mode');
  }
}

function isPointerOutsideCompletedPanel(clientX, wasOutside = false) {
  const panelWidth = DOM.completedPanel.offsetWidth || Math.min(380, window.innerWidth * 0.78);
  const panelLeft = window.innerWidth - panelWidth;
  const threshold = wasOutside ? (panelLeft + 12) : (panelLeft - 8);
  return clientX < threshold;
}

function onCompletedPointerMove(e) {
  if (potentialCompletedDrag && !completedDrag) {
    const dx = e.clientX - potentialCompletedDrag.startX;
    const dy = e.clientY - potentialCompletedDrag.startY;

    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(completedLongPressTimeout);

      // If user drags horizontally towards the outside (leftwards)
      if (dx < -8 && Math.abs(dx) > Math.abs(dy)) {
        startCompletedDrag(potentialCompletedDrag);
      } else if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical swipe: let list scroll natively
        try { potentialCompletedDrag.item.releasePointerCapture(potentialCompletedDrag.pointerId); } catch(_) {}
        potentialCompletedDrag = null;
        window.removeEventListener('pointermove', onCompletedPointerMove);
        window.removeEventListener('pointerup',   onCompletedPointerUp);
        window.removeEventListener('pointercancel', onCompletedPointerUp);
        return;
      }
    } else {
      return;
    }
  }

  if (!completedDrag) return;

  const { item, ox, oy } = completedDrag;
  completedDrag.clientX = e.clientX;
  completedDrag.clientY = e.clientY;

  item.style.left = (e.clientX - ox) + 'px';
  item.style.top  = (e.clientY - oy) + 'px';

  // Check if touch point reaches the red area outside the completed panel
  const isOutside = isPointerOutsideCompletedPanel(e.clientX, completedDrag.isOutside);

  if (isOutside !== completedDrag.isOutside) {
    completedDrag.isOutside = isOutside;
    if (isOutside) {
      if (completedScrim) completedScrim.classList.add('completed-scrim--hovered');
      item.classList.add('completed-drag-item--shrink');
    } else {
      if (completedScrim) completedScrim.classList.remove('completed-scrim--hovered');
      item.classList.remove('completed-drag-item--shrink');
    }
  }
}

function onCompletedPointerUp(e) {
  if (potentialCompletedDrag && !completedDrag) {
    clearTimeout(completedLongPressTimeout);
    try { potentialCompletedDrag.item.releasePointerCapture(potentialCompletedDrag.pointerId); } catch(_) {}
    potentialCompletedDrag = null;
    window.removeEventListener('pointermove', onCompletedPointerMove);
    window.removeEventListener('pointerup',   onCompletedPointerUp);
    window.removeEventListener('pointercancel', onCompletedPointerUp);
    return;
  }

  if (!completedDrag) return;
  const { item, ph, pointerId } = completedDrag;
  const isOutside = isPointerOutsideCompletedPanel(completedDrag.clientX, completedDrag.isOutside);

  try { item.releasePointerCapture(pointerId); } catch(_) {}

  window.removeEventListener('pointermove', onCompletedPointerMove);
  window.removeEventListener('pointerup',   onCompletedPointerUp);
  window.removeEventListener('pointercancel', onCompletedPointerUp);

  // Prevent scrim click closing the panel on drop
  preventScrimClose = true;
  setTimeout(() => { preventScrimClose = false; }, 200);

  if (completedScrim) {
    completedScrim.classList.remove('completed-scrim--delete-mode', 'completed-scrim--hovered');
  }

  if (isOutside) {
    // Delete permanently!
    if (navigator.vibrate) navigator.vibrate([40, 50, 40]);

    const taskId = item.dataset.id;

    // Drop the row out of the completed list and rebuild it right away.
    // The virtualizer replays a CSS ripple on the visible rows below.
    animateDetachedCard(item);
    ph.remove();
    completedDrag = null;

    const task = tasks.find(t => t.id === taskId);
    if (task) task._lastMutatedAt = Date.now();
    tasks = tasks.filter(t => t.id !== taskId);
    saveTasks();
    if (db) db.from('tasks').delete().eq('id', taskId).then();

    renderCompletedTasks({ riseFromId: taskId });
    return;
  }

  // Inside panel: fly item back into its slot smoothly
  const pr = ph.getBoundingClientRect();
  item.classList.remove('completed-drag-item--shrink');
  item.style.transition = 'left 0.25s cubic-bezier(0.22, 1, 0.36, 1), top 0.25s cubic-bezier(0.22, 1, 0.36, 1), transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)';
  item.style.left = pr.left + 'px';
  item.style.top  = pr.top  + 'px';
  item.style.transform = 'scale(1)';

  function settleCompleted() {
    item.removeEventListener('transitionend', settleCompleted);
    clearTimeout(fallback);

    item.classList.remove('completed-drag-active', 'completed-drag-item--shrink');
    item.style.cssText = '';
    DOM.completedList.insertBefore(item, ph);
    ph.remove();
    completedDrag = null;
  }

  item.addEventListener('transitionend', settleCompleted, { once: true });
  const fallback = setTimeout(settleCompleted, 300);
}

// Prevent scrolling while dragging
window.addEventListener('touchmove', (e) => {
  if (drag || completedDrag) {
    e.preventDefault();
  }
}, { passive: false });

// Web fonts change glyph widths (and therefore wrapped title heights).
// Re-measure once the real font is ready so scroll geometry stays exact.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    rebuildActiveGeometry();
    scheduleActiveReveal();
    if (completedVirtualizer) completedVirtualizer.invalidateLayout();
  }).catch(() => {});
}
