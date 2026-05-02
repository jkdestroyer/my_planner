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
  categories: [
    { id: 'c1', name: '공부', color: '#3d7d8c' },
    { id: 'c2', name: '일상', color: '#7a8e5b' },
    { id: 'c3', name: '운동', color: '#c14a3a' }
  ],
  tasks: {},        // { 'YYYY-MM-DD': [ {id, text, categoryId, done, duration, repeatType, repeatId} ] }
  habits: [
    { id: 'h1', name: '아침', icon: '🌅' },
    { id: 'h2', name: '점심', icon: '🥗' },
    { id: 'h3', name: '저녁', icon: '🍱' },
    { id: 'h4', name: '운동', icon: '💪' },
    { id: 'h5', name: '물 마시기', icon: '💧' }
  ],
  habitLog: {},     // { 'YYYY-MM-DD': { habitId: true } }
  ddays: [],        // [ {id, name, date} ]
  memos: [],        // [ {id, text, createdAt, updatedAt} ]
  reflections: {},  // { 'YYYY-MM-DD': '...' }
  timetable: {},    // { 'YYYY-MM-DD': { '08:00': [taskId,...] } }
  pomodoro: {},     // { 'YYYY-MM-DD': { sessions: 0, totalMinutes: 0 } }
  settings: { theme: 'light', startHour: 6, endHour: 24 },
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
let chosenColor = COLORS[0];
let contextTarget = null;
let statsPeriod = 'week';

// 차트 인스턴스 캐시
const charts = {};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // 기본값과 머지 (마이그레이션)
    const def = defaultState();
    return { ...def, ...parsed, settings: { ...def.settings, ...(parsed.settings || {}) } };
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
  document.documentElement.dataset.theme = state.settings.theme;
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
    container.innerHTML = '<p class="task-empty">설정에서 카테고리를 먼저 추가하세요.</p>';
    return;
  }

  state.categories.forEach(cat => {
    const tasks = tasksOfDay.filter(t => t.categoryId === cat.id);
    const block = document.createElement('div');
    block.className = 'category-block';

    const completed = tasks.filter(t => t.done).length;

    block.innerHTML = `
      <div class="category-head">
        <span class="category-dot" style="background:${cat.color}"></span>
        <span class="category-name">${escapeHtml(cat.name)}</span>
        <span class="category-count">${completed}/${tasks.length}</span>
      </div>
      <div class="task-list" data-cat-id="${cat.id}"></div>
    `;
    const list = block.querySelector('.task-list');

    if (tasks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-empty';
      empty.textContent = '비어있음';
      list.appendChild(empty);
    } else {
      tasks.forEach(task => list.appendChild(renderTaskItem(task, cat)));
    }

    container.appendChild(block);
  });
}

function renderTaskItem(task, cat) {
  const el = document.createElement('div');
  el.className = 'task-item' + (task.done ? ' completed' : '');
  el.draggable = true;
  el.dataset.taskId = task.id;
  el.style.borderLeftColor = cat.color;

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
    showContextMenu(e.pageX, e.pageY, { type: 'task', taskId: task.id });
  });

  el.addEventListener('dblclick', () => openTaskModal(task));

  // Drag start
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'task-list', taskId: task.id }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

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
function renderTimetable() {
  const container = $('#timetable');
  container.innerHTML = '';

  const startH = state.settings.startHour ?? 6;
  const endH = state.settings.endHour ?? 24;

  const tt = state.timetable[selectedDate] || {};
  const allTasks = state.tasks[selectedDate] || [];

  for (let h = startH; h < endH; h++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    const hourStr = String(h).padStart(2, '0') + ':00';

    slot.innerHTML = `
      <div class="time-label">${hourStr}</div>
      <div class="time-content" data-hour="${hourStr}"></div>
    `;
    const content = slot.querySelector('.time-content');

    (tt[hourStr] || []).forEach(taskId => {
      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;
      const cat = state.categories.find(c => c.id === task.categoryId);
      const color = cat ? cat.color : '#888';

      const block = document.createElement('div');
      block.className = 'timetable-task';
      block.style.borderLeftColor = color;
      block.style.background = color + '18'; // very transparent
      block.draggable = true;
      block.dataset.taskId = taskId;

      block.innerHTML = `
        <span>${escapeHtml(task.text)}</span>
        <span class="remove" title="제거">×</span>
      `;

      block.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromTimetable(hourStr, taskId);
      });

      // 드래그로 다른 시간으로 이동
      block.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'timetable', taskId, fromHour: hourStr
        }));
      });

      content.appendChild(block);
    });

    // 드롭 타깃
    content.addEventListener('dragover', (e) => {
      e.preventDefault();
      content.classList.add('drag-over');
    });
    content.addEventListener('dragleave', () => content.classList.remove('drag-over'));
    content.addEventListener('drop', (e) => {
      e.preventDefault();
      content.classList.remove('drag-over');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (data.source === 'task-list') {
        addToTimetable(hourStr, data.taskId);
      } else if (data.source === 'timetable') {
        moveInTimetable(data.fromHour, hourStr, data.taskId);
      }
    });

    container.appendChild(slot);
  }
}

function addToTimetable(hour, taskId) {
  if (!state.timetable[selectedDate]) state.timetable[selectedDate] = {};
  // 다른 시간대에 이미 있다면 제거
  Object.keys(state.timetable[selectedDate]).forEach(h => {
    state.timetable[selectedDate][h] = state.timetable[selectedDate][h].filter(id => id !== taskId);
  });
  if (!state.timetable[selectedDate][hour]) state.timetable[selectedDate][hour] = [];
  state.timetable[selectedDate][hour].push(taskId);
  saveState();
  renderTimetable();
}

function removeFromTimetable(hour, taskId) {
  if (!state.timetable[selectedDate]?.[hour]) return;
  state.timetable[selectedDate][hour] = state.timetable[selectedDate][hour].filter(id => id !== taskId);
  saveState();
  renderTimetable();
}

function moveInTimetable(fromHour, toHour, taskId) {
  if (fromHour === toHour) return;
  removeFromTimetable(fromHour, taskId);
  addToTimetable(toHour, taskId);
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
    chip.className = 'habit-chip' + (log[h.id] ? ' done' : '');
    chip.innerHTML = `<span class="habit-icon">${escapeHtml(h.icon || '·')}</span><span>${escapeHtml(h.name)}</span>`;
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

    // 최근 30일
    const days = [];
    for (let i = 29; i >= 0; i--) {
      days.push(addDays(todayStr(), -i));
    }

    const doneCount = days.filter(d => state.habitLog[d]?.[habit.id]).length;
    const streak = calculateStreak(habit.id);

    card.innerHTML = `
      <div class="habit-card-head">
        <span class="habit-icon">${escapeHtml(habit.icon || '·')}</span>
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
    const tt = state.timetable[d] || {};
    const tasks = state.tasks[d] || [];
    Object.values(tt).flat().forEach(taskId => {
      const t = tasks.find(x => x.id === taskId);
      if (t && catMinutes[t.categoryId] !== undefined) {
        catMinutes[t.categoryId] += 60; // 시간표 1슬롯 = 1시간
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
function openTaskModal(task = null) {
  editingTask = task;
  $('#task-modal-title').textContent = task ? '태스크 수정' : '새 태스크';
  $('#task-text').value = task?.text || '';
  $('#task-duration').value = task?.duration || 30;

  const sel = $('#task-category');
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (task) sel.value = task.categoryId;

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
  renderToday();
});

// 카테고리 모달
function openCategoryModal(cat = null) {
  editingCategory = cat;
  $('#category-modal-title').textContent = cat ? '카테고리 수정' : '새 카테고리';
  $('#category-name').value = cat?.name || '';
  chosenColor = cat?.color || COLORS[0];

  const picker = $('#color-picker');
  picker.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === chosenColor ? ' selected' : '');
    sw.style.background = c;
    sw.addEventListener('click', () => {
      chosenColor = c;
      $$('.color-swatch').forEach(x => x.classList.toggle('selected', x.style.background === c || hexEq(x.style.background, c)));
    });
    picker.appendChild(sw);
  });

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
  $('#habit-icon').value = habit?.icon || '';
  showModal('habit-modal');
  setTimeout(() => $('#habit-name').focus(), 50);
}

$('#habit-save').addEventListener('click', () => {
  const name = $('#habit-name').value.trim();
  if (!name) return toast('이름을 입력해주세요');
  const icon = $('#habit-icon').value.trim() || '·';
  if (editingHabit) {
    editingHabit.name = name;
    editingHabit.icon = icon;
  } else {
    state.habits.push({ id: uid(), name, icon });
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
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('show');
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
      const tt = state.timetable[selectedDate] || {};
      Object.keys(tt).forEach(h => {
        tt[h] = tt[h].filter(id => id !== taskId);
      });
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
  const fromTT = state.timetable[fromDate];
  if (fromTT) {
    Object.keys(fromTT).forEach(h => {
      fromTT[h] = fromTT[h].filter(id => id !== task.id);
    });
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
