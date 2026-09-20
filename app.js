let supabaseUrl = '';
let supabaseKey = '';
let db = null;

const DOM = {
  themeToggle: document.getElementById('themeToggle'),
  themeIconMoon: document.getElementById('themeIconMoon'),
  themeIconSun: document.getElementById('themeIconSun'),
  taskList: document.getElementById('taskList'),
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

let tasks = JSON.parse(localStorage.getItem('taski_tasks') || '[]');

// Instant Paint! Render cache immediately before any network requests
if (tasks.length > 0) {
  renderActiveTasks();
  renderCompletedTasks();
}

let renderBatchTimer = null;
let pendingRemoteRender = false;

function scheduleRender() {
  if (renderBatchTimer) return;
  
  if (document.body.classList.contains('is-dragging')) {
    pendingRemoteRender = true;
    return;
  }
  
  renderBatchTimer = requestAnimationFrame(() => {
    renderBatchTimer = null;
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
    const env = await res.json();
    supabaseUrl = env.url;
    supabaseKey = env.key;
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
  } catch (e) {
    console.error('Failed to initialize app', e);
    alert("Could not load database credentials. If testing locally, you must run 'npx wrangler pages dev'.");
  }
}

initApp();

async function loadTasks() {
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
        el.style.transform = `translateY(${s.y}px)`;
      }

      if (Math.abs(s.y - s.target) < REST_DELTA && Math.abs(s.vy) < REST_VELOCITY) {
        s.y = s.target;
        s.vy = 0;
        
        if (s.onUpdate) {
          s.onUpdate(s.y, el);
        } else {
          el.style.transform = s.target === 0 ? '' : `translateY(${s.target}px)`;
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
    const s = spring(el);
    const currentY = s.onUpdate ? 0 : (s.y || 0);
    const rect = el.getBoundingClientRect();
    map.set(el, rect.top - currentY);
  }
  return map;
}

function flipAnimate(elements, oldTops) {
  for (const el of elements) {
    const oldTop = oldTops.get(el);
    if (oldTop === undefined) continue;

    const s = spring(el);
    const currentY = s.onUpdate ? 0 : (s.y || 0);
    const newRect = el.getBoundingClientRect();
    const newTop = newRect.top - currentY;

    const dy = oldTop - newTop;
    if (Math.abs(dy) < 1) continue;

    animateSpring(el, currentY + dy);
  }
}


// ══════════════════════════════════
//  Rendering
// ══════════════════════════════════

function createTaskElement(task, forCompletedPanel = false) {
  const li = document.createElement('li');
  li.className = `topic-item ${task.completed ? 'topic-item--complete' : ''}`;
  li.dataset.id = task.id;

  li.innerHTML = `
    <label class="cb-hit">
      <input type="checkbox" class="topic-item__checkbox" ${task.completed ? 'checked' : ''}>
    </label>
    <div class="task-content">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-time">${task.completedAt ? 'Completed ' + new Date(task.completedAt).toLocaleString() : ''}</div>
    </div>
  `;

  const cb = li.querySelector('.topic-item__checkbox');

  if (forCompletedPanel) {
    // In completed panel: unticking restores the task
    cb.addEventListener('change', () => handleUntick(li, task.id));
  } else {
    // In main list: ticking triggers dismiss animation
    cb.addEventListener('change', e => handleTaskComplete(e, li, task.id));
    // Clean up entry animation
    li.classList.add('card--animate-in');
    li.addEventListener('animationend', () => li.classList.remove('card--animate-in'), { once: true });
    // Drag
    li.addEventListener('pointerdown', onPointerDown);
  }

  return li;
}

function updateZebraStripes(listElement = DOM.taskList) {
  const items = Array.from(listElement.querySelectorAll('.topic-item'));
  items.forEach((item, index) => {
    // Ignore dismissing items when calculating order
    if (item.style.pointerEvents === 'none') return;
    
    // We need to calculate index ignoring dismissing items
    const visibleIndex = items.filter(el => el.style.pointerEvents !== 'none').indexOf(item);
    
    if (visibleIndex % 2 === 0) {
      item.classList.add('is-odd');
      item.classList.remove('is-even');
    } else {
      item.classList.add('is-even');
      item.classList.remove('is-odd');
    }
  });
}

function renderActiveTasks() {
  DOM.taskList.innerHTML = '';
  tasks.filter(t => !t.completed).forEach(t => {
    const el = createTaskElement(t);
    // Don't animate-in on generic re-renders to prevent flashing
    DOM.taskList.appendChild(el);
  });
  updateZebraStripes(DOM.taskList);
}

function renderCompletedTasks() {
  DOM.completedList.innerHTML = '';
  const completed = tasks.filter(t => t.completed).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  completed.forEach(t => {
    const el = createTaskElement(t, true);
    el.classList.remove('card--animate-in');
    DOM.completedList.appendChild(el);
  });
  updateZebraStripes(DOM.completedList);
  DOM.completedEmpty.style.display = completed.length ? 'none' : 'block';
}


// ── Modal logic ──
DOM.fabAdd.addEventListener('click', () => {
  DOM.addModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  DOM.modalInput.value = '';
  DOM.modalInput.focus();
});

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
  el.classList.add('card--animate-in');
  DOM.taskList.appendChild(el);
  updateZebraStripes(DOM.taskList);
  closeModal();

  DOM.modalConfirm.disabled = true;
  
  db.from('tasks').insert([{
    id: newTask.id,
    text: newTask.title,
    completed: newTask.completed,
    completedAt: newTask.completedAt,
    position: newTask.position
  }]).then(({error}) => { 
    DOM.modalConfirm.disabled = false;
    if (error && error.code !== '23505') console.error(error); 
  });

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

function openCompletedPanel() {
  renderCompletedTasks();
  DOM.completedPanel.classList.remove('hidden');

  // Create scrim
  if (!completedScrim) {
    completedScrim = document.createElement('div');
    completedScrim.className = 'completed-scrim';
    completedScrim.addEventListener('click', closeCompletedPanel);
    document.body.appendChild(completedScrim);
  }
  // Force reflow then show
  completedScrim.offsetHeight;
  completedScrim.classList.remove('hidden');
}

function closeCompletedPanel() {
  DOM.completedPanel.classList.add('hidden');
  if (completedScrim) completedScrim.classList.add('hidden');
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
    db.from('tasks').update({ completed: true, completedAt: task.completedAt }).eq('id', task.id).then();
  }

  li.classList.add('topic-item--complete', 'topic-item--celebrate');
  const td = li.querySelector('.task-time');
  if (td) td.textContent = 'Completed ' + new Date(task.completedAt).toLocaleString();

  // Confetti + flash + ripple
  spawnConfetti(li, cb);
  spawnFlash(li);
  spawnRipple(li, cb);

  // After 1s: slide left + shrink + green + fade out (driven by spring physics)
  setTimeout(() => {
    li.classList.remove('topic-item--celebrate');

    li.style.pointerEvents = 'none';
    li.style.overflow = 'hidden';
    
    // Trigger stripe update immediately so siblings fade colors during the animation
    updateZebraStripes(DOM.taskList);
    
    const startHeight = li.offsetHeight;

      // Flash the completed icon in header after 100ms artificial delay
      setTimeout(() => {
        DOM.completedBtn.classList.remove('header-icon-btn--flash');
        DOM.completedBtn.offsetHeight; // Force reflow
        DOM.completedBtn.classList.add('header-icon-btn--flash');
        DOM.completedBtn.addEventListener('animationend', () => {
          DOM.completedBtn.classList.remove('header-icon-btn--flash');
        }, { once: true });
      }, 100);

    animateSpring(li, startHeight, 0, (y, el) => {
      // y goes from startHeight to 0 with spring physics
      const progress = y / startHeight; // 1 down to 0
      
      el.style.height = `${y}px`;
      el.style.marginBottom = `${progress * 8}px`; // original margin is 8px
      el.style.paddingTop = `${progress * 14}px`; // original padding is 14px
      el.style.paddingBottom = `${progress * 14}px`; 
      el.style.borderWidth = `${progress}px`; 
      el.style.opacity = progress;
      
      const slide = (1 - progress) * -60; // 0 to -60%
      el.style.transform = `translateX(${slide}%) scale(${progress})`;
      
      const alpha = 0.8 * (1 - progress);
      el.style.background = `rgba(42, 156, 115, ${alpha})`;
      el.style.borderColor = `rgba(42, 156, 115, ${alpha})`;
      
    }, (el) => {
      el.remove();
    });
  }, 200);
}


// ══════════════════════════════════
//  Untick (from completed panel)
// ══════════════════════════════════

function handleUntick(li, id) {
  const task = tasks.find(t => t.id === id);
  if (task) {
    task.completed = false;
    task.completedAt = null;
    const activeTasks = tasks.filter(t => !t.completed);
    task.position = activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].position + 1000 : 1000;
    task._lastMutatedAt = Date.now();
    saveTasks(); // instant cache
    db.from('tasks').update({ completed: false, completedAt: null, position: task.position }).eq('id', task.id).then();
  }

  // Animate out of completed panel (driven by spring physics)
  li.style.pointerEvents = 'none';
  li.style.overflow = 'hidden';
  updateZebraStripes(DOM.completedList);
  
  const startHeight = li.offsetHeight;
  
  animateSpring(li, startHeight, 0, (y, el) => {
    const progress = y / startHeight;
    el.style.height = `${y}px`;
    el.style.marginBottom = `${progress * 8}px`;
    el.style.paddingTop = `${progress * 14}px`;
    el.style.paddingBottom = `${progress * 14}px`;
    el.style.borderWidth = `${progress}px`; 
    el.style.opacity = progress;
    
    const slide = (1 - progress) * 60; // 0 to 60%
    el.style.transform = `translateX(${slide}%) scale(${progress})`;
  }, (el) => {
    el.remove();
    renderCompletedTasks();

    // Add back to main list with animation
    const newEl = createTaskElement(task);
    newEl.classList.add('card--animate-in');
    DOM.taskList.appendChild(newEl);
    updateZebraStripes(DOM.taskList);
  });
}


// ══════════════════════════════════
//  Celebrations (Pure CSS — Zero JS per frame)
// ══════════════════════════════════

const CONFETTI_COLORS = ['#2a9c73','#34d399','#10b981','#059669','#6ee7b7','#a7f3d0'];
const PARTICLE_COUNT = 12;

function spawnConfetti(label, cb) {
  const r = cb.getBoundingClientRect();
  const ox = r.left + r.width / 2;
  const oy = r.top + r.height / 2;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'css-particle';

    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
    const dist = 60 + Math.random() * 100;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist + 30; // gravity bias
    const sz = 5 + Math.random() * 5;
    const rot = (Math.random() - 0.5) * 720;
    const dur = 0.5 + Math.random() * 0.3;

    el.style.cssText = `
      left:${ox}px;top:${oy}px;
      width:${sz}px;height:${sz * (0.4 + Math.random() * 0.6)}px;
      background:${CONFETTI_COLORS[Math.random() * CONFETTI_COLORS.length | 0]};
      border-radius:${Math.random() > 0.5 ? '50%' : '1px'};
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
  let newIdx = children.length;

  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c === drag.ph) continue;
    const cr = c.getBoundingClientRect();
    const s = spring(c);
    const mid = (cr.top - (s.y||0)) + cr.height / 2;
    if (dragY < mid) { newIdx = i; break; }
  }

  const phIdx = children.indexOf(drag.ph);
  if (newIdx !== phIdx) {
    const items = itemsInList();
    const before = captureRects(items);

    if (newIdx >= children.length) DOM.taskList.appendChild(drag.ph);
    else DOM.taskList.insertBefore(drag.ph, children[newIdx] === drag.ph ? children[newIdx+1] : children[newIdx]);

    flipAnimate(itemsInList(), before);
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
    window.scrollBy(0, -speed); 
    scrolled = true; 
  } else if (drag.clientY > bottomEdge) { 
    const speed = Math.max(5, (drag.clientY - bottomEdge) * 0.3);
    window.scrollBy(0, speed); 
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
    // Delete animation
    item.style.transform = 'scale(0) rotate(-15deg)';
    item.style.opacity = '0';
    
    // Collapse placeholder using spring
    const startHeight = ph.offsetHeight;
    animateSpring(ph, startHeight, 0, (y, el) => {
      const p = y / startHeight;
      el.style.height = `${y}px`;
      el.style.marginBottom = `${p * 8}px`;
      el.style.opacity = p;
    }, (el) => {
      el.remove();
      item.remove();
      const task = tasks.find(t => t.id === item.dataset.id);
      if (task) task._lastMutatedAt = Date.now();
      tasks = tasks.filter(t => t.id !== item.dataset.id);
      saveTasks(); // instant cache
      db.from('tasks').delete().eq('id', item.dataset.id).then();
      updateZebraStripes(DOM.taskList);
    });
    
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
    db.from('tasks').update({ position: newPos }).eq('id', droppedTask.id).then();
    updateZebraStripes(DOM.taskList);
    drag = null;
    
    if (pendingRemoteRender) {
      scheduleRender();
    }
  }

  item.addEventListener('transitionend', settle, { once: true });
  const fallback = setTimeout(settle, 300);
}


// Prevent scrolling while dragging
window.addEventListener('touchmove', (e) => {
  if (drag) {
    e.preventDefault();
  }
}, { passive: false });

// ── Init ──
