/* TidyWork 重设计演示的交互层：纯前端，数据只写 localStorage。 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const LS_KEY = 'tidywork-demo-v2';
  let CATS = ['工作', '个人', '学习'];
  const HOUR_START = 9;
  const HOUR_END = 19;

  /* ---------- 时间 ---------- */

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());

  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function shiftKey(key, days) {
    const d = parseKey(key);
    d.setDate(d.getDate() + days);
    return dateKey(d);
  }

  function startOfWeek(key) {
    const d = parseKey(key);
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return dateKey(d);
  }

  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function weekday(key) {
    return WEEK_CN[parseKey(key).getDay()];
  }

  function fmtCN(key) {
    const d = parseKey(key);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function relDay(key) {
    const t = todayKey();
    if (key === t) return '今天';
    if (key === shiftKey(t, 1)) return '明天';
    if (key === shiftKey(t, -1)) return '昨天';
    return fmtCN(key);
  }

  function relTime(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const minutesOf = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };

  const durText = (min) => {
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const r = min % 60;
    return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
  };

  /* ---------- 种子数据（演示样本） ---------- */

  function seed() {
    const t = todayKey();
    const now = new Date();
    const iso = (offsetMin = 0) => new Date(now.getTime() - offsetMin * 60000).toISOString();
    return {
      todos: [
        {
          id: 'td-1',
          title: '向崔宗风要数据脱敏的文档，用于运维流程',
          cat: '工作',
          priority: 'mid',
          due: shiftKey(t, -1),
          done: true,
          doneAt: iso(90),
          created: iso(60 * 24 * 2)
        },
        {
          id: 'td-2',
          title: '把会议纪要整理成模板，发到项目群',
          cat: '工作',
          priority: 'high',
          due: t,
          done: false,
          doneAt: null,
          created: iso(60 * 20)
        },
        {
          id: 'td-3',
          title: '补上季度报销单据',
          cat: '个人',
          priority: 'mid',
          due: shiftKey(t, -2),
          done: false,
          doneAt: null,
          created: iso(60 * 30)
        },
        {
          id: 'td-4',
          title: '约一次体检，顺便问下报告怎么取',
          cat: '个人',
          priority: 'low',
          due: shiftKey(t, 4),
          done: false,
          doneAt: null,
          created: iso(60 * 40)
        }
      ],
      meetings: [
        {
          id: 'mt-1',
          title: '项目沟通会',
          date: shiftKey(t, -1),
          start: '10:00',
          minutes: 60,
          place: '三楼小会议室'
        },
        {
          id: 'mt-2',
          title: '项目沟通会',
          date: t,
          start: '10:00',
          minutes: 60,
          place: '三楼小会议室'
        },
        {
          id: 'mt-3',
          title: '需求评审',
          date: t,
          start: '16:00',
          minutes: 45,
          place: '线上'
        }
      ],
      notes: [
        {
          id: 'nt-1',
          title: '循环会议规则',
          tags: ['会议', '规则'],
          body:
            '## 目的\n每周的循环会议只保留真正需要同步的那一场，其余改成异步写清楚。\n\n## 规则\n- 每周一 10:00 项目沟通会，超时 5 分钟就停\n- 议题提前一天贴到群里，没有议题就不开\n- 结论当天写进笔记，不留在聊天记录里\n\n## 待补\n- [ ] 把会议纪要模板发到项目群\n- [ ] 约一次季度复盘的时间',
          created: iso(60 * 24 * 3),
          updated: iso(60 * 26),
          starred: false,
          history: []
        },
        {
          id: 'nt-2',
          title: '本周复盘',
          tags: ['复盘'],
          body:
            '## 这周做完的\n- 数据脱敏文档的清单已经对齐\n- 运维流程补了第一节\n\n## 卡住的地方\n> 等的不是文档，是三个部门对“脱敏口径”的共同定义。\n\n## 下周先做\n1. 把口径写成三行话，发给三方确认\n2. 会议纪要模板落地，先在一场会上试\n\n- [ ] 找崔宗风确认脱敏范围',
          created: iso(60 * 24 * 5),
          updated: iso(60 * 60 * 6),
          starred: true,
          history: []
        }
      ],
      ui: {
        view: 'home',
        filter: 'all',
        cat: null,
        query: '',
        sort: 'smart',
        month: { y: new Date().getFullYear(), m: new Date().getMonth() },
        day: t,
        meetNav: 'month',
        note: 'nt-1',
        mode: 'live',
        homeDue: t
      }
    };
  }

  /* ---------- 真实数据通道（v3.26：界面完全对齐设计稿，数据走插件后端） ---------- */

  const API = '/tidywork-api';
  let ready = false;
  let syncTimer = null;
  let syncing = false;
  let snapshot = { todos: [], meetings: [], notes: [] };

  function blankState() {
    const t = todayKey();
    return {
      todos: [],
      meetings: [],
      notes: [],
      cats: ['工作', '个人', '学习'],
      ui: {
        view: 'home', filter: 'all', cat: null, query: '', sort: 'smart',
        month: { y: new Date().getFullYear(), m: new Date().getMonth() },
        day: t, meetNav: 'month', note: null, mode: 'live', homeDue: t
      }
    };
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function snapEntities() {
    return clone({ todos: S.todos, meetings: S.meetings, notes: S.notes });
  }

  async function apiReq(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!json || !json.ok) {
      const err = new Error((json && json.error) || '请求失败 ' + res.status);
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  function dueToDate(v) {
    if (v === 'today') return todayKey();
    if (v === 'tomorrow') return shiftKey(todayKey(), 1);
    if (v === 'yesterday') return shiftKey(todayKey(), -1);
    if (v === 'week') return shiftKey(startOfWeek(todayKey()), 6);
    if (!v || v === 'none') return null;
    return String(v).slice(0, 10);
  }

  function durationMinutes(duration, start) {
    if (!duration) return 60;
    const m = String(duration).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) return 60;
    return Math.max(5, (Number(m[3]) * 60 + Number(m[4])) - (Number(m[1]) * 60 + Number(m[2])));
  }

  function endTime(start, minutes) {
    const [h, m] = start.split(':').map(Number);
    const total = h * 60 + m + minutes;
    return pad(Math.floor(total / 60) % 24) + ':' + pad(total % 60);
  }

  function todoPayload(t) {
    return { title: t.title, priority: t.priority || 'mid', category: t.cat || '工作', due: t.due || 'none', done: !!t.done };
  }
  function meetingPayload(m) {
    return { title: m.title, date: m.date, time: m.start || '09:00', duration: (m.start || '09:00') + ' - ' + endTime(m.start || '09:00', m.minutes || 60), location: m.place || '线上会议', participants: m.participants || 1 };
  }
  function notePayload(n, withRev) {
    const p = { title: n.title || '未命名笔记', content: n.body || '', tags: n.tags || [], pinned: !!n.starred, format: 'markdown' };
    if (withRev) p.rev = n.rev;
    return p;
  }

  async function hydrate() {
    const [todosAll, todosDone, meetings, noteList] = await Promise.all([
      apiReq('GET', '/todos?view=all'),
      apiReq('GET', '/todos?view=done'),
      apiReq('GET', '/meetings'),
      apiReq('GET', '/notes')
    ]);
    S.todos = (todosAll || []).concat(todosDone || []).map((t) => ({
      id: t.id, title: t.title, cat: t.category || '工作', priority: t.priority || 'mid',
      due: dueToDate(t.due), done: !!t.done, doneAt: null, created: ''
    }));
    S.meetings = (meetings || []).map((m) => ({
      id: m.id, title: m.title, date: String(m.date || '').slice(0, 10),
      start: m.time || '09:00', minutes: durationMinutes(m.duration, m.time),
      place: m.location || '线上会议', participants: m.participants || 1
    }));
    const details = await Promise.all((noteList || []).map((n) => apiReq('GET', '/notes/' + encodeURIComponent(n.id)).catch(() => null)));
    S.notes = details.filter(Boolean).map((n) => ({
      id: n.id, title: n.title, tags: n.tags || [], body: n.content || '',
      created: n.createdAt || '', updated: n.updatedAt || '', starred: !!n.pinned,
      rev: n.rev || 1, history: []
    }));
    CATS = Array.from(new Set(S.todos.map((t) => t.cat).filter(Boolean)));
    if (!CATS.length) CATS = ['工作', '个人', '学习'];
    S.cats = CATS.slice();
    if (S.notes.length && !S.notes.find((n) => n.id === S.ui.note)) S.ui.note = S.notes[0].id;
    if (!S.notes.length) S.ui.note = null;
    snapshot = snapEntities();
    ready = true;
  }

  function save() {
    if (!ready) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 350);
  }

  async function syncNow() {
    if (!ready) return;
    if (syncing) { syncTimer = setTimeout(syncNow, 400); return; }
    syncing = true;
    try {
      const old = snapshot;
      // 待办
      for (const t of S.todos) {
        const prev = old.todos.find((x) => x.id === t.id);
        if (!prev) {
          try { const r = await apiReq('POST', '/todos', todoPayload(t)); t.id = r.id; } catch (e) { console.error(e); }
        } else if (JSON.stringify(todoPayload(t)) !== JSON.stringify(todoPayload(prev))) {
          try { await apiReq('PATCH', '/todos/' + encodeURIComponent(t.id), todoPayload(t)); } catch (e) { console.error(e); }
        }
      }
      for (const p of old.todos) {
        if (!S.todos.find((x) => x.id === p.id)) {
          try { await apiReq('DELETE', '/todos/' + encodeURIComponent(p.id)); } catch (e) { console.error(e); }
        }
      }
      // 会议
      for (const m of S.meetings) {
        const prev = old.meetings.find((x) => x.id === m.id);
        if (!prev) {
          try { const r = await apiReq('POST', '/meetings', meetingPayload(m)); m.id = r.id; } catch (e) { console.error(e); }
        } else if (JSON.stringify(meetingPayload(m)) !== JSON.stringify(meetingPayload(prev))) {
          try { await apiReq('PATCH', '/meetings/' + encodeURIComponent(m.id), meetingPayload(m)); } catch (e) { console.error(e); }
        }
      }
      for (const p of old.meetings) {
        if (!S.meetings.find((x) => x.id === p.id)) {
          try { await apiReq('DELETE', '/meetings/' + encodeURIComponent(p.id)); } catch (e) { console.error(e); }
        }
      }
      // 笔记（自动保存频繁，按内容 diff；带 rev 防冲突）
      for (const n of S.notes) {
        const prev = old.notes.find((x) => x.id === n.id);
        if (!prev) {
          try { const r = await apiReq('POST', '/notes', notePayload(n, false)); n.id = r.id; n.rev = r.rev; } catch (e) { console.error(e); }
        } else if (JSON.stringify(notePayload(n, false)) !== JSON.stringify(notePayload(prev, false))) {
          try {
            const r = await apiReq('PUT', '/notes/' + encodeURIComponent(n.id), notePayload(n, true));
            n.rev = r.rev;
          } catch (e) {
            if (e.status === 409) {
              try { const fresh = await apiReq('GET', '/notes/' + encodeURIComponent(n.id)); n.rev = fresh.rev; await apiReq('PUT', '/notes/' + encodeURIComponent(n.id), notePayload(n, true)); } catch (e2) { console.error(e2); }
            } else { console.error(e); }
          }
        }
      }
      for (const p of old.notes) {
        if (!S.notes.find((x) => x.id === p.id)) {
          try { await apiReq('DELETE', '/notes/' + encodeURIComponent(p.id)); } catch (e) { console.error(e); }
        }
      }
      snapshot = snapEntities();
    } finally {
      syncing = false;
    }
  }

  let S = blankState();
  CATS = Array.isArray(S.cats) && S.cats.length ? S.cats.slice() : CATS.slice();
  if (!Array.isArray(S.cats)) S.cats = CATS.slice();

  const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 7)}`;

  /* ---------- 图标与转义 ---------- */

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const icon = (name, cls = '') =>
    `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#${name}"></use></svg>`;

  /* ---------- 查询 ---------- */

  const openTodos = () => S.todos.filter((t) => !t.done);
  const doneTodos = () => S.todos.filter((t) => t.done);

  const isThisWeek = (key) => {
    const start = startOfWeek(todayKey());
    const end = shiftKey(start, 6);
    return key >= start && key <= end;
  };

  const todosForDay = (key) => S.todos.filter((t) => t.due === key);

  const openDueToday = () => openTodos().filter((t) => t.due === todayKey());
  const openDueByToday = () => openTodos().filter((t) => t.due && t.due <= todayKey());
  const overdueTodos = () => openTodos().filter((t) => t.due && t.due < todayKey());

  const meetingsForDay = (key) =>
    S.meetings
      .filter((m) => m.date === key)
      .sort((a, b) => minutesOf(a.start) - minutesOf(b.start));

  const meetingsForMonth = (y, m) =>
    S.meetings
      .filter((mt) => {
        const d = parseKey(mt.date);
        return d.getFullYear() === y && d.getMonth() === m;
      })
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const currentNote = () => S.notes.find((n) => n.id === S.ui.note) || null;

  /* ---------- 通用渲染 ---------- */

  function renderShell() {
    const now = new Date();
    $('#shellDate').textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekday(todayKey())}`;
  }

  function dueInfo(t) {
    if (!t.due) return { text: '无期限', cls: '' };
    if (t.done) return { text: `截止 ${fmtCN(t.due)}`, cls: '' };
    if (t.due < todayKey()) return { text: `逾期 ${fmtCN(t.due)}`, cls: 'is-overdue' };
    if (t.due === todayKey()) return { text: '今天截止', cls: 'is-today' };
    if (t.due === shiftKey(todayKey(), 1)) return { text: '明天截止', cls: '' };
    return { text: `截止 ${fmtCN(t.due)}`, cls: '' };
  }

  /* ---------- 工作台 ---------- */

  function renderHome() {
    $('#dateText').textContent = fmtCN(todayKey());
    $('#weekText').textContent = weekday(todayKey());

    const todayMeetings = meetingsForDay(todayKey());
    const todayTodos = S.todos.filter((t) => t.due === todayKey() && !t.done);
    const parts = [];
    parts.push(todayMeetings.length ? `${todayMeetings.length} 场会议` : '没有会议');
    parts.push(todayTodos.length ? `${todayTodos.length} 项待办今天到期` : '今天没有到期的待办');
    $('#homeLine').textContent = `今天 ${parts.join('，')}。`;

    $('#tlRange').textContent = `${pad(HOUR_START)}:00 到 ${pad(HOUR_END)}:00`;
    $('#tdSub').textContent = `${todayTodos.length} 项未完成`;
    renderTimeline(todayMeetings);
    renderHomeTodos();
    renderLedger();
    renderRhythm();
    renderRecentNotes();
    $('#homeDueText').textContent = S.ui.homeDue ? (S.ui.homeDue === todayKey() ? '今天截止' : `${fmtCN(S.ui.homeDue)} 截止`) : '不设期限';
  }

  function renderTimeline(todayMeetings) {
    const ruler = $('#timeline');
    const rows = HOUR_END - HOUR_START;
    let html = '';
    for (let i = 0; i < rows; i += 1) {
      const h = HOUR_START + i;
      html += `<div class="hr-row"><span class="hr-label">${pad(h)}:00</span></div>`;
    }
    html += '<div class="ev-layer" id="evLayer"></div>';
    ruler.innerHTML = html;

    const layer = $('#evLayer');
    const hourH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour-h'));
    const placed = layoutMeetings(todayMeetings);

    placed.forEach(({ mt, lane, lanes }) => {
      const top = ((minutesOf(mt.start) - HOUR_START * 60) / 60) * hourH;
      const height = Math.max((mt.minutes / 60) * hourH - 2, 22);
      const width = 100 / lanes;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'slip' + (height < 38 ? ' slip--short' : '');
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      el.style.left = `calc(${lane * width}% + ${lane ? 2 : 0}px)`;
      el.style.width = `calc(${width}% - 2px)`;
      el.dataset.meeting = mt.id;
      el.innerHTML = `<span class="slip-row"><span class="slip-time">${mt.start}</span><span class="slip-title">${esc(mt.title)}</span></span><span class="slip-meta">${durText(mt.minutes)}</span>`;
      el.setAttribute('aria-label', `${mt.start} ${mt.title}，${durText(mt.minutes)}，查看当天安排`);
      layer.appendChild(el);
    });

    const total = todayMeetings.reduce((sum, mt) => sum + mt.minutes, 0);
    const free = (HOUR_END - HOUR_START) * 60 - total;
    $('#tlFoot').innerHTML = todayMeetings.length
      ? `<span>已排 ${todayMeetings.length} 场，共 ${durText(total)}</span><span>空档 ${durText(free)}</span>`
      : `<span>整段 ${durText(free)} 都可安排</span>`;

    if (!todayMeetings.length) {
      const box = document.createElement('div');
      box.className = 'ruler-empty';
      box.innerHTML =
        '<h3>今天没有会议</h3><p>09:00 到 19:00 空着。要开会就先排进来，日程会立刻出现在这条时间轴上。</p>' +
        `<button class="key key--quiet" type="button" data-new-meeting="${todayKey()}">排一场会议</button>`;
      ruler.appendChild(box);
    }

    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins >= HOUR_START * 60 && mins <= HOUR_END * 60) {
      const line = document.createElement('div');
      line.className = 'now-line';
      line.style.top = `${((mins - HOUR_START * 60) / 60) * hourH}px`;
      line.innerHTML = `<span>${pad(now.getHours())}:${pad(now.getMinutes())}</span>`;
      layer.appendChild(line);
    }
  }

  function layoutMeetings(list) {
    const sorted = list.slice().sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    const lanes = [];
    const placed = [];
    let cluster = [];
    let clusterEnd = -1;

    const flush = () => {
      const maxLane = cluster.reduce((m, p) => Math.max(m, p.lane + 1), 1);
      cluster.forEach((p) => placed.push({ ...p, lanes: maxLane }));
      cluster = [];
      clusterEnd = -1;
      lanes.length = 0;
    };

    sorted.forEach((mt) => {
      const start = minutesOf(mt.start);
      const end = start + mt.minutes;
      if (start >= clusterEnd && clusterEnd !== -1) flush();
      clusterEnd = Math.max(clusterEnd, end);
      let lane = 0;
      while (lanes[lane] !== undefined && lanes[lane] > start) lane += 1;
      lanes[lane] = end;
      cluster.push({ mt, lane });
    });
    if (cluster.length) flush();
    return placed;
  }

  function renderHomeTodos() {
    const list = S.todos
      .filter((t) => t.due === todayKey() && !t.done)
      .sort((a, b) => (a.priority === 'high' ? -1 : 1));
    const host = $('#homeTodos');
    host.innerHTML = list.length
      ? list.map((t) => todoRow(t)).join('')
      : '<li class="mini-empty" style="border:0">今天的待办都清空了。新的想法直接写在下面。</li>';
  }

  function todoRow(t) {
    const due = dueInfo(t);
    return `<li class="row${t.done ? ' is-done' : ''}" data-row="${t.id}">
      <label class="check">
        <input type="checkbox" data-check="${t.id}" ${t.done ? 'checked' : ''} aria-label="把「${esc(t.title)}」标记为${t.done ? '未完成' : '已完成'}">
        ${icon('i-check', 'tick')}
      </label>
      <div class="row-main">
        <p class="row-title">${esc(t.title)}</p>
        <p class="row-meta"><span>${esc(t.cat)}</span>${t.priority === 'high' ? '<span class="prio-high">高优先级</span>' : ''}${t.done ? '<span>已完成</span>' : ''}</p>
      </div>
      <p class="row-due ${due.cls}">${due.text}</p>
      <div class="row-act"><button class="text-btn" type="button" data-edit="${t.id}">编辑</button></div>
    </li>`;
  }

  function renderLedger() {
    const all = S.todos.length;
    const done = doneTodos().length;
    const doneWeek = doneTodos().filter((t) => t.doneAt && isThisWeek(dateKey(new Date(t.doneAt)))).length;
    const rows = [
      ['待办完成', `${done}/${all}`, ''],
      ['今天到期', `${openDueToday().length}`, ''],
      ['逾期未完成', `${overdueTodos().length}`, overdueTodos().length ? 'is-alert' : ''],
      ['本周会议', `${S.meetings.filter((mt) => isThisWeek(mt.date)).length}`, '']
    ];
    $('#ledger').innerHTML = rows
      .map(
        ([label, value, cls]) =>
          `<div class="ledger-row"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`
      )
      .join('');
    const pct = all ? Math.round((done / all) * 100) : 0;
    $('#ledgerMeter').style.width = `${pct}%`;
    const start = startOfWeek(todayKey());
    $('#weekRange').textContent = `${parseKey(start).getMonth() + 1}/${parseKey(start).getDate()} 至 ${parseKey(shiftKey(start, 6)).getMonth() + 1}/${parseKey(shiftKey(start, 6)).getDate()}`;
  }

  function renderRhythm() {
    const start = startOfWeek(todayKey());
    const max = Math.max(
      1,
      ...Array.from({ length: 7 }, (_, i) => meetingsForDay(shiftKey(start, i)).length)
    );
    $('#rhythm').innerHTML = Array.from({ length: 7 }, (_, i) => {
      const key = shiftKey(start, i);
      const ms = meetingsForDay(key).length;
      const ts = openTodos().filter((t) => t.due === key).length;
      const state = ms ? `${ms} 场会议` : ts ? `${ts} 项待办` : '空';
      const width = Math.round((ms / max) * 100);
      return `<li class="rhythm-row${key === todayKey() ? ' is-today' : ''}">
        <span class="rhythm-day">${weekday(key)}</span>
        <span class="rhythm-date">${parseKey(key).getMonth() + 1}/${parseKey(key).getDate()}</span>
        <span class="bar" aria-hidden="true"><i style="width:${width}%"></i></span>
        <span class="rhythm-state">${state}</span>
      </li>`;
    }).join('');
  }

  function renderRecentNotes() {
    const recent = S.notes
      .slice()
      .sort((a, b) => new Date(b.updated) - new Date(a.updated))
      .slice(0, 3);
    $('#recentNotes').innerHTML = recent.length
      ? recent
          .map(
            (n) =>
              `<li><button class="mini-item" type="button" data-open-note="${n.id}">
                <span class="mini-title">${esc(n.title || '无标题笔记')}</span>
                <span class="mini-meta">${relTime(n.updated)}</span>
              </button></li>`
          )
          .join('')
      : '<li class="mini-empty">还没有笔记。写了第一篇，这里会按时间列出来。</li>';
  }

  /* ---------- 待办 ---------- */

  function todoViews() {
    const t = todayKey();
    return [
      { key: 'all', label: '全部待办', count: openTodos().length },
      { key: 'today', label: '今天', count: openTodos().filter((x) => x.due && x.due <= t).length },
      { key: 'week', label: '本周', count: openTodos().filter((x) => x.due && isThisWeek(x.due)).length },
      { key: 'done', label: '已完成', count: doneTodos().length }
    ];
  }

  function filteredTodos() {
    const q = S.ui.query.trim().toLowerCase();
    let list = S.todos.slice();
    if (S.ui.filter === 'today') list = list.filter((t) => !t.done && t.due && t.due <= todayKey());
    else if (S.ui.filter === 'week') list = list.filter((t) => !t.done && t.due && isThisWeek(t.due));
    else if (S.ui.filter === 'done') list = list.filter((t) => t.done);
    else if (S.ui.filter === 'all') list = list.filter((t) => !t.done);
    if (S.ui.cat) list = list.filter((t) => t.cat === S.ui.cat);
    if (q) {
      list = list.filter(
        (t) => t.title.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q)
      );
    }
    const smart = (t) => [t.done ? 1 : 0, t.due || '9999-99-99', t.priority === 'high' ? 0 : t.priority === 'mid' ? 1 : 2];
    const sorters = {
      smart: (a, b) => {
        const [d1, u1, p1] = smart(a);
        const [d2, u2, p2] = smart(b);
        return d1 - d2 || (u1 < u2 ? -1 : u1 > u2 ? 1 : 0) || p1 - p2;
      },
      due: (a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99'),
      priority: (a, b) => ['high', 'mid', 'low'].indexOf(a.priority) - ['high', 'mid', 'low'].indexOf(b.priority),
      title: (a, b) => a.title.localeCompare(b.title, 'zh'),
      created: (a, b) => new Date(b.created) - new Date(a.created)
    };
    return list.sort(sorters[S.ui.sort] || sorters.smart);
  }

  function renderTodos() {
    const views = todoViews();
    $('#todoViews').innerHTML = views
      .map(
        (v) =>
          `<button class="rail-item${S.ui.filter === v.key ? ' is-on' : ''}" type="button" data-filter="${v.key}" ${S.ui.filter === v.key ? 'aria-current="true"' : ''}>
            <span>${v.label}</span><span class="rail-count">${v.count}</span>
          </button>`
      )
      .join('');

    const catCounts = CATS.map((c) => ({ c, n: openTodos().filter((t) => t.cat === c).length }));
    $('#todoCats').innerHTML =
      `<button class="rail-item${!S.ui.cat ? ' is-on' : ''}" type="button" data-cat="">全部<span class="rail-count">${openTodos().length}</span></button>` +
      catCounts
        .map(
          ({ c, n }) =>
            `<button class="rail-item${S.ui.cat === c ? ' is-on' : ''}" type="button" data-cat="${esc(c)}">
              <span>${c}</span><span class="rail-count">${n}</span>
            </button>`
        )
        .join('');

    const titles = { all: '全部待办', today: '今天', week: '本周', done: '已完成' };
    $('#todos-h').textContent = `${titles[S.ui.filter] || '全部待办'}${S.ui.cat ? '，' + S.ui.cat : ''}`;

    const list = filteredTodos();
    const todayN = openDueByToday().length;
    const doneWeek = doneTodos().filter((t) => t.doneAt && isThisWeek(dateKey(new Date(t.doneAt)))).length;
    const rate = S.todos.length ? Math.round((doneTodos().length / S.todos.length) * 100) : 0;

    $('#todoStats').innerHTML = `
      <div class="stat">
        <span class="stat-figure${todayN ? ' is-alert' : ''}">${todayN}</span>
        <span class="stat-label">今天到期，含逾期</span>
      </div>
      <div class="stat">
        <span class="stat-figure">${doneWeek}</span>
        <span class="stat-label">本周已完成</span>
      </div>
      <div class="stat">
        <span class="stat-figure">${rate}%</span>
        <span class="stat-label">全部完成率</span>
        <span class="stat-meter" aria-hidden="true"><i style="width:${rate}%"></i></span>
      </div>`;

    const q = S.ui.query.trim().toLowerCase();
    const doneInView = S.ui.filter === 'all'
      ? doneTodos().filter((t) => (!S.ui.cat || t.cat === S.ui.cat) && (!q || t.title.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q)))
      : [];
    $('#todosSub').textContent = S.ui.filter === 'done'
      ? `${list.length} 条已完成${S.ui.query ? '，搜索 “' + S.ui.query + '”' : ''}`
      : S.ui.filter === 'all'
        ? `${list.length} 条未完成，${doneInView.length} 条已完成${S.ui.query ? '，搜索 “' + S.ui.query + '”' : ''}`
        : `${list.length} 条${S.ui.query ? '，搜索 “' + S.ui.query + '”' : ''}`;

    $('#todoList').innerHTML = list.map((t) => todoRow(t)).join('') +
      (doneInView.length
        ? `<li class="list-head"><span>已完成</span><span>${doneInView.length}</span></li>${doneInView.map((t) => todoRow(t)).join('')}`
        : '');
    const empty = $('#todoEmpty');
    if (!list.length) {
      empty.hidden = false;
      const hasAny = S.todos.length > 0;
      empty.querySelector('.empty-title').textContent = hasAny ? '这个视图里没有待办' : '这里还没有待办';
      empty.querySelector('.empty-line').textContent = hasAny
        ? '换个视图或清掉搜索，也可以直接新建一条。'
        : '写下第一件要推进的事，设个截止日期，它就会出现在工作台的今天里。';
      empty.querySelector('button').textContent = hasAny ? '新建一条' : '新建第一条';
    } else {
      empty.hidden = true;
    }
  }

  /* ---------- 会议 ---------- */

  function monthDays(y, m) {
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(y, m, 1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { key: dateKey(d), day: d.getDate(), out: d.getMonth() !== m, date: d };
    });
  }

  function renderMeetings() {
    const { y, m } = S.ui.month;
    $('#m-h').textContent = `${y}年${m + 1}月`;
    const monthList = meetingsForMonth(y, m);
    const totalMin = monthList.reduce((s, mt) => s + mt.minutes, 0);
    $('#monthSub').textContent = monthList.length
      ? `本月 ${monthList.length} 场会议，共 ${durText(totalMin)}`
      : '本月还没有会议';

    $('#meetNav').innerHTML = [
      { key: 'today', day: todayKey() },
      { key: 'tomorrow', day: shiftKey(todayKey(), 1) }
    ]
      .map(
        ({ key, day }) =>
          `<button class="rail-item${S.ui.meetNav === key ? ' is-on' : ''}" type="button" data-meet-nav="${key}">
            <span>${relDay(day)} ${weekday(day)}</span>
            <span class="rail-count">${meetingsForDay(day).length}</span>
          </button>`
      )
      .join('') +
      `<button class="rail-item${S.ui.meetNav === 'month' ? ' is-on' : ''}" type="button" data-meet-nav="month">
        <span>整个月</span><span class="rail-count">${monthList.length}</span>
      </button>`;

    $('#calHead').innerHTML = ['一', '二', '三', '四', '五', '六', '日']
      .map((d) => `<span>${d}</span>`)
      .join('');

    const cells = monthDays(y, m);
    $('#calendar').innerHTML = cells
      .map(({ key, day, out }) => {
        const ms = meetingsForDay(key);
        const isToday = key === todayKey();
        const selected = key === S.ui.day;
        return `<button class="cal-cell${out ? ' is-out' : ''}${isToday ? ' is-today' : ''}${selected ? ' is-selected' : ''}" type="button" data-day="${key}" aria-label="${fmtCN(key)} ${weekday(key)}${ms.length ? `，${ms.length} 场会议` : '，没有会议'}${isToday ? '，今天' : ''}">
          <span class="cal-day"><span class="cal-num">${day}</span>${isToday ? '<span class="cal-today-tag">今天</span>' : ''}</span>
          ${ms
            .slice(0, 2)
            .map((mt) => `<span class="cell-ev"><time>${mt.start}</time><b>${esc(mt.title)}</b></span>`)
            .join('')}
          ${ms.length > 2 ? `<span class="cell-more">另有 ${ms.length - 2} 场</span>` : ''}
        </button>`;
      })
      .join('');

    renderDayDetail();
    renderMonthMeetings(monthList);
  }

  function renderDayDetail() {
    const key = S.ui.day;
    const ms = meetingsForDay(key);
    const total = ms.reduce((s, mt) => s + mt.minutes, 0);
    $('#dayDetail').innerHTML = `
      <header class="detail-head">
        <h2 class="detail-date">${fmtCN(key)} ${weekday(key)}</h2>
        <p class="detail-sub">${ms.length ? `${ms.length} 场会议，共 ${durText(total)}` : '这天没有会议'}</p>
      </header>
      ${ms.length ? `<ul class="detail-list">${ms
        .map(
          (mt) => `<li class="detail-row">
            <span class="detail-time">${mt.start}</span>
            <div><p class="detail-title">${esc(mt.title)}</p><p class="detail-meta">${durText(mt.minutes)}${mt.place ? '，' + esc(mt.place) : ''}</p></div>
            <button class="text-btn" type="button" data-del-meeting="${mt.id}">移除</button>
          </li>`
        )
        .join('')}</ul>` : `<div class="detail-empty"><p>把会排进这天，时间轴和月历会同时更新。</p></div>`}
      <button class="key key--quiet" type="button" data-new-meeting="${key}">在这天排会</button>`;
  }

  function renderMonthMeetings(monthList) {
    $('#monthMeetings').innerHTML = monthList.length
      ? monthList
          .map(
            (mt) => `<li><button class="mini-item" type="button" data-day="${mt.date}">
              <span class="mini-title">${esc(mt.title)}</span>
              <span class="mini-meta">${fmtCN(mt.date)} ${weekday(mt.date)}，${mt.start}，${durText(mt.minutes)}</span>
            </button></li>`
          )
          .join('')
      : '<li class="mini-empty">本月还没有会议。</li>';
  }

  /* ---------- 笔记 ---------- */

  function noteText(body) {
    return body
      .replace(/^#+\s*/gm, '')
      .replace(/^- \[[ x]\]\s*/gm, '')
      .replace(/[`*>]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  const wordCount = (body) => Array.from(body.replace(/\s+/g, '')).length;

  function renderNotes() {
    const q = $('#noteSearch').value.trim().toLowerCase();
    const list = S.notes
      .slice()
      .sort((a, b) => new Date(b.updated) - new Date(a.updated))
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));

    $('#noteList').innerHTML = list.length
      ? list
          .map(
            (n) => `<li><button class="note-item${n.id === S.ui.note ? ' is-on' : ''}" type="button" data-open-note="${n.id}">
              <span class="note-item-title">${esc(n.title || '无标题笔记')}</span>
              <span class="note-item-snippet">${esc(noteText(n.body).slice(0, 70) || '空白笔记')}</span>
              <span class="note-item-meta"><span>${relTime(n.updated)}</span><span>${wordCount(n.body)} 字</span></span>
            </button></li>`
          )
          .join('')
      : '<li class="mini-empty">没有匹配的笔记。</li>';

    const note = currentNote();
    $('#editorWrap').hidden = !note;
    $('#notesEmpty').hidden = !!note;
    if (!note) return;

    $('#noteTitle').value = note.title;
    $('#noteBody').value = note.body;
    $('#noteTags').value = note.tags.join('，');
    $('#noteTime').textContent = `最后编辑 ${relTime(note.updated)}`;
    $('#noteWords').textContent = `${wordCount(note.body)} 字`;
    setSaveState('已保存');
    $('#notePreview').innerHTML = renderMarkdown(note.body);
    $('#writeArea').dataset.mode = S.ui.mode;
    $$('.mode').forEach((b) => {
      const on = b.dataset.mode === S.ui.mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('#starNote').setAttribute('aria-pressed', String(!!note.starred));
  }

  function setSaveState(text, pending = false) {
    const el = $('#saveState');
    el.textContent = text;
    el.classList.toggle('is-pending', pending);
  }

  /* 轻量 Markdown：标题、列表、勾选项、引用、粗体、行内代码、链接 */
  function renderMarkdown(src) {
    const inline = (s) =>
      esc(s)
        .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

    const lines = src.replace(/\r/g, '').split('\n');
    let out = '';
    let inList = false;
    const closeList = () => {
      if (inList) {
        out += '</ul>';
        inList = false;
      }
    };

    lines.forEach((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) {
        closeList();
        return;
      }
      const head = line.match(/^(#|##)\s+(.*)$/);
      if (head) {
        closeList();
        out += `<h2 class="md-h">${inline(head[2])}</h2>`;
        return;
      }
      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) {
        closeList();
        out += `<h3 class="md-h3">${inline(h3[1])}</h3>`;
        return;
      }
      const check = line.match(/^-\s*\[([ xX])\]\s*(.*)$/);
      if (check) {
        const done = check[1].toLowerCase() === 'x';
        if (!inList) {
          out += '<ul>';
          inList = true;
        }
        out += `<li class="md-check${done ? ' is-done' : ''}"><span aria-hidden="true">${done ? '✓' : '○'}</span><span>${inline(check[2])}</span></li>`;
        return;
      }
      const ordered = line.match(/^\d+\.\s+(.*)$/);
      if (ordered) {
        closeList();
        out += `<ol><li>${inline(ordered[1])}</li></ol>`;
        return;
      }
      const item = line.match(/^[-*]\s+(.*)$/);
      if (item) {
        if (!inList) {
          out += '<ul>';
          inList = true;
        }
        out += `<li>${inline(item[1])}</li>`;
        return;
      }
      const quote = line.match(/^>\s+(.*)$/);
      if (quote) {
        closeList();
        out += `<p class="md-quote">${inline(quote[1])}</p>`;
        return;
      }
      closeList();
      out += `<p>${inline(line)}</p>`;
    });
    closeList();
    return out || '<p class="preview-empty">正文还是空的。点这里开始写。</p>';
  }

  function openNote(id, { focus = false } = {}) {
    const note = S.notes.find((n) => n.id === id);
    if (!note) return;
    S.ui.note = id;
    save();
    renderNotes();
    renderRecentNotes();
    if (focus) $('#noteTitle').focus();
  }

  /* ---------- 视图切换 ---------- */

  function setView(name) {
    S.ui.view = name;
    $$('.tab').forEach((b) => {
      const on = b.dataset.view === name;
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('.view').forEach((sec) => {
      sec.hidden = sec.id !== `view-${name}`;
    });
    save();
    if (name === 'home') renderHome();
    if (name === 'todos') renderTodos();
    if (name === 'meetings') renderMeetings();
    if (name === 'notes') renderNotes();
  }

  function renderAll() {
    renderShell();
    renderHome();
    renderTodos();
    renderMeetings();
    renderNotes();
  }

  /* ---------- 弹窗 ---------- */

  const todoDialog = $('#todoDialog');
  const meetingDialog = $('#meetingDialog');
  const historyDialog = $('#historyDialog');
  let editingTodo = null;
  let todoDialogDue = null;

  function openTodoDialog(todo = null) {
    editingTodo = todo;
    $('#todoDialogTitle').textContent = todo ? '编辑待办' : '新建待办';
    $('#tdTitle').value = todo ? todo.title : '';
    $('#tdPriority').value = todo ? todo.priority : 'mid';
    const cats = CATS.includes(todo?.cat) || !todo ? CATS : CATS.concat([todo.cat]);
    $('#tdCategory').innerHTML = cats.map(
      (c) => `<option value="${esc(c)}">${c}</option>`
    ).join('');
    $('#tdCategory').value = todo ? todo.cat : CATS[0];
    todoDialogDue = todo ? todo.due : S.ui.homeDue || todayKey();
    $('#tdTitle').removeAttribute('aria-invalid');
    $('#tdTitleHelp').textContent = '';
    $('#tdTitleHelp').classList.remove('is-error');
    renderDialogDue();
    ensureTodoDelete(todo);
    todoDialog.showModal();
    $('#tdTitle').focus();
  }

  function ensureTodoDelete(todo) {
    let btn = $('#tdDelete');
    if (!todo) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'tdDelete';
      btn.type = 'button';
      btn.className = 'key key--quiet';
      btn.textContent = '删除';
      $('#todoForm .modal-foot').prepend(btn);
      btn.addEventListener('click', () => {
        todoDialog.close('cancel');
        deleteTodo(todo.id);
      });
    }
  }

  function renderDialogDue() {
    const text = todoDialogDue ? (todoDialogDue === todayKey() ? '今天' : fmtCN(todoDialogDue)) : '不设期限';
    $('#dialogDueHost').innerHTML =
      `<button class="chip-btn" type="button" id="dialogDueBtn" aria-haspopup="dialog" aria-expanded="false">
        ${icon('i-cal')}<span>${text}</span>
      </button>`;
    $('#dialogDueBtn').addEventListener('click', (e) => {
      openDuePicker(e.currentTarget, todoDialogDue, (next) => {
        todoDialogDue = next;
        renderDialogDue();
      }, 'dialog');
    });
  }

  let meetingPrefillDay = null;

  function openMeetingDialog(day = null) {
    meetingPrefillDay = day || S.ui.day || todayKey();
    $('#meetingTitle').value = '';
    $('#mtTitle').value = '';
    $('#mtDate').value = meetingPrefillDay;
    $('#mtStart').value = '10:00';
    $('#mtMinutes').value = '60';
    $('#mtPlace').value = '';
    $('#mtTitleHelp').textContent = '';
    $('#mtTitleHelp').classList.remove('is-error');
    $('#mtConflict').textContent = '';
    meetingDialog.showModal();
    $('#mtTitle').focus();
  }

  function meetingConflict(day, start, minutes, ignoreId) {
    const s = minutesOf(start);
    const e = s + minutes;
    return meetingsForDay(day).find((mt) => {
      if (mt.id === ignoreId) return false;
      const ms = minutesOf(mt.start);
      const me = ms + mt.minutes;
      return s < me && ms < e;
    });
  }

  /* ---------- 截止日期选择 ---------- */

  const duePop = $('#duePop');
  let dueAnchor = null;
  let dueValue = null;
  let dueOnPick = null;
  let dueMonth = { y: new Date().getFullYear(), m: new Date().getMonth() };

  function openDuePicker(anchor, value, onPick) {
    dueAnchor = anchor;
    dueValue = value;
    dueOnPick = onPick;
    const d = value ? parseKey(value) : new Date();
    dueMonth = { y: d.getFullYear(), m: d.getMonth() };
    duePop.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outsideDue, true);
    document.addEventListener('keydown', dueKeys, true);
    renderDue();
    positionDue();
    const first = duePop.querySelector('.due-chip');
    if (first) first.focus();
  }

  function closeDuePicker() {
    duePop.hidden = true;
    if (dueAnchor) dueAnchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outsideDue, true);
    document.removeEventListener('keydown', dueKeys, true);
    if (dueAnchor) dueAnchor.focus();
    dueAnchor = null;
  }

  function outsideDue(e) {
    if (!duePop.contains(e.target) && !dueAnchor?.contains(e.target)) closeDuePicker();
  }

  function dueKeys(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDuePicker();
    }
  }

  function positionDue() {
    if (!dueAnchor) return;
    const r = dueAnchor.getBoundingClientRect();
    const w = 268;
    const h = duePop.offsetHeight || 360;
    let left = Math.min(Math.max(12, r.left + r.width - w), window.innerWidth - w - 12);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    duePop.style.left = `${left}px`;
    duePop.style.top = `${top}px`;
  }

  function renderDue() {
    const quick = [
      { label: '今天', value: todayKey() },
      { label: '明天', value: shiftKey(todayKey(), 1) },
      { label: '本周日', value: shiftKey(startOfWeek(todayKey()), 6) },
      { label: '下周一', value: shiftKey(startOfWeek(todayKey()), 7) },
      { label: '不设期限', value: null }
    ];
    $('#dueQuick').innerHTML = quick
      .map(
        (q) =>
          `<button class="due-chip${dueValue === q.value ? ' is-on' : ''}" type="button" data-due="${q.value || ''}">${q.label}</button>`
      )
      .join('');

    $('#dueValue').textContent = dueValue
      ? `${fmtCN(dueValue)} ${weekday(dueValue)}，${relDay(dueValue)}`
      : '不设期限';

    $('#dueMonth').textContent = `${dueMonth.y}年${dueMonth.m + 1}月`;
    $('.due-week').innerHTML = ['一', '二', '三', '四', '五', '六', '日']
      .map((d) => `<span>${d}</span>`)
      .join('');

    const cells = [];
    const first = new Date(dueMonth.y, dueMonth.m, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(dueMonth.y, dueMonth.m, 1 - offset);
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = dateKey(d);
      cells.push({
        key,
        day: d.getDate(),
        out: d.getMonth() !== dueMonth.m,
        today: key === todayKey(),
        on: key === dueValue
      });
    }
    $('#dueGrid').innerHTML = cells
      .map(
        (c) =>
          `<button class="due-day${c.out ? ' is-out' : ''}${c.today ? ' is-today' : ''}${c.on ? ' is-on' : ''}" type="button" aria-label="${fmtCN(c.key)} ${weekday(c.key)}${c.today ? '，今天' : ''}" data-due="${c.key}" ${c.out ? 'disabled' : ''}>${c.day}</button>`
      )
      .join('');
  }

  function pickDue(value) {
    dueValue = value;
    if (dueOnPick) dueOnPick(value);
    closeDuePicker();
  }

  /* ---------- 撤销 ---------- */

  let undoTimer = null;
  let undoAction = null;

  function showUndo(text, action) {
    undoAction = action;
    $('#undoText').textContent = text;
    $('#undo').hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      $('#undo').hidden = true;
      undoAction = null;
    }, 8000);
  }

  function hideUndo() {
    $('#undo').hidden = true;
    clearTimeout(undoTimer);
    undoAction = null;
  }

  /* ---------- 数据操作 ---------- */

  function commit() {
    save();
    renderAll();
  }

  function addTodo(title, { due = null, cat = CATS[0], priority = 'mid' } = {}) {
    const t = {
      id: uid('td'),
      title: title.trim(),
      cat,
      priority,
      due,
      done: false,
      doneAt: null,
      created: new Date().toISOString()
    };
    if (!t.title) return null;
    S.todos.push(t);
    commit();
    return t;
  }

  function toggleTodo(id) {
    const t = S.todos.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.doneAt = t.done ? new Date().toISOString() : null;
    commit();
  }

  function deleteTodo(id) {
    const i = S.todos.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [t] = S.todos.splice(i, 1);
    commit();
    showUndo(`已删除「${t.title}」`, () => {
      S.todos.splice(i, 0, t);
      commit();
    });
  }

  function deleteMeeting(id) {
    const i = S.meetings.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [mt] = S.meetings.splice(i, 1);
    commit();
    showUndo(`已移除「${mt.title}」`, () => {
      S.meetings.splice(i, 0, mt);
      commit();
    });
  }

  function deleteNote(id) {
    const i = S.notes.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [n] = S.notes.splice(i, 1);
    S.ui.note = S.notes[0]?.id || null;
    commit();
    showUndo(`已删除「${n.title || '无标题笔记'}」`, () => {
      S.notes.splice(i, 0, n);
      S.ui.note = n.id;
      commit();
    });
  }

  function pushHistory(note) {
    note.history = note.history || [];
    const last = note.history[0];
    if (last && last.body === note.body && last.title === note.title) return;
    note.history.unshift({ at: new Date().toISOString(), title: note.title, body: note.body });
    note.history = note.history.slice(0, 6);
  }

  let noteTimer = null;

  function markNoteDirty() {
    setSaveState('未保存', true);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote({ silent: true }), 900);
  }

  function saveNote({ silent = false } = {}) {
    const note = currentNote();
    if (!note) return;
    note.title = $('#noteTitle').value;
    note.body = $('#noteBody').value;
    note.tags = $('#noteTags')
      .value.split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    note.updated = new Date().toISOString();
    pushHistory(note);
    save();

    const btn = $('#saveNote');
    btn.classList.add('is-loading');
    btn.disabled = true;
    setSaveState('保存中', true);
    setTimeout(() => {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      setSaveState('已保存');
      $('#noteTime').textContent = `最后编辑 ${relTime(note.updated)}`;
      $('#noteWords').textContent = `${wordCount(note.body)} 字`;
      $('#noteList').innerHTML = '';
      renderNotes();
      renderRecentNotes();
      renderHome();
      $('#footStatus').textContent = silent ? '' : '已保存到本机';
    }, 420);
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    $('#todoViews').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      S.ui.filter = b.dataset.filter;
      save();
      renderTodos();
    });

    $('#todoCats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      S.ui.cat = b.dataset.cat || null;
      save();
      renderTodos();
    });

    $('#newCat').addEventListener('click', () => {
      const btn = $('#newCat');
      if (btn.hidden) return;
      const wrap = document.createElement('div');
      wrap.className = 'cat-new';
      wrap.innerHTML = '<label class="visually-hidden" for="catInput">新分类名字</label><input class="input cat-input" id="catInput" placeholder="分类名字，回车保存" autocomplete="off">';
      btn.hidden = true;
      btn.after(wrap);
      const input = $('#catInput');
      input.focus();
      const close = () => {
        wrap.remove();
        btn.hidden = false;
        btn.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
          return;
        }
        if (e.key !== 'Enter') return;
        const clean = input.value.trim().slice(0, 6);
        if (!clean) {
          close();
          return;
        }
        if (!CATS.includes(clean)) {
          CATS.push(clean);
          S.cats = CATS.slice();
          save();
        }
        wrap.remove();
        btn.hidden = false;
        renderTodos();
        $('#newCat').focus();
      });
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (!wrap.contains(document.activeElement)) {
            wrap.remove();
            btn.hidden = false;
          }
        }, 120);
      });
    });

    $('#todoSearch').addEventListener('input', (e) => {
      S.ui.query = e.target.value;
      renderTodos();
    });

    $('#todoSort').addEventListener('change', (e) => {
      S.ui.sort = e.target.value;
      save();
      renderTodos();
    });

    $('#newTodoBtn').addEventListener('click', () => openTodoDialog());
    $('#emptyNewTodo').addEventListener('click', () => openTodoDialog());

    $('#todoForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'save') {
        const title = $('#tdTitle').value.trim();
        if (!title) {
          e.preventDefault();
          $('#tdTitle').setAttribute('aria-invalid', 'true');
          $('#tdTitleHelp').textContent = '写一句要做的事，保存后才会进列表。';
          $('#tdTitleHelp').classList.add('is-error');
          $('#tdTitle').focus();
        }
      }
    });

    $('#todoForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      if ($('#tdTitle').value.trim()) return;
      e.preventDefault();
      $('#tdTitle').setAttribute('aria-invalid', 'true');
      $('#tdTitleHelp').textContent = '写一句待办内容再保存。';
      $('#tdTitleHelp').classList.add('is-error');
      $('#tdTitle').focus();
    });

    todoDialog.addEventListener('close', () => {
      if (todoDialog.returnValue !== 'save') return;
      const title = $('#tdTitle').value.trim();
      const priority = $('#tdPriority').value;
      const cat = $('#tdCategory').value;
      const due = todoDialogDue;
      if (editingTodo) {
        Object.assign(editingTodo, { title, priority, cat, due });
        commit();
      } else {
        addTodo(title, { due, cat, priority });
      }
      editingTodo = null;
    });

    $('#newMeeting').addEventListener('click', () => openMeetingDialog());

    const checkConflict = () => {
      const day = $('#mtDate').value;
      const start = $('#mtStart').value;
      const minutes = Number($('#mtMinutes').value);
      if (!day || !start) return;
      const hit = meetingConflict(day, start, minutes);
      $('#mtConflict').textContent = hit
        ? `这个时段和「${hit.title}」重叠，仍然可以排进来。`
        : '';
    };
    ['mtDate', 'mtStart', 'mtMinutes'].forEach((id) => {
      $('#' + id).addEventListener('input', checkConflict);
      $('#' + id).addEventListener('change', checkConflict);
    });

    $('#mtTitle').addEventListener('input', () => {
      $('#mtTitle').removeAttribute('aria-invalid');
      $('#mtTitleHelp').textContent = '';
      $('#mtTitleHelp').classList.remove('is-error');
    });

    $('#tdTitle').addEventListener('input', () => {
      $('#tdTitle').removeAttribute('aria-invalid');
      $('#tdTitleHelp').textContent = '';
      $('#tdTitleHelp').classList.remove('is-error');
    });
    $('#meetingForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'save') {
        const title = $('#mtTitle').value.trim();
        if (!title) {
          e.preventDefault();
          $('#mtTitle').setAttribute('aria-invalid', 'true');
          $('#mtTitleHelp').textContent = '给会议起个名字，方便在月历里认出来。';
          $('#mtTitleHelp').classList.add('is-error');
          $('#mtTitle').focus();
        }
      }
    });

    $('#meetingForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      const title = $('#mtTitle').value.trim();
      const day = $('#mtDate').value;
      const start = $('#mtStart').value;
      const message = !title
        ? '给这场会写个主题再排。'
        : !day || !start
          ? '日期和开始时间都要填。'
          : '';
      if (!message) return;
      e.preventDefault();
      $('#mtTitle').setAttribute('aria-invalid', 'true');
      $('#mtTitleHelp').textContent = message;
      $('#mtTitleHelp').classList.add('is-error');
      (!title ? $('#mtTitle') : !day ? $('#mtDate') : $('#mtStart')).focus();
    });

    meetingDialog.addEventListener('close', () => {
      if (meetingDialog.returnValue !== 'save') return;
      const title = $('#mtTitle').value.trim();
      const day = $('#mtDate').value;
      const start = $('#mtStart').value;
      const minutes = Number($('#mtMinutes').value);
      const place = $('#mtPlace').value.trim();
      if (!title || !day || !start) return;
      S.meetings.push({ id: uid('mt'), title, date: day, start, minutes, place });
      S.ui.day = day;
      S.ui.month = { y: parseKey(day).getFullYear(), m: parseKey(day).getMonth() };
      S.ui.meetNav = 'month';
      commit();
      setView('meetings');
    });

    $('#prevMonth').addEventListener('click', () => {
      const m = S.ui.month.m - 1;
      S.ui.month = m < 0 ? { y: S.ui.month.y - 1, m: 11 } : { y: S.ui.month.y, m };
      save();
      renderMeetings();
    });
    $('#nextMonth').addEventListener('click', () => {
      const m = S.ui.month.m + 1;
      S.ui.month = m > 11 ? { y: S.ui.month.y + 1, m: 0 } : { y: S.ui.month.y, m };
      save();
      renderMeetings();
    });
    $('#todayBtn').addEventListener('click', () => {
      const now = new Date();
      S.ui.month = { y: now.getFullYear(), m: now.getMonth() };
      S.ui.day = todayKey();
      S.ui.meetNav = 'today';
      save();
      renderMeetings();
    });

    $('#meetNav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-meet-nav]');
      if (!b) return;
      const nav = b.dataset.meetNav;
      S.ui.meetNav = nav;
      if (nav !== 'month') {
        const day = nav === 'today' ? todayKey() : shiftKey(todayKey(), 1);
        S.ui.day = day;
        S.ui.month = { y: parseKey(day).getFullYear(), m: parseKey(day).getMonth() };
      }
      save();
      renderMeetings();
    });

    $('#newNote').addEventListener('click', () => {
      const note = {
        id: uid('nt'),
        title: '',
        tags: [],
        body: '',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        starred: false,
        history: []
      };
      S.notes.unshift(note);
      S.ui.note = note.id;
      S.ui.mode = 'edit';
      commit();
      $('#noteTitle').focus();
    });

    $('#emptyNewNote').addEventListener('click', () => $('#newNote').click());

    $('#noteSearch').addEventListener('input', () => renderNotes());

    $('#noteTitle').addEventListener('input', () => {
      markNoteDirty();
      const note = currentNote();
      if (!note) return;
      $('#noteTime').textContent = '正在编辑';
    });

    $('#noteBody').addEventListener('input', () => {
      const note = currentNote();
      if (!note) return;
      $('#notePreview').innerHTML = renderMarkdown($('#noteBody').value);
      $('#noteWords').textContent = `${wordCount($('#noteBody').value)} 字`;
      markNoteDirty();
    });

    $('#noteTags').addEventListener('input', () => markNoteDirty());

    $('#notePreview').addEventListener('click', () => {
      if (!$('#writeArea').dataset.mode.includes('live')) return;
      setMode('edit');
      $('#noteBody').focus();
    });

    $$('.mode').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = $$('.mode');
        const i = tabs.indexOf(b);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        e.preventDefault();
        setMode(next.dataset.mode);
        next.focus();
      });
    });

    $('#starNote').addEventListener('click', () => {
      const note = currentNote();
      if (!note) return;
      note.starred = !note.starred;
      $('#starNote').setAttribute('aria-pressed', String(note.starred));
      save();
    });

    $('#saveNote').addEventListener('click', () => {
      clearTimeout(noteTimer);
      saveNote();
    });

    $('#deleteNote').addEventListener('click', () => {
      const note = currentNote();
      if (!note) return;
      deleteNote(note.id);
    });

    $('#todosFromNote').addEventListener('click', () => {
      const note = currentNote();
      if (!note) return;
      const body = $('#noteBody').value;
      const items = Array.from(body.matchAll(/^-\s*\[ \]\s*(.+)$/gm)).map((m) => m[1].trim());
      if (!items.length) {
        $('#footStatus').textContent = '正文里没有未勾选的待办项。写一行「- [ ] 要做的事」再试。';
        return;
      }
      let added = 0;
      items.forEach((title) => {
        const exists = S.todos.some((t) => t.title === title && !t.done);
        if (exists) return;
        addTodo(title, { due: todayKey(), cat: note.tags[0] || CATS[0] });
        added += 1;
      });
      const next = body.replace(/^-\s*\[ \]\s*(.+)$/gm, '- [x] $1');
      $('#noteBody').value = next;
      note.body = next;
      $('#notePreview').innerHTML = renderMarkdown(next);
      save();
      renderTodos();
      renderHome();
      setSaveState('已保存');
      $('#footStatus').textContent = added
        ? `已加入 ${added} 条今日待办，勾选项已标为完成。`
        : '这些条目已经在待办里了，没有重复添加。';
    });

    $('#noteHistory').addEventListener('click', () => {
      const note = currentNote();
      if (!note) return;
      const items = (note.history || []).slice(0, 6);
      $('#historyList').innerHTML = items.length
        ? items
            .map(
              (h) =>
                `<li class="history-row"><time>${new Date(h.at).toLocaleString('zh-CN', { hour12: false })}</time>
                  <div><p class="history-title">${esc(h.title || '无标题笔记')}</p>
                  <p class="mini-meta">${esc(noteText(h.body).slice(0, 60))}</p></div></li>`
            )
            .join('')
        : '<li class="history-row"><time>—</time><p class="mini-meta">还没有历史版本。每次保存会留下一份快照。</p></li>';
      historyDialog.showModal();
    });

    $('#closeHistory').addEventListener('click', () => historyDialog.close());
    $('#closeHistory2').addEventListener('click', () => historyDialog.close());

    $('#homeDue').addEventListener('click', (e) => {
      openDuePicker(e.currentTarget, S.ui.homeDue, (next) => {
        S.ui.homeDue = next;
        save();
        $('#homeDueText').textContent = next ? (next === todayKey() ? '今天截止' : `${fmtCN(next)} 截止`) : '不设期限';
      });
    });

    $('#homeAddBtn').addEventListener('click', submitHomeTodo);
    $('#homeAdd').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitHomeTodo();
      }
    });

    $('#homeAddFocus').addEventListener('click', () => {
      $('#homeAdd').focus();
      $('#homeAdd').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    $('#resetDemo').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1';
        btn.textContent = '再点一次，清空并恢复样本';
        setTimeout(() => {
          delete btn.dataset.armed;
          btn.textContent = '重置演示数据';
        }, 3000);
        return;
      }
      localStorage.removeItem(LS_KEY);
      S = seed();
      CATS = ['工作', '个人', '学习'];
      hideUndo();
      renderAll();
      setView('home');
      btn.textContent = '已恢复样本';
      setTimeout(() => {
        btn.textContent = '重置演示数据';
        delete btn.dataset.armed;
      }, 1200);
    });

    $('#undoBtn').addEventListener('click', () => {
      if (undoAction) undoAction();
      hideUndo();
    });

    $('#dueQuick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-due]');
      if (!b) return;
      pickDue(b.dataset.due || null);
    });

    $('#dueGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-due]');
      if (!b) return;
      pickDue(b.dataset.due);
    });

    $('#dueClose').addEventListener('click', closeDuePicker);
    $('#duePrev').addEventListener('click', () => {
      const m = dueMonth.m - 1;
      dueMonth = m < 0 ? { y: dueMonth.y - 1, m: 11 } : { y: dueMonth.y, m };
      renderDue();
    });
    $('#dueNext').addEventListener('click', () => {
      const m = dueMonth.m + 1;
      dueMonth = m > 11 ? { y: dueMonth.y + 1, m: 0 } : { y: dueMonth.y, m };
      renderDue();
    });

    /* 面板与全局委托 */
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) {
        setView(tab.dataset.view);
        return;
      }
      const go = e.target.closest('[data-goto]');
      if (go) {
        setView(go.dataset.goto);
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const todo = S.todos.find((t) => t.id === edit.dataset.edit);
        if (todo) openTodoDialog(todo);
        return;
      }
      const openN = e.target.closest('[data-open-note]');
      if (openN) {
        S.ui.mode = S.ui.mode || 'live';
        openNote(openN.dataset.openNote);
        setView('notes');
        return;
      }
      const slip = e.target.closest('[data-meeting]');
      if (slip) {
        S.ui.day = todayKey();
        setView('meetings');
        return;
      }
      const cell = e.target.closest('[data-day]');
      if (cell) {
        const day = cell.dataset.day;
        S.ui.day = day;
        const d = parseKey(day);
        S.ui.month = { y: d.getFullYear(), m: d.getMonth() };
        S.ui.meetNav = 'month';
        const inMeet = cell.closest('#view-meetings');
        if (!inMeet) {
          S.ui.view = 'meetings';
        }
        save();
        if (!inMeet) setView('meetings');
        else {
          renderMeetings();
        }
        return;
      }
      const newMeet = e.target.closest('[data-new-meeting]');
      if (newMeet) {
        openMeetingDialog(newMeet.dataset.newMeeting);
        return;
      }
      const delMeet = e.target.closest('[data-del-meeting]');
      if (delMeet) {
        deleteMeeting(delMeet.dataset.delMeeting);
        return;
      }
    });

    document.addEventListener('change', (e) => {
      const check = e.target.closest('[data-check]');
      if (check) toggleTodo(check.dataset.check);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tabs = $$('.tab');
      const active = document.activeElement;
      if (!tabs.includes(active)) return;
      e.preventDefault();
      const i = tabs.indexOf(active);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      setView(next.dataset.view);
    });

    $('#todoList').addEventListener('keydown', (e) => {
      if (e.key !== 'Delete') return;
      const row = e.target.closest('[data-row]');
      if (!row) return;
      deleteTodo(row.dataset.row);
    });
  }

  function submitHomeTodo() {
    const input = $('#homeAdd');
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    addTodo(title, { due: S.ui.homeDue || null, cat: CATS[0], priority: 'mid' });
    input.value = '';
    input.focus();
  }

  function setMode(mode) {
    S.ui.mode = mode;
    save();
    const area = $('#writeArea');
    area.dataset.mode = mode;
    $$('.mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (mode === 'preview' || mode === 'live') {
      $('#notePreview').innerHTML = renderMarkdown($('#noteBody').value);
    }
    if (mode !== 'preview') $('#noteBody').focus();
  }

  /* ---------- 启动 ---------- */

  async function boot() {
    bind();
    const qs = new URLSearchParams(location.search);
    const view = qs.get('view');
    if (['home', 'todos', 'meetings', 'notes'].includes(view)) S.ui.view = view;
    if (qs.has('embed')) document.body.classList.add('embed');
    try {
      await hydrate();
    } catch (e) {
      console.error('[tidywork] hydrate failed', e);
    }
    if (!S.notes.find((n) => n.id === S.ui.note)) S.ui.note = S.notes[0]?.id || null;
    renderAll();
    setView(S.ui.view);
  }

  boot();
})();
