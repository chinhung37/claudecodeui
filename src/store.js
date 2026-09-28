'use strict';

// 看板資料層：所有狀態都在記憶體裡，變更後以 debounce 方式寫回 JSON 檔。
// 只有 server 這一個行程會寫檔，hook 與 MCP 都透過 HTTP 呼叫 server。

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TODO_STATUSES = ['pending', 'in_progress', 'done'];
const STATUS_ALIASES = {
  pending: 'pending',
  todo: 'pending',
  open: 'pending',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  doing: 'in_progress',
  active: 'in_progress',
  done: 'done',
  completed: 'done',
  complete: 'done',
  finished: 'done',
};
const MAX_CHANGELOG = 30;
const MAX_TEXT = 2000;

class BoardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function now() {
  return new Date().toISOString();
}

function clip(text, max = MAX_TEXT) {
  if (text == null) return '';
  const s = String(text).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function projectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

function normalizeTodoStatus(status) {
  if (status == null) return undefined;
  const s = STATUS_ALIASES[String(status).toLowerCase().trim()];
  if (!s) throw new BoardError(400, `未知的待辦狀態: ${status}（可用: ${TODO_STATUSES.join(', ')}）`);
  return s;
}

function emptyState() {
  return { version: 1, rev: 0, agents: {} };
}

function newAgent(id, fields = {}) {
  const t = now();
  const cwd = fields.cwd || '';
  return {
    id,
    name: fields.name || '',
    cwd,
    project: projectName(cwd),
    goal: '',
    goalBy: '',
    focus: '',
    status: 'idle',
    statusDetail: '',
    activity: '',
    activityAt: null,
    lastPrompt: '',
    firstPrompt: '',
    todos: [],
    claudeTodos: [],
    notes: [],
    changeLog: [],
    changeRev: 0,
    seenRev: 0,
    nextTodo: 1,
    nextNote: 1,
    manual: !!fields.manual,
    archived: false,
    mergedInto: '',
    sessionSource: '',
    permissionMode: '',
    createdAt: t,
    updatedAt: t,
    lastEventAt: t,
    endedAt: null,
  };
}

class Store extends EventEmitter {
  constructor(file, { saveDelayMs = 200 } = {}) {
    super();
    this.file = file;
    this.saveDelayMs = saveDelayMs;
    this.state = emptyState();
    this._saveTimer = null;
  }

  load() {
    if (!this.file) return this;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && data.agents) {
        this.state = { ...emptyState(), ...data };
        // 舊版資料補欄位
        for (const [id, a] of Object.entries(this.state.agents)) {
          this.state.agents[id] = { ...newAgent(id), ...a };
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 檔案壞掉時先備份，不要直接覆蓋掉使用者資料
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {}
      }
    }
    return this;
  }

  _scheduleSave() {
    if (!this.file) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
  }

  flush() {
    if (!this.file) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const data = JSON.stringify(this.state, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows 上檔案被防毒或編輯器鎖住時 rename 可能失敗，退回直接覆寫
      fs.writeFileSync(this.file, data, 'utf8');
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }

  _changed(agent) {
    const t = now();
    if (agent) agent.updatedAt = t;
    this.state.rev += 1;
    this._scheduleSave();
    this.emit('change', this.state.rev);
  }

  // 外部（events.js）直接改了卡片欄位後呼叫，觸發存檔與推播
  touch(agent) {
    this._changed(agent);
  }

  // ---- 查詢 ----

  list() {
    return Object.values(this.state.agents).sort((a, b) =>
      String(b.lastEventAt).localeCompare(String(a.lastEventAt))
    );
  }

  snapshot() {
    return { rev: this.state.rev, agents: this.list() };
  }

  // 接受完整 id 或唯一前綴（至少 4 個字元），方便 agent 引用
  resolve(idOrPrefix) {
    const key = String(idOrPrefix || '').trim();
    if (!key) throw new BoardError(400, '缺少 board_id');
    if (this.state.agents[key]) return this.state.agents[key];
    if (key.length >= 4) {
      const hits = Object.keys(this.state.agents).filter((id) => id.startsWith(key));
      if (hits.length === 1) return this.state.agents[hits[0]];
      if (hits.length > 1) throw new BoardError(409, `board_id 前綴 "${key}" 對應到多張卡片，請給完整 id`);
    }
    throw new BoardError(404, `找不到看板卡片: ${key}`);
  }

  get(idOrPrefix) {
    return this.resolve(idOrPrefix);
  }

  // ---- 變更來源 ----
  // actor: 'user' 或 'agent:<boardId>'。
  // 若變更者不是卡片本身的 agent，就記進 changeLog，下次 hook 時提醒該 agent。
  _recordExternal(agent, actor, text) {
    if (actor === `agent:${agent.id}`) return;
    const who = actor === 'user' ? '使用者' : `agent ${String(actor).replace(/^agent:/, '').slice(0, 8)}`;
    agent.changeRev += 1;
    agent.changeLog.push({ rev: agent.changeRev, at: now(), text: `${who}${text}` });
    if (agent.changeLog.length > MAX_CHANGELOG) agent.changeLog.splice(0, agent.changeLog.length - MAX_CHANGELOG);
  }

  _actorTag(actor) {
    if (actor === 'user') return 'user';
    return 'agent';
  }

  // ---- 卡片 ----

  ensureAgent(id, fields = {}) {
    let agent = this.state.agents[id];
    if (!agent) {
      agent = newAgent(id, fields);
      this.state.agents[id] = agent;
    } else if (fields.cwd && fields.cwd !== agent.cwd) {
      agent.cwd = fields.cwd;
      agent.project = projectName(fields.cwd);
    }
    return agent;
  }

  createManual({ name, goal, cwd } = {}, actor = 'user') {
    const id = `manual-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const agent = newAgent(id, { cwd, name: clip(name, 200), manual: true });
    agent.goal = clip(goal);
    agent.goalBy = this._actorTag(actor);
    agent.status = 'idle';
    this.state.agents[id] = agent;
    this._changed(agent);
    return agent;
  }

  updateAgent(idOrPrefix, patch = {}, actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    if (patch.name !== undefined) agent.name = clip(patch.name, 200);
    if (patch.goal !== undefined) {
      const goal = clip(patch.goal);
      if (goal !== agent.goal) {
        agent.goal = goal;
        agent.goalBy = this._actorTag(actor);
        this._recordExternal(agent, actor, `把目標改成「${goal || '(空白)'}」`);
      }
    }
    if (patch.focus !== undefined) agent.focus = clip(patch.focus, 500);
    if (patch.archived !== undefined) agent.archived = !!patch.archived;
    this._changed(agent);
    return agent;
  }

  removeAgent(idOrPrefix) {
    const agent = this.resolve(idOrPrefix);
    delete this.state.agents[agent.id];
    this._changed(null);
    return agent;
  }

  // 把舊卡片（例如 /clear 前的對話或手動建立的卡片）的目標、待辦、留言接到新卡片
  adopt(targetId, fromId, actor = 'user') {
    const target = this.resolve(targetId);
    const from = this.resolve(fromId);
    if (target.id === from.id) throw new BoardError(400, '不能接續自己');
    if (from.goal) {
      target.goal = from.goal;
      target.goalBy = from.goalBy;
    }
    for (const todo of from.todos) {
      target.todos.push({ ...todo, id: `t${target.nextTodo++}` });
    }
    for (const note of from.notes) {
      target.notes.push({ ...note, id: `n${target.nextNote++}` });
    }
    if (!target.name && from.name) target.name = from.name;
    this._recordExternal(target, actor, `把卡片 ${from.id.slice(0, 8)} 的目標與 ${from.todos.length} 個待辦接到這張卡片`);
    from.mergedInto = target.id;
    from.archived = true;
    from.todos = [];
    from.notes = [];
    this._changed(from);
    this._changed(target);
    return target;
  }

  // ---- 待辦 ----

  addTodo(idOrPrefix, { text, status } = {}, actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    const body = clip(text, 500);
    if (!body) throw new BoardError(400, '待辦內容不能是空的');
    const t = now();
    const todo = {
      id: `t${agent.nextTodo++}`,
      text: body,
      status: normalizeTodoStatus(status) || 'pending',
      by: this._actorTag(actor),
      createdAt: t,
      updatedAt: t,
    };
    agent.todos.push(todo);
    this._recordExternal(agent, actor, `新增待辦 ${todo.id}「${body}」`);
    this._changed(agent);
    return todo;
  }

  _findTodo(agent, todoId) {
    const todo = agent.todos.find((x) => x.id === String(todoId).trim());
    if (!todo) throw new BoardError(404, `找不到待辦 ${todoId}（卡片 ${agent.id.slice(0, 8)}）`);
    return todo;
  }

  updateTodo(idOrPrefix, todoId, patch = {}, actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    const todo = this._findTodo(agent, todoId);
    const changes = [];
    if (patch.text !== undefined) {
      const body = clip(patch.text, 500);
      if (!body) throw new BoardError(400, '待辦內容不能是空的');
      if (body !== todo.text) {
        changes.push(`內容改為「${body}」`);
        todo.text = body;
      }
    }
    if (patch.status !== undefined) {
      const status = normalizeTodoStatus(patch.status);
      if (status !== todo.status) {
        changes.push(`狀態改為 ${status}`);
        todo.status = status;
      }
    }
    if (changes.length) {
      todo.updatedAt = now();
      this._recordExternal(agent, actor, `修改待辦 ${todo.id}：${changes.join('，')}`);
      this._changed(agent);
    }
    return todo;
  }

  removeTodo(idOrPrefix, todoId, actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    const todo = this._findTodo(agent, todoId);
    agent.todos = agent.todos.filter((x) => x !== todo);
    this._recordExternal(agent, actor, `刪除待辦 ${todo.id}「${todo.text}」`);
    this._changed(agent);
    return todo;
  }

  reorderTodos(idOrPrefix, ids = [], actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    const order = new Map(ids.map((id, i) => [String(id), i]));
    agent.todos.sort((a, b) => {
      const ia = order.has(a.id) ? order.get(a.id) : Infinity;
      const ib = order.has(b.id) ? order.get(b.id) : Infinity;
      return ia - ib;
    });
    this._recordExternal(agent, actor, '調整了待辦順序（越上面越優先）');
    this._changed(agent);
    return agent.todos;
  }

  // ---- 留言（給 agent 的指示）----

  addNote(idOrPrefix, { text } = {}, actor = 'user') {
    const agent = this.resolve(idOrPrefix);
    const body = clip(text);
    if (!body) throw new BoardError(400, '留言不能是空的');
    const note = {
      id: `n${agent.nextNote++}`,
      text: body,
      from: actor === 'user' ? 'user' : String(actor).replace(/^agent:/, ''),
      createdAt: now(),
      deliveredAt: null,
    };
    agent.notes.push(note);
    this._recordExternal(agent, actor, `留言 ${note.id}：「${body}」`);
    this._changed(agent);
    return note;
  }

  removeNote(idOrPrefix, noteId) {
    const agent = this.resolve(idOrPrefix);
    const before = agent.notes.length;
    agent.notes = agent.notes.filter((n) => n.id !== String(noteId));
    if (agent.notes.length === before) throw new BoardError(404, `找不到留言 ${noteId}`);
    this._changed(agent);
  }

  // ---- 投遞給 agent ----

  pendingChanges(agent) {
    return agent.changeLog.filter((c) => c.rev > agent.seenRev);
  }

  undeliveredNotes(agent) {
    return agent.notes.filter((n) => !n.deliveredAt);
  }

  markDelivered(agent) {
    const t = now();
    let dirty = agent.seenRev !== agent.changeRev;
    agent.seenRev = agent.changeRev;
    for (const n of agent.notes) {
      if (!n.deliveredAt) {
        n.deliveredAt = t;
        dirty = true;
      }
    }
    if (dirty) this._changed(agent);
  }
}

module.exports = {
  Store,
  BoardError,
  TODO_STATUSES,
  normalizeTodoStatus,
  projectName,
  clip,
  now,
};
