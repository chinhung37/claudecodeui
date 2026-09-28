'use strict';

// Agent Board 前端：純 JS，不需要編譯。
// 每張卡片獨立渲染；正在編輯的卡片不會被即時更新蓋掉。

const $ = (sel, root = document) => root.querySelector(sel);

const STATUS = {
  working: '工作中',
  waiting: '等你回覆',
  attention: '需要授權',
  idle: '閒置',
  ended: '已結束',
  stale: '可能中斷',
};
const STATUS_ORDER = { attention: 0, stale: 1, waiting: 2, working: 3, idle: 4, ended: 5 };
const STALE_MS = 10 * 60 * 1000;

let state = { agents: [] };
const ui = loadUi();
const drafts = new Map(); // `${cardId}:${field}` -> 草稿文字
const rendered = new Map(); // cardId -> 上次渲染的 html
let editing = null; // { id, field: 'goal' | 'name' | 'todo', todoId }

function loadUi() {
  const base = { filter: 'active', q: '', showArchived: false, openDone: [], openMirror: [] };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem('agent-board-ui') || '{}') };
  } catch {
    return base;
  }
}

function saveUi() {
  try {
    localStorage.setItem('agent-board-ui', JSON.stringify(ui));
  } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Agent-Board': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}

async function act(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(`失敗：${err.message}`);
  }
}

const enc = encodeURIComponent;

// ---- 狀態推導 ----

function effectiveStatus(a) {
  if (a.status === 'working' && Date.now() - Date.parse(a.lastEventAt) > STALE_MS) return 'stale';
  return a.status || 'idle';
}

function relTime(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return '剛剛';
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
}

function clock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

function visibleAgents() {
  const q = ui.q.trim().toLowerCase();
  return state.agents
    .filter((a) => ui.showArchived || !a.archived)
    .filter((a) => {
      const s = effectiveStatus(a);
      if (ui.filter === 'active') return s !== 'ended' || a.manual;
      if (ui.filter === 'needs') return s === 'waiting' || s === 'attention' || s === 'stale';
      return true;
    })
    .filter((a) => {
      if (!q) return true;
      const hay = [a.name, a.project, a.cwd, a.goal, a.focus, a.id, a.lastPrompt, ...a.todos.map((t) => t.text)]
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const d = STATUS_ORDER[effectiveStatus(a)] - STATUS_ORDER[effectiveStatus(b)];
      if (d) return d;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

// ---- 卡片 HTML ----

function isEditing(id, field, todoId) {
  return editing && editing.id === id && editing.field === field && (todoId === undefined || editing.todoId === todoId);
}

function draft(id, field, fallback = '') {
  const k = `${id}:${field}`;
  return drafts.has(k) ? drafts.get(k) : fallback;
}

function headHTML(a, s) {
  const title = a.name || a.project || '(未命名)';
  const nameHTML = isEditing(a.id, 'name')
    ? `<input type="text" class="edit-input" data-field="name" data-id="${esc(a.id)}" value="${esc(draft(a.id, 'name', a.name || a.project))}" />`
    : `<h2 class="name" data-action="edit-name" title="點一下改名稱">${esc(title)}</h2>`;
  return `
    <div class="card-head">
      <span class="status s-${s}">${STATUS[s] || s}</span>
      ${nameHTML}
      ${a.project && a.name ? `<span class="tag" title="${esc(a.cwd)}">${esc(a.project)}</span>` : ''}
      ${a.manual ? '<span class="tag">手動卡片</span>' : ''}
      <button class="idchip" data-action="copy-id" title="複製 board_id：${esc(a.id)}">${esc(a.manual ? a.id : a.id.slice(0, 8))}</button>
      <span class="time" data-ts="${esc(a.lastEventAt)}"></span>
    </div>`;
}

function goalHTML(a) {
  if (isEditing(a.id, 'goal')) {
    return `
      <div class="editor">
        <textarea rows="3" class="edit-input" data-field="goal" data-id="${esc(a.id)}" placeholder="這個對話要替你達成的目標">${esc(draft(a.id, 'goal', a.goal))}</textarea>
        <div class="row">
          <button class="primary" data-action="save-goal">儲存（Ctrl+Enter）</button>
          <button data-action="cancel-edit">取消</button>
        </div>
      </div>`;
  }
  const by = a.goal && a.goalBy ? `<span class="by">${a.goalBy === 'user' ? '你設定' : 'agent 設定'}</span>` : '';
  const body = a.goal
    ? `<div class="goal" data-action="edit-goal" title="點一下編輯目標">${esc(a.goal)}</div>`
    : `<div class="goal empty-goal" data-action="edit-goal">尚未設定目標（agent 下次收到訊息時會被提醒設定，或點這裡自己寫）${
        a.firstPrompt ? `<br />第一句提示：「${esc(a.firstPrompt.slice(0, 160))}」` : ''
      }</div>`;
  return `<div><p class="section-label">目標 ${by}</p>${body}</div>`;
}

function nowHTML(a, s) {
  const parts = [];
  if (s === 'attention' && a.statusDetail) parts.push(`<div class="detail">⚠ ${esc(a.statusDetail)}</div>`);
  if (s === 'stale') parts.push(`<div class="detail">超過 10 分鐘沒有任何動靜，對話可能已經關掉或卡住</div>`);
  if (a.focus) parts.push(`<div><b>焦點：</b>${esc(a.focus)}</div>`);
  if (a.activity) parts.push(`<div class="activity">${esc(a.activity)} <span class="time" data-ts="${esc(a.activityAt)}"></span></div>`);
  if (!parts.length) {
    if (a.manual) parts.push('<div>等待 agent 接手。在 Claude Code 對話裡請它用 <code>board_adopt</code> 接手這張卡片。</div>');
    else if (s === 'ended') parts.push(`<div>對話已結束${a.statusDetail ? `（${esc(a.statusDetail)}）` : ''}</div>`);
    else if (s === 'waiting') parts.push(`<div>這一輪做完了，等你回覆${a.statusDetail ? `（${esc(a.statusDetail)}）` : ''}</div>`);
    else parts.push('<div>—</div>');
  }
  const prompt = a.lastPrompt
    ? `<details><summary>你最後說的話</summary><div class="prompt">${esc(a.lastPrompt)}</div></details>`
    : '';
  return `<div><p class="section-label">目前在做</p><div class="now">${parts.join('')}</div>${prompt}</div>`;
}

function todoItemHTML(a, t) {
  const editingThis = isEditing(a.id, 'todo', t.id);
  const text = editingThis
    ? `<input type="text" class="edit-input" data-field="todo" data-id="${esc(a.id)}" data-todo="${esc(t.id)}" value="${esc(draft(a.id, `todo-${t.id}`, t.text))}" />`
    : `<span class="todo-text" data-action="edit-todo" title="點一下編輯"><span class="todo-id">${esc(t.id)}</span>${esc(t.text)}${
        t.by === 'user' ? ' <span class="by">你</span>' : ''
      }</span>`;
  const draggable = t.status !== 'done' && !editingThis;
  return `
    <li class="todo t-${t.status}" data-todo="${esc(t.id)}" ${draggable ? 'draggable="true"' : ''}>
      <span class="handle" title="拖曳調整優先順序">${draggable ? '⋮⋮' : ''}</span>
      <input type="checkbox" data-action="toggle-done" ${t.status === 'done' ? 'checked' : ''} title="完成" />
      ${text}
      <span class="todo-actions">
        ${
          t.status !== 'done'
            ? `<button class="icon ${t.status === 'in_progress' ? 'on' : ''}" data-action="toggle-progress" title="${
                t.status === 'in_progress' ? '取消「進行中」' : '標成進行中'
              }">▶</button>`
            : ''
        }
        <button class="icon" data-action="delete-todo" title="刪除">✕</button>
      </span>
    </li>`;
}

function todosHTML(a) {
  const open = a.todos.filter((t) => t.status !== 'done');
  const done = a.todos.filter((t) => t.status === 'done');
  const doneOpen = ui.openDone.includes(a.id);
  return `
    <div>
      <p class="section-label">待辦（未完成 ${open.length}）</p>
      <ul class="todos" data-list="open">${open.map((t) => todoItemHTML(a, t)).join('') || '<li class="hint">目前沒有未完成的待辦</li>'}</ul>
      ${
        done.length
          ? `<details data-action="toggle-done-list" ${doneOpen ? 'open' : ''}><summary>已完成 ${done.length} 項</summary>
              <ul class="todos">${done.map((t) => todoItemHTML(a, t)).join('')}</ul></details>`
          : ''
      }
      <div class="add-row">
        <input type="text" class="draft-input" data-field="newTodo" data-id="${esc(a.id)}" placeholder="新增待辦，按 Enter" value="${esc(draft(a.id, 'newTodo'))}" />
        <button data-action="add-todo">新增</button>
      </div>
    </div>`;
}

const MIRROR_MARK = { completed: '☑', done: '☑', in_progress: '▶', pending: '☐' };

function mirrorHTML(a) {
  if (!a.claudeTodos || !a.claudeTodos.length) return '';
  const openMirror = ui.openMirror.includes(a.id);
  const active = a.claudeTodos.filter((t) => t.status !== 'completed' && t.status !== 'done').length;
  return `
    <details data-action="toggle-mirror" ${openMirror ? 'open' : ''}>
      <summary>Claude 內建待辦（唯讀鏡像，未完成 ${active} / ${a.claudeTodos.length}）</summary>
      <ul class="mirror">${a.claudeTodos
        .map((t) => `<li>${MIRROR_MARK[t.status] || '☐'} ${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
        .join('')}</ul>
    </details>`;
}

function notesHTML(a) {
  const pending = (a.changeLog || []).filter((c) => c.rev > a.seenRev).length;
  const items = a.notes
    .slice(-6)
    .map(
      (n) => `
      <li class="note">
        <span class="body">${esc(n.text)}</span>
        <span class="meta">${n.from === 'user' ? '你' : 'agent ' + esc(n.from.slice(0, 8))} · ${
          n.deliveredAt ? `已送達 ${clock(n.deliveredAt)}` : '<span class="pending-flag">等待送達</span>'
        }</span>
        <button class="icon" data-action="delete-note" data-note="${esc(n.id)}" title="刪除留言">✕</button>
      </li>`
    )
    .join('');
  return `
    <div>
      <p class="section-label">給 agent 的留言 ${
        pending ? `<span class="pending-flag">${pending} 項變更等 agent 下次讀取</span>` : ''
      }</p>
      ${items ? `<ul class="notes">${items}</ul>` : ''}
      <div class="add-row">
        <input type="text" class="draft-input" data-field="newNote" data-id="${esc(a.id)}" placeholder="例如：先別動資料庫 schema，按 Enter 送出" value="${esc(draft(a.id, 'newNote'))}" />
        <button data-action="add-note">留言</button>
      </div>
    </div>`;
}

function footHTML(a) {
  const candidates = state.agents.filter(
    (o) => o.id !== a.id && !o.mergedInto && (o.goal || o.todos.some((t) => t.status !== 'done'))
  );
  const adopt = candidates.length
    ? `<div class="adopt">
         <select data-role="adopt-from" aria-label="接續自哪張卡片" title="把另一張卡片的目標與待辦接到這張">
           <option value="">接續自…</option>
           ${candidates
             .map((o) => `<option value="${esc(o.id)}">${esc((o.name || o.project || o.id.slice(0, 8)) + '：' + (o.goal || '(無目標)').slice(0, 40))}</option>`)
             .join('')}
         </select>
         <button data-action="adopt">接續</button>
       </div>`
    : '';
  return `
    <div class="card-foot">
      ${adopt}
      <div class="foot-actions">
        ${a.manual ? '<button data-action="copy-adopt" title="複製一段話，貼到 Claude Code 對話讓 agent 接手">複製接手指令</button>' : ''}
        <button data-action="archive">${a.archived ? '取消封存' : '封存'}</button>
        <button class="danger" data-action="delete-card">刪除</button>
      </div>
    </div>`;
}

function cardHTML(a) {
  const s = effectiveStatus(a);
  return `
    <article class="card s-${s} ${a.archived ? 'archived' : ''}" data-id="${esc(a.id)}">
      ${headHTML(a, s)}
      ${goalHTML(a)}
      ${nowHTML(a, s)}
      ${todosHTML(a)}
      ${mirrorHTML(a)}
      ${notesHTML(a)}
      ${footHTML(a)}
    </article>`;
}

// ---- 渲染 ----

function updateTimes(root = document) {
  for (const el of root.querySelectorAll('[data-ts]')) el.textContent = relTime(el.dataset.ts);
}

function renderCounters() {
  const c = { working: 0, waiting: 0, attention: 0, stale: 0 };
  for (const a of state.agents) {
    if (a.archived) continue;
    const s = effectiveStatus(a);
    if (s in c) c[s] += 1;
  }
  $('#counters').innerHTML = [
    ['working', '工作中'],
    ['waiting', '等你回覆'],
    ['attention', '需要授權'],
    ['stale', '可能中斷'],
  ]
    .filter(([k]) => c[k] || k === 'working' || k === 'waiting')
    .map(([k, label]) => `<span class="counter">${label} <b>${c[k]}</b></span>`)
    .join('');
  const waiting = c.waiting + c.attention;
  document.title = waiting ? `(${waiting}) Agent Board` : 'Agent Board';
}

// 中文輸入法選字中、或下拉選單開著時，不要重畫那張卡片（會打斷輸入）。
// 其他情況照常重畫，並把焦點與游標位置還原（輸入框內容存在 drafts 裡）。
let composing = false;
let rendering = false;
document.addEventListener('compositionstart', () => (composing = true));
document.addEventListener('compositionend', () => {
  composing = false;
  setTimeout(() => render(), 0);
});

function isBusy(el) {
  const active = document.activeElement;
  if (!el || !active || !el.contains(active)) return false;
  return composing || active.tagName === 'SELECT';
}

function captureFocus(el) {
  const active = document.activeElement;
  if (!el || !active || !el.contains(active) || !active.dataset || !active.dataset.field) return null;
  return {
    field: active.dataset.field,
    todo: active.dataset.todo,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreFocus(el, saved) {
  let input = null;
  if (saved) {
    const sel = `[data-field="${saved.field}"]${saved.todo ? `[data-todo="${CSS.escape(saved.todo)}"]` : ''}`;
    input = el.querySelector(sel);
  }
  if (!input) input = el.querySelector('.edit-input');
  if (!input) return;
  input.focus();
  if (input.setSelectionRange) {
    const end = input.value.length;
    const start = saved && saved.start != null ? Math.min(saved.start, end) : end;
    const stop = saved && saved.end != null ? Math.min(saved.end, end) : end;
    input.setSelectionRange(start, stop);
  }
}

function render(forceId) {
  renderCounters();
  const grid = $('#grid');
  const list = visibleAgents();
  const ids = new Set(list.map((a) => a.id));

  for (const el of [...grid.children]) {
    if (!ids.has(el.dataset.id) && !isBusy(el)) {
      rendered.delete(el.dataset.id);
      el.remove();
    }
  }

  let prev = null;
  for (const a of list) {
    const html = cardHTML(a);
    let el = grid.querySelector(`:scope > [data-id="${CSS.escape(a.id)}"]`);
    const busy = a.id !== forceId && isBusy(el);
    if (!el || (rendered.get(a.id) !== html && !busy)) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      const saved = captureFocus(el);
      rendering = true;
      try {
        if (el) el.replaceWith(fresh);
      } finally {
        rendering = false;
      }
      el = fresh;
      rendered.set(a.id, html);
      updateTimes(el);
      if (saved || el.querySelector('.edit-input')) restoreFocus(el, saved);
    }
    // 調整順序（只有真的不對時才搬，避免搶走焦點）
    const want = prev ? prev.nextElementSibling : grid.firstElementChild;
    if (want !== el && !busy) {
      if (prev) prev.after(el);
      else grid.prepend(el);
    }
    prev = el;
  }
  $('#empty').hidden = state.agents.length > 0;
}

// ---- 事件 ----

function cardOf(el) {
  const card = el.closest('.card');
  return card ? state.agents.find((a) => a.id === card.dataset.id) : null;
}

function todoOf(el, a) {
  const li = el.closest('[data-todo]');
  return li && a ? a.todos.find((t) => t.id === li.dataset.todo) : null;
}

function startEdit(id, field, todoId, initial) {
  editing = { id, field, todoId };
  const key = field === 'todo' ? `${id}:todo-${todoId}` : `${id}:${field}`;
  drafts.set(key, initial);
  rendered.delete(id);
  render(id);
}

function endEdit(id) {
  if (editing) {
    const key = editing.field === 'todo' ? `${editing.id}:todo-${editing.todoId}` : `${editing.id}:${editing.field}`;
    drafts.delete(key);
  }
  editing = null;
  rendered.delete(id);
  render(id);
}

async function saveEdit(id) {
  if (!editing || editing.id !== id) return;
  const { field, todoId } = editing;
  const key = field === 'todo' ? `${id}:todo-${todoId}` : `${id}:${field}`;
  const value = (drafts.get(key) ?? '').trim();
  const a = state.agents.find((x) => x.id === id);
  editing = null;
  if (a) {
    if (field === 'goal' && value !== a.goal) await act(() => api('PATCH', `/api/agents/${enc(id)}`, { goal: value }));
    if (field === 'name' && value !== (a.name || a.project)) await act(() => api('PATCH', `/api/agents/${enc(id)}`, { name: value }));
    if (field === 'todo') {
      const t = a.todos.find((x) => x.id === todoId);
      if (t && value && value !== t.text) {
        await act(() => api('PATCH', `/api/agents/${enc(id)}/todos/${enc(todoId)}`, { text: value }));
      }
    }
  }
  drafts.delete(key);
  rendered.delete(id);
  render(id);
}

async function submitDraft(a, field) {
  const key = `${a.id}:${field}`;
  const text = (drafts.get(key) || '').trim();
  if (!text) return;
  const path = field === 'newTodo' ? 'todos' : 'notes';
  const ok = await act(() => api('POST', `/api/agents/${enc(a.id)}/${path}`, { text }));
  if (ok) {
    drafts.delete(key);
    const input = document.querySelector(`.card[data-id="${CSS.escape(a.id)}"] [data-field="${field}"]`);
    if (input) input.value = '';
  }
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    window.prompt('複製下面這段文字', text);
  }
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'toggle-done-list' || action === 'toggle-mirror') return; // 由 toggle 事件處理
  const a = cardOf(target);
  if (!a) return;
  const t = todoOf(target, a);
  const base = `/api/agents/${enc(a.id)}`;

  switch (action) {
    case 'edit-goal':
      return startEdit(a.id, 'goal', undefined, a.goal);
    case 'edit-name':
      return startEdit(a.id, 'name', undefined, a.name || a.project);
    case 'edit-todo':
      return startEdit(a.id, 'todo', t.id, t.text);
    case 'save-goal':
      return saveEdit(a.id);
    case 'cancel-edit':
      return endEdit(a.id);
    case 'toggle-done':
      return act(() => api('PATCH', `${base}/todos/${enc(t.id)}`, { status: target.checked ? 'done' : 'pending' }));
    case 'toggle-progress':
      return act(() => api('PATCH', `${base}/todos/${enc(t.id)}`, { status: t.status === 'in_progress' ? 'pending' : 'in_progress' }));
    case 'delete-todo':
      return act(() => api('DELETE', `${base}/todos/${enc(t.id)}`));
    case 'add-todo':
      return submitDraft(a, 'newTodo');
    case 'add-note':
      return submitDraft(a, 'newNote');
    case 'delete-note':
      return act(() => api('DELETE', `${base}/notes/${enc(target.dataset.note)}`));
    case 'copy-id':
      return copy(a.id, `已複製 board_id：${a.id}`);
    case 'copy-adopt':
      return copy(
        `請用 board_adopt 把看板卡片 ${a.id} 接到你自己的看板卡片上，然後依照上面的目標與待辦開始工作。`,
        '已複製，貼到 Claude Code 對話裡即可'
      );
    case 'archive':
      return act(() => api('PATCH', base, { archived: !a.archived }));
    case 'delete-card':
      if (confirm(`確定刪除「${a.name || a.project || a.id.slice(0, 8)}」這張卡片？（對話本身不受影響）`)) {
        return act(() => api('DELETE', base));
      }
      return;
    case 'adopt': {
      const sel = target.parentElement.querySelector('[data-role="adopt-from"]');
      const from = sel && sel.value;
      if (!from) return toast('先選擇要接續哪張卡片');
      const src = state.agents.find((o) => o.id === from);
      if (confirm(`把「${src.goal || src.name || from.slice(0, 8)}」的目標與待辦接到這張卡片？原卡片會被封存。`)) {
        return act(() => api('POST', `${base}/adopt`, { from }));
      }
      return;
    }
  }
});

document.addEventListener(
  'toggle',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement)) return;
    const a = cardOf(el);
    if (!a) return;
    const key = el.dataset.action === 'toggle-done-list' ? 'openDone' : el.dataset.action === 'toggle-mirror' ? 'openMirror' : null;
    if (!key) return;
    const set = new Set(ui[key]);
    if (el.open) set.add(a.id);
    else set.delete(a.id);
    ui[key] = [...set];
    saveUi();
    rendered.delete(a.id);
  },
  true
);

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.field || !el.dataset.id) return;
  const f = el.dataset.field;
  const key = f === 'todo' ? `${el.dataset.id}:todo-${el.dataset.todo}` : `${el.dataset.id}:${f}`;
  drafts.set(key, el.value);
});

document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.field) return;
  const a = cardOf(el);
  if (!a) return;
  const f = el.dataset.field;
  if (e.key === 'Escape' && el.classList.contains('edit-input')) {
    e.preventDefault();
    return endEdit(a.id);
  }
  if (e.key !== 'Enter' || e.isComposing) return; // 中文輸入法選字時的 Enter 不送出
  if (f === 'goal') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      saveEdit(a.id);
    }
    return;
  }
  e.preventDefault();
  if (f === 'name' || f === 'todo') saveEdit(a.id);
  else if (f === 'newTodo' || f === 'newNote') submitDraft(a, f);
});

document.addEventListener('focusout', (e) => {
  if (rendering) return; // 重畫時舊元素被移除造成的 focusout，不算使用者離開
  const el = e.target;
  const a = el.closest && cardOf(el);
  if (!a) return;
  if (el.classList.contains('edit-input')) {
    // 點到同一張卡片的「儲存/取消」按鈕時交給 click 處理
    const next = e.relatedTarget;
    if (next && el.closest('.card').contains(next) && next.dataset && next.dataset.action) return;
    const f = el.dataset.field;
    if (f === 'name' || f === 'todo') return saveEdit(a.id);
  }
  // 離開輸入框後補上期間累積的即時更新
  setTimeout(() => render(), 0);
});

// 拖曳調整待辦順序
let dragInfo = null;
document.addEventListener('dragstart', (e) => {
  const li = e.target.closest && e.target.closest('.todo[draggable="true"]');
  if (!li) return;
  const a = cardOf(li);
  dragInfo = { id: a.id, todo: li.dataset.todo };
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.todo);
});
document.addEventListener('dragover', (e) => {
  if (!dragInfo) return;
  const li = e.target.closest && e.target.closest('.todo');
  if (!li || cardOf(li)?.id !== dragInfo.id) return;
  e.preventDefault();
  document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  li.classList.add('drop-target');
});
document.addEventListener('drop', (e) => {
  if (!dragInfo) return;
  const li = e.target.closest && e.target.closest('.todo');
  const a = li && cardOf(li);
  if (!a || a.id !== dragInfo.id) return;
  e.preventDefault();
  if (li.dataset.todo === dragInfo.todo) return;
  const order = a.todos.map((t) => t.id).filter((id) => id !== dragInfo.todo);
  order.splice(order.indexOf(li.dataset.todo), 0, dragInfo.todo);
  act(() => api('POST', `/api/agents/${enc(a.id)}/todos/reorder`, { ids: order }));
});
document.addEventListener('dragend', () => {
  dragInfo = null;
  document.querySelectorAll('.dragging, .drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
});

// ---- 上方控制列 ----

function syncControls() {
  for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('on', b.dataset.filter === ui.filter);
  $('#search').value = ui.q;
  $('#showArchived').checked = ui.showArchived;
}

document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  ui.filter = b.dataset.filter;
  saveUi();
  syncControls();
  render();
});
$('#search').addEventListener('input', (e) => {
  ui.q = e.target.value;
  saveUi();
  render();
});
$('#showArchived').addEventListener('change', (e) => {
  ui.showArchived = e.target.checked;
  saveUi();
  render();
});
$('#newCard').addEventListener('click', () => {
  $('#newCardForm').hidden = false;
  $('#ncName').focus();
});
$('#ncCancel').addEventListener('click', () => ($('#newCardForm').hidden = true));
$('#ncCreate').addEventListener('click', async () => {
  const body = { name: $('#ncName').value, goal: $('#ncGoal').value, cwd: $('#ncCwd').value };
  if (!body.name.trim() && !body.goal.trim()) return toast('至少填名稱或目標');
  const ok = await act(() => api('POST', '/api/agents', body));
  if (ok) {
    $('#newCardForm').hidden = true;
    for (const id of ['#ncName', '#ncGoal', '#ncCwd']) $(id).value = '';
  }
});

// ---- 即時連線 ----

function connect() {
  const conn = $('#conn');
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    conn.textContent = '即時同步';
    conn.className = 'conn ok';
    render();
  });
  es.onerror = () => {
    conn.textContent = '與 server 斷線，重新連線中…';
    conn.className = 'conn bad';
  };
}

syncControls();
connect();
setInterval(() => {
  updateTimes();
  // 「可能中斷」要靠時間推導，定期重算
  render();
}, 30000);
