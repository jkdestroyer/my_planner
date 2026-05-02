// ===========================
// my planner - main app logic
// ===========================

// ----- 유틸 -----
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

const ymd = (d) => {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const todayStr = () => ymd(new Date());

const addDays = (dateStr, n) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

const KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const KO_MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

const COLORS = [
  '#1a1a17', '#c14a3a', '#d97757', '#c69447',
  '#7a8e5b', '#4a7c4e', '#3d7d8c', '#5b6e9e',
  '#8a6db1', '#a85a8c', '#6e6e6e'
];

// ----- 상태 -----
const STORAGE_KEY = 'my_planner_data_v1';

const defaultState = () => ({
  // 처음 실행 시 기본 카테고리/습관을 비워둔다.
  // 사용자가 설정에서 직접 만들도록 한다.
  categories: [],
  tasks: {},        // { 'YYYY-MM-DD': [ {id, text, categoryId, done, duration, repeatType, repeatId} ] }
  habits: [],       // [ {id, name, icon, color} ]
  habitLog: {},     // { 'YYYY-MM-DD': { habitId: true } }
  ddays: [],        // [ {id, name, date} ]
  memos: [],        // [ {id, text, createdAt, updatedAt} ]
  reflections: {},  // { 'YYYY-MM-DD': '...' }
  timetable: {},    // { 'YYYY-MM-DD': { '08:00': [taskId,...] } }
  pomodoro: {},     // { 'YYYY-MM-DD': { sessions: 0, totalMinutes: 0 } }
  settings: { theme: 'light', themeColor: '#2563eb', startHour: 6, endHour: 24 },
  repeats: []       // [ {id, type, text, categoryId, duration, startDate, weekday} ]
});

let state = loadState();
let currentView = 'today';
let selectedDate = todayStr();
let calendarMonth = (() => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() };
})();
let editingCategory = null;
let editingTask = null;
let editingHabit = null;
let editingDday = null;
let pendingTaskCategoryId = null;
let quickAddCategoryId = null;
let chosenColor = COLORS[0];
let chosenHabitColor = COLORS[4];
let contextTarget = null;
let statsPeriod = 'week';
let draggingTaskId = null;
let draggingPayload = null;

// 차트 인스턴스 캐시
const charts = {};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // 기본값과 머지 (마이그레이션)
    const def = defaultState();
    const migrated = { ...def, ...parsed, settings: { ...def.settings, ...(parsed.settings || {}) } };

    // 예전 버전에서 만든 habit에는 color가 없을 수 있으므로 보정
    migrated.habits = (migrated.habits || []).map((h, idx) => ({
      ...h,
      color: h.color || COLORS[idx % COLORS.length]
    }));

    return migrated;
  } catch (e) {
    console.error(e);
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const uid = () => Math.random().toString(36).slice(2, 10);

// ----- 토스트 -----
function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ----- 테마 -----
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme || 'light';
  const color = state.settings.themeColor || '#2563eb';
  document.documentElement.style.setProperty('--theme-color', color);
  document.documentElement.style.setProperty('--accent', color);
}
function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  saveState();
  applyTheme();
  // 차트 다시 그리기
  if (currentView === 'stats') renderStats();
}

// ----- 뷰 전환 -----
function switchView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'today') renderToday();
  if (name === 'calendar') renderCalendar();
  if (name === 'habits') renderHabitsPage();
  if (name === 'dday') renderDdays();
  if (name === 'memo') renderMemos();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
}

// ----- 반복 태스크 자동 생성 -----
function ensureRepeatsFor(date) {
  if (!state.repeats || state.repeats.length === 0) return;
  if (!state.tasks[date]) state.tasks[date] = [];
  const d = new Date(date);
  const weekday = d.getDay();

  state.repeats.forEach(r => {
    const start = new Date(r.startDate);
    if (d < start) return;

    let shouldGenerate = false;
    if (r.type === 'daily') shouldGenerate = true;
    else if (r.type === 'weekly') shouldGenerate = weekday === r.weekday;
    else if (r.type === 'weekdays') shouldGenerate = weekday >= 1 && weekday <= 5;

    if (!shouldGenerate) return;

    // 이미 그 날짜에 같은 repeatId 있는지 확인
    const exists = state.tasks[date].some(t => t.repeatId === r.id);
    if (exists) return;

    state.tasks[date].push({
      id: uid(),
      text: r.text,
      categoryId: r.categoryId,
      done: false,
      duration: r.duration,
      repeatId: r.id,
      createdAt: Date.now()
    });
  });
}

// ============================
// ===== 오늘 뷰 렌더 =====
// ============================
function renderToday() {
  ensureRepeatsFor(selectedDate);
  saveState();

  const d = new Date(selectedDate);
  const isToday = selectedDate === todayStr();
  $('#today-eyebrow').textContent = isToday ? 'today' : KO_WEEKDAYS[d.getDay()] + 'day';
  $('#today-title').textContent = `${KO_MONTHS[d.getMonth()]} ${d.getDate()}, ${KO_WEEKDAYS[d.getDay()]}요일`;

  renderCategories();
  renderHabitsInline();
  renderTimetable();
  renderProgress();

  // 회고
  $('#reflection-input').value = state.reflections[selectedDate] || '';
}

function renderCategories() {
  const container = $('#categories-container');
  container.innerHTML = '';

  const tasksOfDay = state.tasks[selectedDate] || [];

  if (state.categories.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card">
        <p class="task-empty-title">아직 카테고리가 없어요</p>
        <p class="task-empty">설정에서 일정, 과제, 공부처럼 원하는 카테고리를 먼저 만들어주세요.</p>
        <button class="add-btn" id="empty-add-category">+ 카테고리 만들기</button>
      </div>
    `;
    $('#empty-add-category')?.addEventListener('click', () => switchView('settings'));
    return;
  }

  state.categories.forEach(cat => {
    const tasks = tasksOfDay.filter(t => t.categoryId === cat.id);
    const block = document.createElement('div');
    block.className = 'category-block task-category-card';
    block.style.setProperty('--cat-color', cat.color);

    const completed = tasks.filter(t => t.done).length;
    const isAdding = quickAddCategoryId === cat.id;

    block.innerHTML = `
      <div class="category-row-head">
        <span class="category-color-bar"></span>
        <div class="category-title-wrap">
          <span class="category-pill-name">${escapeHtml(cat.name)}</span>
          <span class="category-pill-count">${completed}/${tasks.length}</span>
        </div>
        <button class="category-inline-add" data-add-task-cat="${cat.id}" title="${escapeHtml(cat.name)} 태스크 추가">+</button>
      </div>
      <div class="task-list" data-cat-id="${cat.id}"></div>
      <div class="quick-task-wrap" data-quick-wrap="${cat.id}"></div>
    `;

    const list = block.querySelector('.task-list');

    if (tasks.length === 0 && !isAdding) {
      const empty = document.createElement('p');
      empty.className = 'task-empty';
      empty.textContent = '아직 태스크가 없어요. +를 눌러 추가하세요.';
      list.appendChild(empty);
    } else {
      tasks.forEach(task => list.appendChild(renderTaskItem(task, cat)));
    }

    const quickWrap = block.querySelector('[data-quick-wrap]');
    if (isAdding) {
      quickWrap.innerHTML = `
        <div class="quick-task-composer">
          <input type="text" class="quick-task-text" placeholder="${escapeHtml(cat.name)} 태스크 입력" data-quick-text="${cat.id}">
          <input type="number" class="quick-task-duration" value="60" min="10" step="10" data-quick-duration="${cat.id}" title="소요 시간(분)">
          <button class="quick-task-save" data-quick-save="${cat.id}">추가</button>
          <button class="quick-task-cancel" data-quick-cancel="${cat.id}">취소</button>
        </div>
      `;
      setTimeout(() => block.querySelector('[data-quick-text]')?.focus(), 0);
    }

    block.querySelector('[data-add-task-cat]').addEventListener('click', () => {
      quickAddCategoryId = quickAddCategoryId === cat.id ? null : cat.id;
      renderCategories();
    });

    block.querySelector('[data-quick-save]')?.addEventListener('click', () => addQuickTask(cat.id));
    block.querySelector('[data-quick-cancel]')?.addEventListener('click', () => {
      quickAddCategoryId = null;
      renderCategories();
    });
    block.querySelector('[data-quick-text]')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addQuickTask(cat.id);
      if (e.key === 'Escape') {
        quickAddCategoryId = null;
        renderCategories();
      }
    });

    container.appendChild(block);
  });
}

function addQuickTask(categoryId) {
  const textEl = $(`[data-quick-text="${categoryId}"]`);
  const durationEl = $(`[data-quick-duration="${categoryId}"]`);
  const text = textEl?.value.trim();
  if (!text) return toast('태스크 내용을 입력해주세요');
  const duration = Math.max(10, parseInt(durationEl?.value, 10) || 60);
  if (!state.tasks[selectedDate]) state.tasks[selectedDate] = [];
  state.tasks[selectedDate].push({
    id: uid(),
    text,
    categoryId,
    duration,
    done: false,
    createdAt: Date.now()
  });
  saveState();
  quickAddCategoryId = categoryId;
  renderToday();
}

function renderTaskItem(task, cat) {
  const el = document.createElement('div');
  el.className = 'task-item' + (task.done ? ' completed' : '');
  el.draggable = true;
  el.dataset.taskId = task.id;
  el.style.borderLeftColor = cat.color;
  el.style.setProperty('--task-color', cat.color);

  el.innerHTML = `
    <div class="task-checkbox"></div>
    <span class="task-text">${escapeHtml(task.text)}</span>
    <span class="task-meta">${task.duration || 30}m</span>
  `;

  el.querySelector('.task-checkbox').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTaskDone(task.id);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, { type: 'task', taskId: task.id });
  });

  el.addEventListener('dblclick', () => openTaskModal(task));

  // Drag start
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'task-list', taskId: task.id }));
    e.dataTransfer.effectAllowed = 'copy';
    draggingTaskId = task.id;
    draggingPayload = { source: 'task-list', taskId: task.id };
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    draggingTaskId = null;
    draggingPayload = null;
  });

  return el;
}

function toggleTaskDone(taskId) {
  const tasks = state.tasks[selectedDate] || [];
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  t.done = !t.done;
  saveState();
  renderToday();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ===== 진행률 =====
function renderProgress() {
  const tasks = state.tasks[selectedDate] || [];
  const habits = state.habits;
  const habitLog = state.habitLog[selectedDate] || {};
  const habitDone = habits.filter(h => habitLog[h.id]).length;

  const totalItems = tasks.length + habits.length;
  const doneItems = tasks.filter(t => t.done).length + habitDone;
  const percent = totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);

  $('#progress-percent').textContent = percent;
  $('#progress-fill').style.width = percent + '%';

  let sub = '';
  if (totalItems === 0) sub = '태스크를 추가해보세요';
  else if (percent === 100) sub = '오늘도 완벽하게 해냈어요 ✶';
  else if (percent >= 70) sub = '잘하고 있어요, 거의 다 왔어요';
  else if (percent >= 40) sub = '꾸준히 진행 중';
  else sub = `${doneItems} / ${totalItems} 완료`;
  $('#progress-sub').textContent = sub;
}

// ===== 시간표 =====
const TIMETABLE_STEP_MIN = 10;
const TIMETABLE_COLS = 6;

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hhmmToMinutes(str) {
  const [h, m = '0'] = String(str).split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

function roundToStep(mins) {
  return Math.round(mins / TIMETABLE_STEP_MIN) * TIMETABLE_STEP_MIN;
}

function taskDurationMinutes(task) {
  return Math.max(TIMETABLE_STEP_MIN, roundToStep(parseInt(task?.duration, 10) || 30));
}

function getTimetableEntries(date = selectedDate) {
  if (!state.timetable[date]) state.timetable[date] = { entries: [] };

  const tt = state.timetable[date];
  if (Array.isArray(tt.entries)) {
    let changed = false;
    tt.entries.forEach(entry => {
      if (!entry.id) { entry.id = uid(); changed = true; }
      entry.start = roundToStep(parseInt(entry.start, 10) || 0);
      entry.duration = taskDurationMinutes({ duration: entry.duration });
    });
    if (changed) saveState();
    return tt.entries;
  }

  // 이전 버전: { '08:00': [taskId 또는 {taskId, duration}] } 형태를 새 entries 배열로 마이그레이션
  const migrated = [];
  Object.keys(tt).forEach(hour => {
    if (!/^\d{2}:\d{2}$/.test(hour)) return;
    (tt[hour] || []).forEach(raw => {
      const taskId = typeof raw === 'string' ? raw : raw?.taskId;
      if (!taskId) return;
      migrated.push({
        id: uid(),
        taskId,
        start: hhmmToMinutes(hour),
        duration: taskDurationMinutes(raw)
      });
    });
  });
  state.timetable[date] = { entries: migrated };
  saveState();
  return state.timetable[date].entries;
}

function getTaskById(taskId, date = selectedDate) {
  return (state.tasks[date] || []).find(t => t.id === taskId);
}

function getCategoryById(categoryId) {
  return state.categories.find(c => c.id === categoryId);
}

function hasTimetableConflict(taskId, startMinutes, duration, entries = getTimetableEntries(), ignoreEntryId = null) {
  const endMinutes = startMinutes + duration;
  return entries.some(entry => {
    if (ignoreEntryId && entry.id === ignoreEntryId) return false;
    const otherStart = entry.start;
    const otherEnd = entry.start + entry.duration;
    return startMinutes < otherEnd && endMinutes > otherStart;
  });
}

function clampTimetableStart(startMinutes, duration) {
  const startH = state.settings.startHour ?? 6;
  const endH = state.settings.endHour ?? 24;
  const minStart = startH * 60;
  const maxStart = endH * 60 - duration;
  return Math.max(minStart, Math.min(maxStart, roundToStep(startMinutes)));
}

function entryAtMinute(minute, entries = getTimetableEntries()) {
  return entries.find(entry => minute >= entry.start && minute < entry.start + entry.duration);
}

function minutesCovered(start, duration) {
  const arr = [];
  for (let m = start; m < start + duration; m += TIMETABLE_STEP_MIN) arr.push(m);
  return arr;
}

function clearTimetablePreview(board) {
  $$('.time-10-cell.preview-fill, .time-10-cell.preview-conflict', board).forEach(cell => {
    cell.classList.remove('preview-fill', 'preview-conflict', 'preview-start', 'preview-end');
    cell.style.removeProperty('--preview-color');
    cell.querySelector('.preview-label')?.remove();
  });
}

function getDragPayload(e) {
  let data = null;
  try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch {}
  if (data?.taskId) return data;
  return draggingPayload || (draggingTaskId ? { source: 'task-list', taskId: draggingTaskId } : null);
}

function previewTimetablePlacement(board, startMinutes, payload) {
  clearTimetablePreview(board);
  const data = typeof payload === 'string' ? { source: 'task-list', taskId: payload } : payload;
  const task = getTaskById(data?.taskId);
  if (!task) return null;

  const duration = taskDurationMinutes(task);
  const safeStart = clampTimetableStart(startMinutes, duration);
  const conflict = hasTimetableConflict(task.id, safeStart, duration, getTimetableEntries(), data?.entryId || null);
  const cat = getCategoryById(task.categoryId);
  const color = cat?.color || '#2563eb';
  const cells = minutesCovered(safeStart, duration)
    .map(min => $(`.time-10-cell[data-start="${min}"]`, board))
    .filter(Boolean);

  cells.forEach((cell, idx) => {
    cell.classList.add(conflict ? 'preview-conflict' : 'preview-fill');
    if (idx === 0) cell.classList.add('preview-start');
    if (idx === cells.length - 1) cell.classList.add('preview-end');
    cell.style.setProperty('--preview-color', color);
  });

  if (cells[0]) {
    const label = document.createElement('span');
    label.className = 'preview-label';
    label.textContent = `${task.text} · ${minutesToHHMM(safeStart)}–${minutesToHHMM(safeStart + duration)}`;
    cells[0].appendChild(label);
  }

  return { task, start: safeStart, duration, conflict, entryId: data?.entryId || null, source: data?.source || 'task-list' };
}

function renderTimetable() {
  const container = $('#timetable');
  container.innerHTML = '';

  const startH = state.settings.startHour ?? 6;
  const endH = state.settings.endHour ?? 24;
  const entries = getTimetableEntries(selectedDate);

  const board = document.createElement('div');
  board.className = 'timetable-board-10min';

  for (let h = startH; h < endH; h++) {
    const row = document.createElement('div');
    row.className = 'time-slot-row-10min';

    const label = document.createElement('div');
    label.className = 'time-label-10min';
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    row.appendChild(label);

    const cellsWrap = document.createElement('div');
    cellsWrap.className = 'time-cells-10min';

    for (let i = 0; i < TIMETABLE_COLS; i++) {
      const minute = h * 60 + i * TIMETABLE_STEP_MIN;
      const cell = document.createElement('div');
      cell.className = 'time-10-cell';
      cell.dataset.start = String(minute);
      cell.title = minutesToHHMM(minute);

      const entry = entryAtMinute(minute, entries);
      if (entry) {
        const task = getTaskById(entry.taskId);
        const cat = task ? getCategoryById(task.categoryId) : null;
        const color = cat?.color || '#2563eb';
        cell.classList.add('scheduled-cell');
        cell.style.setProperty('--cell-color', color);
        if (minute === entry.start) {
          cell.classList.add('range-start');
          cell.draggable = true;
          cell.dataset.taskId = entry.taskId;
          cell.innerHTML = `
            <span class="cell-task-title">${escapeHtml(task?.text || '태스크')}</span>
            <span class="cell-task-time">${minutesToHHMM(entry.start)}–${minutesToHHMM(entry.start + entry.duration)}</span>
            <button class="cell-remove" title="시간표에서 제거">×</button>
          `;
          cell.querySelector('.cell-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeFromTimetable(entry.id);
          });
          cell.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'timetable', taskId: entry.taskId, entryId: entry.id }));
            e.dataTransfer.effectAllowed = 'move';
            draggingTaskId = entry.taskId;
            draggingPayload = { source: 'timetable', taskId: entry.taskId, entryId: entry.id };
            cell.classList.add('dragging');
          });
          cell.addEventListener('dragend', () => {
            cell.classList.remove('dragging');
            draggingTaskId = null;
            draggingPayload = null;
          });
        }
        if (minute + TIMETABLE_STEP_MIN >= entry.start + entry.duration) {
          cell.classList.add('range-end');
        }
      }

      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        const payload = getDragPayload(e);
        if (!payload?.taskId) return;
        board.classList.add('drag-over');
        previewTimetablePlacement(board, minute, payload);
      });

      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        const payload = getDragPayload(e);
        const info = payload?.taskId ? previewTimetablePlacement(board, minute, payload) : null;
        clearTimetablePreview(board);
        board.classList.remove('drag-over');
        draggingTaskId = null;
        draggingPayload = null;
        if (!info) return;
        if (info.conflict) return toast('이미 겹치는 태스크가 있어요');
        addToTimetable(info.start, info.task.id, { entryId: info.entryId, source: info.source });
      });

      cellsWrap.appendChild(cell);
    }

    row.appendChild(cellsWrap);
    board.appendChild(row);
  }

  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) {
      clearTimetablePreview(board);
      board.classList.remove('drag-over');
    }
  });

  container.appendChild(board);
}

function addToTimetable(startMinutes, taskId, options = {}) {
  const task = getTaskById(taskId);
  if (!task) return;
  const duration = taskDurationMinutes(task);
  const entries = getTimetableEntries(selectedDate);
  const safeStart = clampTimetableStart(startMinutes, duration);
  const movingEntryId = options.entryId || null;

  if (hasTimetableConflict(taskId, safeStart, duration, entries, movingEntryId)) {
    toast('이미 겹치는 태스크가 있어요');
    return;
  }

  if (movingEntryId) {
    const existing = entries.find(entry => entry.id === movingEntryId);
    if (existing) {
      existing.taskId = taskId;
      existing.start = safeStart;
      existing.duration = duration;
    } else {
      entries.push({ id: uid(), taskId, start: safeStart, duration });
    }
  } else {
    // 태스크 목록에서 드래그한 경우에는 기존 시간표 항목을 대체하지 않고 새 배치로 추가한다.
    entries.push({ id: uid(), taskId, start: safeStart, duration });
  }

  entries.sort((a, b) => a.start - b.start);
  saveState();
  renderTimetable();
  if (currentView === 'stats') renderStats();
}

function removeFromTimetable(entryIdOrTaskId) {
  const entries = getTimetableEntries(selectedDate);
  const idx = entries.findIndex(entry => entry.id === entryIdOrTaskId || entry.taskId === entryIdOrTaskId);
  if (idx === -1) return;
  entries.splice(idx, 1);
  saveState();
  renderTimetable();
}

function moveInTimetable(fromHour, toHour, taskId) {
  // 이전 함수명을 유지하기 위한 호환용 래퍼. 새 구조에서는 drop 위치가 startMinutes를 직접 결정한다.
  addToTimetable(typeof toHour === 'number' ? toHour : hhmmToMinutes(toHour), taskId);
}

// ===== 인라인 습관 =====
function renderHabitsInline() {
  const container = $('#habits-inline-container');
  container.innerHTML = '';

  if (state.habits.length === 0) {
    container.innerHTML = '<p class="task-empty">습관 탭에서 추가하세요</p>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'habits-inline-list';

  const log = state.habitLog[selectedDate] || {};

  state.habits.forEach(h => {
    const chip = document.createElement('button');
    const color = h.color || COLORS[0];
    chip.className = 'habit-chip' + (log[h.id] ? ' done' : '');
    chip.style.setProperty('--habit-color', color);
    chip.innerHTML = `<span>${escapeHtml(h.name)}</span>`;
    chip.addEventListener('click', () => toggleHabit(h.id));
    list.appendChild(chip);
  });

  container.appendChild(list);
}

function toggleHabit(habitId) {
  if (!state.habitLog[selectedDate]) state.habitLog[selectedDate] = {};
  state.habitLog[selectedDate][habitId] = !state.habitLog[selectedDate][habitId];
  saveState();
  renderHabitsInline();
  renderProgress();
}

// ============================
// ===== 캘린더 뷰 =====
// ============================
function renderCalendar() {
  const { year, month } = calendarMonth;
  $('#calendar-title').textContent = `${year}, ${KO_MONTHS[month]}`;

  const grid = $('#calendar-grid');
  grid.innerHTML = '';

  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells = [];

  // prev month tail
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ day: daysInPrev - i, otherMonth: true, date: new Date(year, month - 1, daysInPrev - i) });
  }
  // current
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, otherMonth: false, date: new Date(year, month, d) });
  }
  // next
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last);
    next.setDate(next.getDate() + 1);
    cells.push({ day: next.getDate(), otherMonth: next.getMonth() !== month, date: next });
    if (cells.length >= 42) break;
  }

  const todayDate = todayStr();

  cells.forEach(cell => {
    const dateStr = ymd(cell.date);
    const div = document.createElement('div');
    div.className = 'cal-day';
    if (cell.otherMonth) div.classList.add('other-month');
    if (dateStr === todayDate) div.classList.add('today');

    const tasks = state.tasks[dateStr] || [];
    const completed = tasks.filter(t => t.done).length;
    const pct = tasks.length === 0 ? null : Math.round((completed / tasks.length) * 100);

    div.innerHTML = `<span class="cal-num">${cell.day}</span>`;

    if (tasks.length > 0) {
      const marks = document.createElement('div');
      marks.className = 'cal-marks';
      tasks.slice(0, 3).forEach(t => {
        const cat = state.categories.find(c => c.id === t.categoryId);
        const m = document.createElement('div');
        m.className = 'cal-mark';
        m.style.borderLeftColor = cat?.color || '#888';
        m.textContent = (t.done ? '✓ ' : '') + t.text;
        if (t.done) m.style.opacity = '0.5';
        marks.appendChild(m);
      });
      if (tasks.length > 3) {
        const more = document.createElement('div');
        more.className = 'cal-mark';
        more.style.borderLeftColor = 'transparent';
        more.textContent = `+${tasks.length - 3}`;
        marks.appendChild(more);
      }
      div.appendChild(marks);
    }

    if (pct !== null) {
      const p = document.createElement('div');
      p.className = 'cal-progress';
      p.textContent = pct + '%';
      div.appendChild(p);
    }

    div.addEventListener('click', () => {
      selectedDate = dateStr;
      switchView('today');
    });

    grid.appendChild(div);
  });
}

// ============================
// ===== 습관 페이지 =====
// ============================
function renderHabitsPage() {
  const container = $('#habits-page');
  container.innerHTML = '';

  if (state.habits.length === 0) {
    container.innerHTML = '<p class="task-empty">우상단의 + 새 습관 버튼으로 시작하세요</p>';
    return;
  }

  state.habits.forEach(habit => {
    const card = document.createElement('div');
    card.className = 'habit-card';
    const habitColor = habit.color || COLORS[0];
    card.style.setProperty('--habit-color', habitColor);

    // 최근 30일
    const days = [];
    for (let i = 29; i >= 0; i--) {
      days.push(addDays(todayStr(), -i));
    }

    const doneCount = days.filter(d => state.habitLog[d]?.[habit.id]).length;
    const streak = calculateStreak(habit.id);

    card.innerHTML = `
      <div class="habit-card-head">
        <span class="habit-color-dot" style="background:${habitColor}"></span>
        <h3>${escapeHtml(habit.name)}</h3>
        <span class="habit-streak">streak ${streak}일 · 30일 중 ${doneCount}일</span>
      </div>
      <div class="habit-grid-30"></div>
      <div class="habit-card-actions">
        <button class="ghost-btn" data-edit-habit="${habit.id}">수정</button>
        <button class="ghost-btn danger" data-del-habit="${habit.id}">삭제</button>
      </div>
    `;

    const grid = card.querySelector('.habit-grid-30');
    days.forEach(date => {
      const cell = document.createElement('div');
      cell.className = 'habit-cell';
      const isDone = state.habitLog[date]?.[habit.id];
      if (isDone) cell.classList.add('done');
      if (date === todayStr()) cell.classList.add('today');
      cell.title = date;
      cell.addEventListener('click', () => {
        if (!state.habitLog[date]) state.habitLog[date] = {};
        state.habitLog[date][habit.id] = !state.habitLog[date][habit.id];
        saveState();
        renderHabitsPage();
      });
      grid.appendChild(cell);
    });

    container.appendChild(card);
  });

  $$('[data-edit-habit]').forEach(b => b.addEventListener('click', () => {
    const h = state.habits.find(x => x.id === b.dataset.editHabit);
    if (h) openHabitModal(h);
  }));
  $$('[data-del-habit]').forEach(b => b.addEventListener('click', () => {
    if (confirm('이 습관을 삭제할까요? 기록은 함께 사라집니다.')) {
      state.habits = state.habits.filter(h => h.id !== b.dataset.delHabit);
      Object.keys(state.habitLog).forEach(d => {
        if (state.habitLog[d][b.dataset.delHabit]) delete state.habitLog[d][b.dataset.delHabit];
      });
      saveState();
      renderHabitsPage();
    }
  }));
}

function calculateStreak(habitId) {
  let streak = 0;
  let cursor = todayStr();
  // 오늘 안 했으면 어제부터 카운트
  if (!state.habitLog[cursor]?.[habitId]) cursor = addDays(cursor, -1);
  while (state.habitLog[cursor]?.[habitId]) {
    streak++;
    cursor = addDays(cursor, -1);
    if (streak > 999) break;
  }
  return streak;
}

// ============================
// ===== 디데이 =====
// ============================
function renderDdays() {
  const container = $('#dday-grid');
  container.innerHTML = '';

  if (state.ddays.length === 0) {
    container.innerHTML = '<p class="task-empty">우상단 + 새 디데이 버튼으로 시작하세요</p>';
    return;
  }

  // 가까운 미래 우선 정렬
  const sorted = [...state.ddays].sort((a, b) => {
    const da = daysUntil(a.date);
    const db = daysUntil(b.date);
    // 미래 가까운 순, 그 다음 과거 가까운 순
    if (da >= 0 && db >= 0) return da - db;
    if (da < 0 && db < 0) return db - da;
    return da < 0 ? 1 : -1;
  });

  sorted.forEach(d => {
    const diff = daysUntil(d.date);
    const card = document.createElement('div');
    card.className = 'dday-card';

    let label;
    if (diff === 0) label = 'D-day';
    else if (diff > 0) label = `D-${diff}`;
    else label = `D+${Math.abs(diff)}`;

    card.innerHTML = `
      <button class="delete-x" data-del-dday="${d.id}">×</button>
      <p class="dday-name">${escapeHtml(d.name)}</p>
      <p class="dday-count">${label}</p>
      <p class="dday-date">${d.date}</p>
    `;

    container.appendChild(card);
  });

  $$('[data-del-dday]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    state.ddays = state.ddays.filter(x => x.id !== b.dataset.delDday);
    saveState();
    renderDdays();
  }));
}

function daysUntil(dateStr) {
  const today = new Date(todayStr());
  const target = new Date(dateStr);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// ============================
// ===== 메모 =====
// ============================
function renderMemos() {
  const container = $('#memo-grid');
  container.innerHTML = '';

  if (state.memos.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'task-empty';
    empty.textContent = '+ 새 메모 버튼으로 시작하세요';
    container.appendChild(empty);
    return;
  }

  // 최근 수정 순
  const sorted = [...state.memos].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  sorted.forEach(memo => {
    const card = document.createElement('div');
    card.className = 'memo-card';
    const updated = new Date(memo.updatedAt || memo.createdAt);
    card.innerHTML = `
      <button class="delete-x" data-del-memo="${memo.id}">×</button>
      <textarea data-memo-id="${memo.id}" placeholder="메모를 입력하세요...">${escapeHtml(memo.text)}</textarea>
      <div class="memo-meta">
        <span></span>
        <span>${updated.getMonth() + 1}/${updated.getDate()} ${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}</span>
      </div>
    `;
    container.appendChild(card);
  });

  $$('textarea[data-memo-id]').forEach(ta => {
    let timer;
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const memo = state.memos.find(m => m.id === ta.dataset.memoId);
        if (memo) {
          memo.text = ta.value;
          memo.updatedAt = Date.now();
          saveState();
        }
      }, 400);
    });
  });

  $$('[data-del-memo]').forEach(b => b.addEventListener('click', () => {
    if (confirm('메모를 삭제할까요?')) {
      state.memos = state.memos.filter(m => m.id !== b.dataset.delMemo);
      saveState();
      renderMemos();
    }
  }));
}

// ============================
// ===== 통계 =====
// ============================
function renderStats() {
  const days = statsPeriod === 'week' ? 7 : 30;
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addDays(todayStr(), -i));

  const isDark = state.settings.theme === 'dark';
  const ink = isDark ? '#f0eee6' : '#1a1a17';
  const grid = isDark ? '#2c2c28' : '#e8e6df';
  const muted = isDark ? '#6a6862' : '#8a877e';

  Chart.defaults.color = muted;
  Chart.defaults.borderColor = grid;
  Chart.defaults.font.family = 'Pretendard, system-ui, sans-serif';

  // 1) 완료율
  const completionData = dates.map(d => {
    const tasks = state.tasks[d] || [];
    if (tasks.length === 0) return 0;
    return Math.round((tasks.filter(t => t.done).length / tasks.length) * 100);
  });

  destroyChart('completion');
  charts.completion = new Chart($('#chart-completion'), {
    type: 'line',
    data: {
      labels: dates.map(d => {
        const dt = new Date(d);
        return `${dt.getMonth() + 1}/${dt.getDate()}`;
      }),
      datasets: [{
        data: completionData,
        borderColor: ink,
        backgroundColor: ink + '15',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: ink,
        borderWidth: 2
      }]
    },
    options: chartOpts(grid, muted, '%')
  });

  // 2) 카테고리별 시간 (시간표 기준)
  const catMinutes = {};
  state.categories.forEach(c => catMinutes[c.id] = 0);
  dates.forEach(d => {
    const entries = getTimetableEntries(d);
    const tasks = state.tasks[d] || [];
    entries.forEach(entry => {
      const t = tasks.find(x => x.id === entry.taskId);
      if (t && catMinutes[t.categoryId] !== undefined) {
        catMinutes[t.categoryId] += taskDurationMinutes({ duration: entry.duration || t.duration });
      }
    });
  });

  const catLabels = state.categories.map(c => c.name);
  const catValues = state.categories.map(c => Math.round(catMinutes[c.id] / 60 * 10) / 10);
  const catColors = state.categories.map(c => c.color);

  destroyChart('category');
  charts.category = new Chart($('#chart-category'), {
    type: 'doughnut',
    data: {
      labels: catLabels,
      datasets: [{ data: catValues, backgroundColor: catColors, borderColor: isDark ? '#1c1c19' : '#ffffff', borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}h` } }
      },
      cutout: '65%'
    }
  });

  // 3) 습관 달성률
  const habitData = state.habits.map(h => {
    const done = dates.filter(d => state.habitLog[d]?.[h.id]).length;
    return Math.round((done / days) * 100);
  });

  destroyChart('habits');
  charts.habits = new Chart($('#chart-habits'), {
    type: 'bar',
    data: {
      labels: state.habits.map(h => h.name),
      datasets: [{
        data: habitData,
        backgroundColor: ink,
        borderRadius: 4,
        barThickness: 22
      }]
    },
    options: {
      ...chartOpts(grid, muted, '%'),
      indexAxis: 'y'
    }
  });

  // 4) Summary
  const totalTasks = dates.reduce((s, d) => s + (state.tasks[d]?.length || 0), 0);
  const doneTasks = dates.reduce((s, d) => s + (state.tasks[d]?.filter(t => t.done).length || 0), 0);
  const avgCompletion = completionData.length ? Math.round(completionData.reduce((a, b) => a + b, 0) / completionData.length) : 0;
  const totalPomo = dates.reduce((s, d) => s + (state.pomodoro[d]?.totalMinutes || 0), 0);

  $('#stats-summary').innerHTML = `
    <div><span>총 태스크</span><span>${totalTasks}</span></div>
    <div><span>완료한 태스크</span><span>${doneTasks}</span></div>
    <div><span>평균 완료율</span><span>${avgCompletion}%</span></div>
    <div><span>포모도로 시간</span><span>${Math.round(totalPomo / 60 * 10) / 10}h</span></div>
    <div><span>측정 기간</span><span>${days}일</span></div>
  `;
}

function chartOpts(grid, muted, suffix = '') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.parsed.y ?? c.parsed.x ?? c.parsed}${suffix}` } }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { grid: { color: grid, drawBorder: false }, ticks: { font: { size: 10 }, callback: v => v + suffix }, beginAtZero: true, max: suffix === '%' ? 100 : undefined }
    }
  };
}

function destroyChart(name) {
  if (charts[name]) { charts[name].destroy(); charts[name] = null; }
}

// ============================
// ===== 설정 =====
// ============================
function renderSettings() {
  const themeInput = $('#theme-color-input');
  const themePreview = $('#theme-color-preview');
  if (themeInput) {
    themeInput.value = state.settings.themeColor || '#2563eb';
    themeInput.oninput = () => {
      state.settings.themeColor = themeInput.value;
      saveState();
      applyTheme();
      if (themePreview) themePreview.style.background = themeInput.value;
      if (currentView === 'stats') renderStats();
    };
  }
  if (themePreview) themePreview.style.background = state.settings.themeColor || '#2563eb';

  const container = $('#settings-categories');
  container.innerHTML = '';
  state.categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <span class="category-dot" style="background:${cat.color}"></span>
      <span>${escapeHtml(cat.name)}</span>
      <button data-edit-cat="${cat.id}">수정</button>
      <button class="danger" data-del-cat="${cat.id}">삭제</button>
    `;
    container.appendChild(row);
  });

  $$('[data-edit-cat]').forEach(b => b.addEventListener('click', () => {
    const c = state.categories.find(x => x.id === b.dataset.editCat);
    if (c) openCategoryModal(c);
  }));
  $$('[data-del-cat]').forEach(b => b.addEventListener('click', () => {
    if (state.categories.length <= 1) return toast('최소 1개의 카테고리는 필요해요');
    if (confirm('이 카테고리를 삭제할까요? 해당 카테고리의 태스크들도 함께 사라집니다.')) {
      state.categories = state.categories.filter(c => c.id !== b.dataset.delCat);
      Object.keys(state.tasks).forEach(d => {
        state.tasks[d] = state.tasks[d].filter(t => t.categoryId !== b.dataset.delCat);
      });
      saveState();
      renderSettings();
    }
  }));
}

// ============================
// ===== 모달들 =====
// ============================
function showModal(id) {
  $('#modal-backdrop').classList.add('show');
  $(`#${id}`).classList.add('show');
}
function hideModals() {
  $('#modal-backdrop').classList.remove('show');
  $$('.modal').forEach(m => m.classList.remove('show'));
  editingCategory = editingTask = editingHabit = editingDday = null;
}

// 태스크 모달
function openTaskModal(task = null, preferredCategoryId = null) {
  pendingTaskCategoryId = preferredCategoryId;
  if (!task && state.categories.length === 0) {
    toast('먼저 설정에서 카테고리를 만들어주세요');
    switchView('settings');
    return;
  }
  editingTask = task;
  $('#task-modal-title').textContent = task ? '태스크 수정' : '새 태스크';
  $('#task-text').value = task?.text || '';
  $('#task-duration').value = task?.duration || 30;

  const sel = $('#task-category');
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (task) sel.value = task.categoryId;
  else if (pendingTaskCategoryId) sel.value = pendingTaskCategoryId;

  $('#task-repeat-enable').checked = false;
  $('#task-repeat-options').style.display = 'none';
  $('#task-repeat-type').value = 'daily';

  showModal('task-modal');
  setTimeout(() => $('#task-text').focus(), 50);
}

$('#task-repeat-enable').addEventListener('change', (e) => {
  $('#task-repeat-options').style.display = e.target.checked ? 'block' : 'none';
});

$('#task-save').addEventListener('click', () => {
  const text = $('#task-text').value.trim();
  if (!text) return toast('내용을 입력해주세요');
  const categoryId = $('#task-category').value;
  if (!categoryId) return toast('카테고리를 먼저 선택하거나 만들어주세요');
  const duration = parseInt($('#task-duration').value) || 30;

  if (editingTask) {
    editingTask.text = text;
    editingTask.categoryId = categoryId;
    editingTask.duration = duration;
  } else {
    if (!state.tasks[selectedDate]) state.tasks[selectedDate] = [];
    const newTask = {
      id: uid(),
      text, categoryId, duration,
      done: false,
      createdAt: Date.now()
    };

    // 반복 설정
    if ($('#task-repeat-enable').checked) {
      const type = $('#task-repeat-type').value;
      const repeat = {
        id: uid(),
        type,
        text, categoryId, duration,
        startDate: selectedDate,
        weekday: new Date(selectedDate).getDay()
      };
      state.repeats.push(repeat);
      newTask.repeatId = repeat.id;
    }

    state.tasks[selectedDate].push(newTask);
  }
  saveState();
  hideModals();
  pendingTaskCategoryId = null;
  renderToday();
});

// 카테고리 모달
function openCategoryModal(cat = null) {
  editingCategory = cat;
  $('#category-modal-title').textContent = cat ? '카테고리 수정' : '새 카테고리';
  $('#category-name').value = cat?.name || '';
  chosenColor = cat?.color || COLORS[0];

  const customColor = $('#category-custom-color');
  if (customColor) customColor.value = chosenColor;

  const picker = $('#color-picker');
  picker.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === chosenColor ? ' selected' : '');
    sw.style.background = c;
    sw.addEventListener('click', () => {
      chosenColor = c;
      if (customColor) customColor.value = c;
      $$('.color-swatch', picker).forEach(x => x.classList.toggle('selected', hexEq(x.style.background, c)));
    });
    picker.appendChild(sw);
  });

  if (customColor) {
    customColor.oninput = () => {
      chosenColor = customColor.value;
      $$('.color-swatch', picker).forEach(x => x.classList.toggle('selected', hexEq(x.style.background, chosenColor)));
    };
  }

  showModal('category-modal');
  setTimeout(() => $('#category-name').focus(), 50);
}

function hexEq(a, b) {
  // 브라우저가 hex를 rgb로 바꿔놓을 수 있어서 단순 비교 우회
  const c = document.createElement('div');
  c.style.color = b;
  document.body.appendChild(c);
  const rgb = getComputedStyle(c).color;
  c.remove();
  const c2 = document.createElement('div');
  c2.style.color = a;
  document.body.appendChild(c2);
  const rgb2 = getComputedStyle(c2).color;
  c2.remove();
  return rgb === rgb2;
}

$('#category-save').addEventListener('click', () => {
  const name = $('#category-name').value.trim();
  if (!name) return toast('이름을 입력해주세요');
  if (editingCategory) {
    editingCategory.name = name;
    editingCategory.color = chosenColor;
  } else {
    state.categories.push({ id: uid(), name, color: chosenColor });
  }
  saveState();
  hideModals();
  renderSettings();
  if (currentView === 'today') renderToday();
});

// 습관 모달
function openHabitModal(habit = null) {
  editingHabit = habit;
  $('#habit-modal-title').textContent = habit ? '습관 수정' : '새 습관';
  $('#habit-name').value = habit?.name || '';
  chosenHabitColor = habit?.color || COLORS[4];

  const customColor = $('#habit-custom-color');
  if (customColor) customColor.value = chosenHabitColor;

  const picker = $('#habit-color-picker');
  if (picker) {
    picker.innerHTML = '';
    COLORS.forEach(c => {
      const sw = document.createElement('div');
      sw.className = 'color-swatch' + (hexEq(c, chosenHabitColor) ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        chosenHabitColor = c;
        if (customColor) customColor.value = c;
        $$('.color-swatch', picker).forEach(x => x.classList.toggle('selected', hexEq(x.style.background, c)));
      });
      picker.appendChild(sw);
    });
  }

  if (customColor) {
    customColor.oninput = () => {
      chosenHabitColor = customColor.value;
      if (picker) $$('.color-swatch', picker).forEach(x => x.classList.toggle('selected', hexEq(x.style.background, chosenHabitColor)));
    };
  }

  showModal('habit-modal');
  setTimeout(() => $('#habit-name').focus(), 50);
}

$('#habit-save').addEventListener('click', () => {
  const name = $('#habit-name').value.trim();
  if (!name) return toast('이름을 입력해주세요');
  const color = $('#habit-custom-color')?.value || chosenHabitColor || COLORS[4];
  if (editingHabit) {
    editingHabit.name = name;
    editingHabit.color = color;
  } else {
    state.habits.push({ id: uid(), name, color });
  }
  saveState();
  hideModals();
  if (currentView === 'habits') renderHabitsPage();
  if (currentView === 'today') renderHabitsInline();
});

// 디데이 모달
function openDdayModal(dday = null) {
  editingDday = dday;
  $('#dday-modal-title').textContent = dday ? '디데이 수정' : '새 디데이';
  $('#dday-name').value = dday?.name || '';
  $('#dday-date').value = dday?.date || todayStr();
  showModal('dday-modal');
  setTimeout(() => $('#dday-name').focus(), 50);
}

$('#dday-save').addEventListener('click', () => {
  const name = $('#dday-name').value.trim();
  const date = $('#dday-date').value;
  if (!name || !date) return toast('이름과 날짜를 입력해주세요');
  if (editingDday) {
    editingDday.name = name;
    editingDday.date = date;
  } else {
    state.ddays.push({ id: uid(), name, date });
  }
  saveState();
  hideModals();
  renderDdays();
});

// ============================
// ===== 컨텍스트 메뉴 =====
// ============================
function showContextMenu(x, y, target) {
   contextTarget = target;
  const menu = $('#context-menu');

  menu.classList.add('show');

  const offset = 8;
  const menuRect = menu.getBoundingClientRect();

  let left = x + offset;
  let top = y + offset;

  // 화면 오른쪽/아래로 튀어나가지 않게 보정
  if (left + menuRect.width > window.innerWidth) {
    left = x - menuRect.width - offset;
  }

  if (top + menuRect.height > window.innerHeight) {
    top = y - menuRect.height - offset;
  }

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function hideContextMenu() {
  $('#context-menu').classList.remove('show');
  contextTarget = null;
}

document.addEventListener('click', hideContextMenu);

$$('#context-menu button').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!contextTarget) return;
    const action = btn.dataset.action;
    const taskId = contextTarget.taskId;
    const tasks = state.tasks[selectedDate] || [];
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return hideContextMenu();
    const task = tasks[idx];

    if (action === 'complete') {
      task.done = !task.done;
    } else if (action === 'tomorrow') {
      moveTaskToDate(task, selectedDate, addDays(selectedDate, 1));
    } else if (action === 'movedate') {
      const target = prompt('옮길 날짜를 입력하세요 (YYYY-MM-DD)', addDays(selectedDate, 1));
      if (target && /^\d{4}-\d{2}-\d{2}$/.test(target)) {
        moveTaskToDate(task, selectedDate, target);
      }
    } else if (action === 'edit') {
      openTaskModal(task);
    } else if (action === 'delete') {
      tasks.splice(idx, 1);
      // 시간표에서도 제거
      const entries = getTimetableEntries(selectedDate);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].taskId === taskId) entries.splice(i, 1);
      }
    }
    saveState();
    renderToday();
    hideContextMenu();
  });
});

function moveTaskToDate(task, fromDate, toDate) {
  const fromList = state.tasks[fromDate];
  if (!fromList) return;
  const idx = fromList.findIndex(t => t.id === task.id);
  if (idx === -1) return;
  fromList.splice(idx, 1);

  if (!state.tasks[toDate]) state.tasks[toDate] = [];
  state.tasks[toDate].push(task);

  // 시간표에서 제거
  const fromEntries = getTimetableEntries(fromDate);
  for (let i = fromEntries.length - 1; i >= 0; i--) {
    if (fromEntries[i].taskId === task.id) fromEntries.splice(i, 1);
  }
  toast(`${toDate}로 옮겼어요`);
}

// ============================
// ===== 포모도로 =====
// ============================
const pomo = {
  running: false,
  mode: 'focus',  // 'focus' | 'break'
  remaining: 25 * 60,
  interval: null,
  focusMin: 25,
  breakMin: 5
};

function pomoTick() {
  if (!pomo.running) return;
  pomo.remaining--;
  updatePomoDisplay();
  if (pomo.remaining <= 0) {
    if (pomo.mode === 'focus') {
      // 집중 끝
      const today = todayStr();
      if (!state.pomodoro[today]) state.pomodoro[today] = { sessions: 0, totalMinutes: 0 };
      state.pomodoro[today].sessions++;
      state.pomodoro[today].totalMinutes += pomo.focusMin;
      saveState();
      pomo.mode = 'break';
      pomo.remaining = pomo.breakMin * 60;
      notify('집중 완료!', '잠시 쉬어요');
    } else {
      pomo.mode = 'focus';
      pomo.remaining = pomo.focusMin * 60;
      notify('휴식 끝', '다시 시작해볼까요');
    }
    updatePomoDisplay();
    updatePomoStats();
  }
}

function updatePomoDisplay() {
  const m = Math.floor(pomo.remaining / 60);
  const s = pomo.remaining % 60;
  $('#pomo-display').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  $('#pomo-mode').textContent = pomo.mode === 'focus' ? '집중 시간' : '휴식 시간';
  $('#pomo-start').textContent = pomo.running ? '일시정지' : '시작';
}

function updatePomoStats() {
  const today = todayStr();
  const data = state.pomodoro[today] || { sessions: 0, totalMinutes: 0 };
  $('#pomo-count').textContent = data.sessions;
  $('#pomo-total').textContent = data.totalMinutes;
}

function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
  toast(`${title} · ${body}`);
}

$('#pomo-start').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  pomo.running = !pomo.running;
  if (pomo.running) {
    pomo.interval = setInterval(pomoTick, 1000);
  } else {
    clearInterval(pomo.interval);
  }
  updatePomoDisplay();
});

$('#pomo-reset').addEventListener('click', () => {
  pomo.running = false;
  clearInterval(pomo.interval);
  pomo.mode = 'focus';
  pomo.focusMin = parseInt($('#pomo-focus').value) || 25;
  pomo.breakMin = parseInt($('#pomo-break').value) || 5;
  pomo.remaining = pomo.focusMin * 60;
  updatePomoDisplay();
});

$('#pomo-focus').addEventListener('change', () => {
  if (!pomo.running && pomo.mode === 'focus') {
    pomo.focusMin = parseInt($('#pomo-focus').value) || 25;
    pomo.remaining = pomo.focusMin * 60;
    updatePomoDisplay();
  }
});
$('#pomo-break').addEventListener('change', () => {
  pomo.breakMin = parseInt($('#pomo-break').value) || 5;
});

// ============================
// ===== 네비 / 이벤트 =====
// ============================
$$('.nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

$('#prev-day').addEventListener('click', () => { selectedDate = addDays(selectedDate, -1); renderToday(); });
$('#next-day').addEventListener('click', () => { selectedDate = addDays(selectedDate, 1); renderToday(); });
$('#today-jump').addEventListener('click', () => { selectedDate = todayStr(); renderToday(); });

$('#cal-prev').addEventListener('click', () => {
  calendarMonth.month--;
  if (calendarMonth.month < 0) { calendarMonth.month = 11; calendarMonth.year--; }
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  calendarMonth.month++;
  if (calendarMonth.month > 11) { calendarMonth.month = 0; calendarMonth.year++; }
  renderCalendar();
});
$('#cal-today').addEventListener('click', () => {
  const d = new Date();
  calendarMonth = { year: d.getFullYear(), month: d.getMonth() };
  renderCalendar();
});

$('#add-task-btn').addEventListener('click', () => openTaskModal());
$('#add-category-btn').addEventListener('click', () => openCategoryModal());
$('#add-habit-btn').addEventListener('click', () => openHabitModal());
$('#add-dday-btn').addEventListener('click', () => openDdayModal());
$('#add-memo-btn').addEventListener('click', () => {
  state.memos.push({ id: uid(), text: '', createdAt: Date.now(), updatedAt: Date.now() });
  saveState();
  renderMemos();
  setTimeout(() => $$('textarea[data-memo-id]')[0]?.focus(), 50);
});

$('#theme-toggle').addEventListener('click', toggleTheme);

$('#pomodoro-btn').addEventListener('click', () => {
  updatePomoDisplay();
  updatePomoStats();
  showModal('pomodoro-modal');
});

$$('[data-close-modal]').forEach(b => b.addEventListener('click', hideModals));
$('#modal-backdrop').addEventListener('click', hideModals);

$$('.period-btn').forEach(b => b.addEventListener('click', () => {
  $$('.period-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  statsPeriod = b.dataset.period;
  renderStats();
}));

$('#reflection-input').addEventListener('input', (e) => {
  state.reflections[selectedDate] = e.target.value;
  clearTimeout(window._refTimer);
  window._refTimer = setTimeout(() => saveState(), 400);
});

// 데이터 import / export
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('백업 파일 다운로드 완료');
});

$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.categories || !data.tasks) throw new Error('형식이 올바르지 않습니다');
      if (!confirm('현재 데이터를 덮어쓸까요? 먼저 내보내기로 백업해두는 걸 추천해요.')) return;
      state = { ...defaultState(), ...data };
      saveState();
      applyTheme();
      switchView('today');
      toast('불러오기 완료');
    } catch (err) {
      toast('가져오기 실패: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('#reset-btn').addEventListener('click', () => {
  if (!confirm('정말로 모든 데이터를 초기화할까요? 되돌릴 수 없습니다.')) return;
  if (!confirm('정말 정말 확실하신가요?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  saveState();
  applyTheme();
  switchView('today');
  toast('초기화 완료');
});

// 키보드 단축키
document.addEventListener('keydown', (e) => {
  // 입력 중이면 무시
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ($$('.modal.show').length > 0) {
    if (e.key === 'Escape') hideModals();
    return;
  }

  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (currentView === 'today') openTaskModal();
  } else if (e.key === 't' || e.key === 'T') {
    selectedDate = todayStr();
    if (currentView === 'today') renderToday();
  } else if (e.key === 'd' || e.key === 'D') {
    toggleTheme();
  } else if (e.key === 'p' || e.key === 'P') {
    updatePomoDisplay();
    updatePomoStats();
    showModal('pomodoro-modal');
  } else if (e.key === 'ArrowLeft' && currentView === 'today') {
    selectedDate = addDays(selectedDate, -1);
    renderToday();
  } else if (e.key === 'ArrowRight' && currentView === 'today') {
    selectedDate = addDays(selectedDate, 1);
    renderToday();
  }
});

// ============================
// ===== 초기화 =====
// ============================
applyTheme();
switchView('today');
updatePomoDisplay();
