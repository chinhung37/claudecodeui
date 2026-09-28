'use strict';

// 把 Claude Code hook 事件轉成看板狀態，並決定要不要注入文字回 agent。

const { clip, now } = require('./store');
const { sessionContext, promptContext, changesContext } = require('./context');

const BOARD_TOOL_PREFIX = 'mcp__agent-board__';
// 超過這個時間沒有任何事件的對話，不列為「其他進行中的 agent」（可能是終端機直接被關掉）
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

function rel(file, cwd) {
  if (!file) return '';
  const f = String(file).replace(/\\/g, '/');
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (c && f.toLowerCase().startsWith(c.toLowerCase() + '/')) return f.slice(c.length + 1);
  return f;
}

function firstLine(text, max = 120) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  return clip(line, max);
}

// 把工具呼叫翻成一句人看得懂的「目前在做」
function describeTool(name, input = {}, cwd = '') {
  input = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `執行指令: ${firstLine(input.description || input.command)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `編輯 ${rel(input.file_path || input.notebook_path, cwd)}`;
    case 'Read':
      return `讀取 ${rel(input.file_path, cwd)}`;
    case 'Grep':
      return `搜尋程式碼: ${firstLine(input.pattern, 80)}`;
    case 'Glob':
      return `找檔案: ${firstLine(input.pattern, 80)}`;
    case 'WebFetch':
      return `讀取網頁: ${firstLine(input.url, 100)}`;
    case 'WebSearch':
      return `網路搜尋: ${firstLine(input.query, 100)}`;
    case 'Task':
    case 'Agent':
      return `派出子代理: ${firstLine(input.description || input.prompt, 100)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '更新 Claude 內建待辦';
    default:
      if (String(name).startsWith(BOARD_TOOL_PREFIX)) return '更新看板';
      if (String(name).startsWith('mcp__')) return `MCP 工具: ${String(name).slice(5)}`;
      return `使用工具: ${name}`;
  }
}

// 子代理裡的工具呼叫會帶 agent_id / agent_type
function subagentPrefix(payload) {
  if (!payload.agent_id) return '';
  return `[子代理${payload.agent_type ? ' ' + payload.agent_type : ''}] `;
}

// Claude Code 內建 TodoWrite 的清單鏡像（唯讀）
function mirrorClaudeTodos(input) {
  const todos = input && Array.isArray(input.todos) ? input.todos : null;
  if (!todos) return null;
  return todos.slice(0, 100).map((t) => ({
    content: clip(t.content || t.subject || '', 300),
    status: String(t.status || 'pending'),
    activeForm: clip(t.activeForm || '', 300),
  }));
}

// 新版 Claude Code 用 TaskCreate / TaskUpdate 取代 TodoWrite。
// 回傳格式官方文件沒寫清楚，這裡盡量容錯：抓不到 id 就用流水號（Claude Code 的 task id 通常是 1,2,3…，未驗證）。
function taskIdFromResponse(resp) {
  if (resp == null) return '';
  if (typeof resp === 'object') {
    const v = (resp.task && resp.task.id) || resp.id || resp.taskId || resp.task_id;
    if (v != null) return String(v);
    resp = JSON.stringify(resp);
  }
  const m = String(resp).match(/#\s*(\d+)/) || String(resp).match(/\b(?:task|id)\D{0,3}(\d+)/i);
  return m ? m[1] : '';
}

function applyTaskTool(agent, name, input = {}, response) {
  input = input || {};
  const list = Array.isArray(agent.claudeTodos) ? agent.claudeTodos : [];
  if (name === 'TaskCreate') {
    const id = taskIdFromResponse(response) || String(list.length + 1);
    list.push({
      id,
      content: clip(input.subject || input.content || input.description || '', 300),
      status: 'pending',
      activeForm: clip(input.activeForm || input.active_form || '', 300),
    });
  } else if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? input.task_id ?? input.id ?? '');
    const item = list.find((x) => String(x.id) === id);
    if (!item) return;
    if (input.status === 'deleted') {
      list.splice(list.indexOf(item), 1);
    } else {
      if (input.status) item.status = String(input.status);
      if (input.subject) item.content = clip(input.subject, 300);
      const af = input.activeForm || input.active_form;
      if (af) item.activeForm = clip(af, 300);
    }
  }
  agent.claudeTodos = list.slice(-100);
}

function activeClaudeTodo(todos) {
  const t = (todos || []).find((x) => x.status === 'in_progress');
  return t ? t.activeForm || t.content : '';
}

function otherActive(store, agent, nowMs = Date.now()) {
  return store
    .list()
    .filter(
      (o) =>
        o.id !== agent.id &&
        !o.archived &&
        !o.manual &&
        o.status !== 'ended' &&
        nowMs - Date.parse(o.lastEventAt) < ACTIVE_WINDOW_MS
    );
}

// 同一個目錄底下還沒完成、可以被「接續」的卡片（例如 /clear 之前的對話或手動建立的卡片）
function adoptCandidates(store, agent) {
  const key = String(agent.cwd || '').toLowerCase();
  return store.list().filter((o) => {
    if (o.id === agent.id || o.archived || o.mergedInto) return false;
    const hasWork = o.goal || o.todos.some((t) => t.status !== 'done');
    if (!hasWork) return false;
    if (o.manual) return !o.cwd || String(o.cwd).toLowerCase() === key;
    return key && String(o.cwd).toLowerCase() === key && o.status !== 'working';
  });
}

/**
 * @param {import('./store').Store} store
 * @param {object} payload  Claude Code 傳給 hook 的 stdin JSON
 * @param {{boardUrl?: string, inject?: 'always'|'changes'|'off'}} config
 * @returns {{additionalContext?: string, agentId?: string}}
 */
function handleHook(store, payload, config = {}) {
  const event = payload && payload.hook_event_name;
  const sessionId = payload && payload.session_id;
  if (!event || !sessionId) return {};
  const inject = config.inject || 'always';
  const boardUrl = config.boardUrl || '';

  const agent = store.ensureAgent(String(sessionId), { cwd: payload.cwd });
  const t = now();
  agent.lastEventAt = t;
  if (payload.permission_mode) agent.permissionMode = String(payload.permission_mode);
  if (agent.status === 'ended' && event !== 'SessionEnd') {
    agent.endedAt = null;
  }

  let context = '';
  const pending = () => store.pendingChanges(agent);
  const notes = () => store.undeliveredNotes(agent);

  switch (event) {
    case 'SessionStart': {
      agent.sessionSource = String(payload.source || '');
      agent.status = 'waiting';
      agent.statusDetail = '';
      if (inject !== 'off') {
        context = sessionContext(agent, {
          boardUrl,
          others: otherActive(store, agent),
          candidates: agent.goal ? [] : adoptCandidates(store, agent),
          pendingChanges: pending(),
          notes: notes(),
        });
      }
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = clip(payload.prompt, 1000);
      agent.lastPrompt = prompt;
      if (!agent.firstPrompt) agent.firstPrompt = prompt;
      agent.status = 'working';
      agent.statusDetail = '';
      agent.activity = '思考中';
      agent.activityAt = t;
      if (inject === 'always') {
        context = promptContext(agent, { boardUrl, pendingChanges: pending(), notes: notes() });
      } else if (inject === 'changes') {
        context = changesContext(agent, { boardUrl, pendingChanges: pending(), notes: notes() });
      }
      break;
    }
    case 'PreToolUse': {
      agent.status = 'working';
      agent.statusDetail = '';
      agent.activity = subagentPrefix(payload) + describeTool(payload.tool_name, payload.tool_input, agent.cwd);
      agent.activityAt = t;
      break;
    }
    case 'PostToolUse': {
      agent.status = 'working';
      if (payload.tool_name === 'TodoWrite') {
        const mirrored = mirrorClaudeTodos(payload.tool_input);
        if (mirrored) agent.claudeTodos = mirrored;
      } else if (payload.tool_name === 'TaskCreate' || payload.tool_name === 'TaskUpdate') {
        applyTaskTool(agent, payload.tool_name, payload.tool_input, payload.tool_response);
      }
      if (!agent.activity) {
        agent.activity = describeTool(payload.tool_name, payload.tool_input, agent.cwd);
        agent.activityAt = t;
      }
      if (inject !== 'off') {
        context = changesContext(agent, { boardUrl, pendingChanges: pending(), notes: notes() });
      }
      break;
    }
    case 'Notification': {
      const message = clip(payload.message, 300);
      const type = String(payload.notification_type || '');
      const needsPermission = type === 'permission_prompt' || /permission|授權|許可/i.test(message);
      if (needsPermission) {
        agent.status = 'attention';
        agent.statusDetail = message || '等待授權';
      } else if (agent.status !== 'working') {
        agent.status = 'waiting';
        agent.statusDetail = message;
      }
      break;
    }
    case 'Stop': {
      agent.status = 'waiting';
      agent.statusDetail = '';
      const active = activeClaudeTodo(agent.claudeTodos);
      agent.activity = active ? `（暫停）${active}` : '';
      agent.activityAt = t;
      break;
    }
    case 'SubagentStop': {
      agent.activity = '子代理完成，整合結果中';
      agent.activityAt = t;
      break;
    }
    case 'SessionEnd': {
      agent.status = 'ended';
      agent.statusDetail = clip(payload.reason || '', 100);
      agent.activity = '';
      agent.endedAt = t;
      break;
    }
    default:
      break;
  }

  if (context) store.markDelivered(agent);
  store.touch(agent);
  return context ? { additionalContext: context, agentId: agent.id } : { agentId: agent.id };
}

module.exports = { handleHook, describeTool, mirrorClaudeTodos, applyTaskTool, taskIdFromResponse, adoptCandidates, otherActive, rel };
