#!/usr/bin/env node
'use strict';

// 最小化的 MCP stdio server（JSON-RPC 2.0，一行一個訊息），不依賴任何套件。
// 讓 Claude Code 裡的 agent 可以讀寫自己（或別人）的看板卡片。

const readline = require('readline');
const { call } = require('./client');
const { renderTodos, shortId } = require('./context');
const pkg = require('../package.json');

const DEFAULT_PROTOCOL = '2025-06-18';

const idProp = {
  type: 'string',
  description: '你自己的 board_id（每次使用者送出訊息時 [Agent Board] 那段文字裡會給你）',
};
const targetProp = {
  type: 'string',
  description: '（選填）要改的是別的 agent 的卡片時填對方的 board_id；不填就是改自己的',
};
const statusProp = { type: 'string', enum: ['pending', 'in_progress', 'done'] };

const TOOLS = [
  {
    name: 'board_get',
    description: '讀取看板卡片：目標、待辦（含 id 與狀態）、使用者留言。忘記要做什麼時先呼叫這個。',
    inputSchema: { type: 'object', properties: { board_id: idProp, target_board_id: targetProp }, required: ['board_id'] },
  },
  {
    name: 'board_list',
    description: '列出所有 agent 的卡片（誰在做什麼目標、狀態），用來協調、避免重複工作。',
    inputSchema: {
      type: 'object',
      properties: { include_ended: { type: 'boolean', description: '是否包含已結束/封存的卡片' } },
    },
  },
  {
    name: 'board_set_goal',
    description: '設定或更新這個對話要替使用者達成的目標（一兩句話，寫使用者要的結果，不是步驟）。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, goal: { type: 'string' } },
      required: ['board_id', 'goal'],
    },
  },
  {
    name: 'board_set_focus',
    description: '簡述你現在正在做什麼（例如「在修 login API 的 500 錯誤」），會顯示在面板上。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, focus: { type: 'string' } },
      required: ['board_id', 'focus'],
    },
  },
  {
    name: 'board_add_todo',
    description: '新增一個待辦到看板。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, text: { type: 'string' }, status: statusProp, target_board_id: targetProp },
      required: ['board_id', 'text'],
    },
  },
  {
    name: 'board_update_todo',
    description: '修改待辦的狀態或內容。開始做設 in_progress，做完設 done。',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: idProp,
        todo_id: { type: 'string', description: '待辦 id，例如 t3' },
        status: statusProp,
        text: { type: 'string' },
        target_board_id: targetProp,
      },
      required: ['board_id', 'todo_id'],
    },
  },
  {
    name: 'board_remove_todo',
    description: '刪除一個待辦（不再需要做時）。已完成的請用 board_update_todo 設 done，不要刪。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, todo_id: { type: 'string' }, target_board_id: targetProp },
      required: ['board_id', 'todo_id'],
    },
  },
  {
    name: 'board_send_note',
    description: '留言給另一個 agent（對方下次收到使用者訊息或做完一個工具呼叫時會看到）。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, target_board_id: { type: 'string' }, text: { type: 'string' } },
      required: ['board_id', 'target_board_id', 'text'],
    },
  },
  {
    name: 'board_adopt',
    description: '把另一張卡片（例如 /clear 之前的對話、或使用者手動建立的卡片）的目標與待辦接到自己的卡片。先跟使用者確認再用。',
    inputSchema: {
      type: 'object',
      properties: { board_id: idProp, from_board_id: { type: 'string' } },
      required: ['board_id', 'from_board_id'],
    },
  },
];

const enc = encodeURIComponent;

function renderCard(a) {
  const lines = [
    `board_id: ${a.id}`,
    `名稱: ${a.name || '-'}　專案: ${a.project || '-'}　狀態: ${a.status}`,
    `目標: ${a.goal || '(尚未設定)'}`,
  ];
  if (a.focus) lines.push(`焦點: ${a.focus}`);
  lines.push(...renderTodos(a));
  if (a.notes.length) {
    lines.push('留言:');
    for (const n of a.notes) lines.push(`  - ${n.id} [${n.from === 'user' ? '使用者' : 'agent ' + shortId(n.from)}] ${n.text}`);
  }
  return lines.join('\n');
}

function summary(a) {
  const open = a.todos.filter((t) => t.status !== 'done').length;
  return `- ${a.id} [${a.project || '-'}] ${a.status}${a.archived ? '(封存)' : ''} 目標: ${a.goal || '(無)'}｜未完成待辦 ${open}${a.focus ? `｜焦點: ${a.focus}` : ''}`;
}

async function runTool(name, args = {}) {
  const me = args.board_id;
  const actor = `agent:${me}`;
  const target = args.target_board_id || me;
  const todosAfter = async (id) => renderCard(await call('GET', `/api/agents/${enc(id)}`));

  switch (name) {
    case 'board_get': {
      const card = await call('GET', `/api/agents/${enc(target)}`);
      if (target === me) await call('POST', `/api/agents/${enc(me)}/seen`, { actor });
      return renderCard(card);
    }
    case 'board_list': {
      const state = await call('GET', '/api/state');
      const list = state.agents.filter((a) => args.include_ended || (!a.archived && a.status !== 'ended'));
      return list.length ? list.map(summary).join('\n') : '(看板上沒有卡片)';
    }
    case 'board_set_goal':
      await call('PATCH', `/api/agents/${enc(me)}`, { goal: args.goal, actor });
      return `目標已更新。\n${await todosAfter(me)}`;
    case 'board_set_focus':
      await call('PATCH', `/api/agents/${enc(me)}`, { focus: args.focus, actor });
      return '焦點已更新。';
    case 'board_add_todo': {
      const todo = await call('POST', `/api/agents/${enc(target)}/todos`, { text: args.text, status: args.status, actor });
      return `已新增 ${todo.id}。\n${await todosAfter(target)}`;
    }
    case 'board_update_todo': {
      const patch = { actor };
      if (args.status !== undefined) patch.status = args.status;
      if (args.text !== undefined) patch.text = args.text;
      const todo = await call('PATCH', `/api/agents/${enc(target)}/todos/${enc(args.todo_id)}`, patch);
      return `已更新 ${todo.id}（${todo.status}）。\n${await todosAfter(target)}`;
    }
    case 'board_remove_todo':
      await call('DELETE', `/api/agents/${enc(target)}/todos/${enc(args.todo_id)}?actor=${enc(actor)}`);
      return `已刪除 ${args.todo_id}。\n${await todosAfter(target)}`;
    case 'board_send_note': {
      const note = await call('POST', `/api/agents/${enc(args.target_board_id)}/notes`, { text: args.text, actor });
      return `已留言給 ${shortId(args.target_board_id)}（${note.id}）。`;
    }
    case 'board_adopt':
      await call('POST', `/api/agents/${enc(me)}/adopt`, { from: args.from_board_id, actor });
      return `已接續 ${args.from_board_id}。\n${await todosAfter(me)}`;
    default:
      throw Object.assign(new Error(`未知的工具: ${name}`), { rpc: -32602 });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          // 我們只用到 tools，各版本都一樣，直接沿用 client 要求的版本
          protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-board', version: pkg.version },
          instructions:
            'Agent Board：使用者用來追蹤多個 Claude Code 對話的目標與待辦。你的 board_id 會出現在 [Agent Board] 開頭的系統文字裡。',
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some((t) => t.name === name)) {
          throw Object.assign(new Error(`未知的工具: ${name}`), { rpc: -32602 });
        }
        try {
          const text = await runTool(name, (params && params.arguments) || {});
          result = { content: [{ type: 'text', text }] };
        } catch (err) {
          if (err.rpc) throw err;
          const hint = err.code === 'ECONNREFUSED' ? '（Agent Board server 沒有在跑，請執行 agent-board start）' : '';
          result = { content: [{ type: 'text', text: `錯誤: ${err.message}${hint}` }], isError: true };
        }
        break;
      }
      default:
        if (!isRequest) return null; // 通知（例如 notifications/initialized）不用回
        throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
    }
    return isRequest ? { jsonrpc: '2.0', id, result } : null;
  } catch (err) {
    if (!isRequest) return null;
    return { jsonrpc: '2.0', id, error: { code: err.rpc || -32603, message: err.message } };
  }
}

function start(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => obj && output.write(JSON.stringify(obj) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      const replies = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (replies.length) write(replies);
    } else {
      write(await handle(msg));
    }
  });
  return rl;
}

module.exports = { TOOLS, handle, runTool, start };

if (require.main === module) {
  start();
}
