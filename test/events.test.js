'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { handleHook, describeTool, otherActive } = require('../src/events');
const { slim } = require('../src/hook');

const SID = '0f3c2a9e-1111-4a4a-9c9c-abcdefabcdef';
const CWD = 'C:\\Users\\me\\work\\shop-api';
const cfg = { boardUrl: 'http://127.0.0.1:47821', inject: 'always' };

function ev(event, extra = {}) {
  return { session_id: SID, cwd: CWD, hook_event_name: event, permission_mode: 'default', ...extra };
}

test('SessionStart 建立卡片並注入 board_id 與設定目標的提醒', () => {
  const store = new Store(null);
  const r = handleHook(store, ev('SessionStart', { source: 'startup' }), cfg);
  const a = store.get(SID);
  assert.equal(a.status, 'waiting');
  assert.equal(a.project, 'shop-api');
  assert.match(r.additionalContext, new RegExp(`board_id: ${SID}`));
  assert.match(r.additionalContext, /尚未設定/);
  assert.match(r.additionalContext, /board_set_goal/);
});

test('UserPromptSubmit 記錄提示、狀態變工作中，並注入目標與待辦', () => {
  const store = new Store(null);
  handleHook(store, ev('SessionStart', { source: 'startup' }), cfg);
  store.updateAgent(SID, { goal: '讓結帳 API 支援信用卡' }, `agent:${SID}`);
  store.addTodo(SID, { text: '串金流 SDK' }, `agent:${SID}`);
  store.addTodo(SID, { text: '寫整合測試', status: 'done' }, `agent:${SID}`);
  const r = handleHook(store, ev('UserPromptSubmit', { prompt: '繼續做信用卡的部分' }), cfg);
  const a = store.get(SID);
  assert.equal(a.status, 'working');
  assert.equal(a.firstPrompt, '繼續做信用卡的部分');
  assert.match(r.additionalContext, /目標: 讓結帳 API 支援信用卡/);
  assert.match(r.additionalContext, /\[ \] t1 串金流 SDK/);
  assert.match(r.additionalContext, /\[x\] t2 寫整合測試/);
});

test('PreToolUse 更新「目前在做」，路徑轉成相對於專案', () => {
  const store = new Store(null);
  handleHook(
    store,
    ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:\\Users\\me\\work\\shop-api\\src\\pay.js' } }),
    cfg
  );
  assert.equal(store.get(SID).activity, '編輯 src/pay.js');
  handleHook(store, ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test\nnpm run lint' } }), cfg);
  assert.equal(store.get(SID).activity, '執行指令: npm test');
  handleHook(store, ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/y' }, agent_id: 'a1', agent_type: 'Explore' }), cfg);
  assert.equal(store.get(SID).activity, '[子代理 Explore] 讀取 /x/y');
});

test('PostToolUse TodoWrite 會鏡像 Claude 內建待辦', () => {
  const store = new Store(null);
  handleHook(
    store,
    ev('PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: '讀程式', status: 'completed', activeForm: '讀程式中' },
          { content: '改 bug', status: 'in_progress', activeForm: '修 bug 中' },
        ],
      },
    }),
    cfg
  );
  const a = store.get(SID);
  assert.equal(a.claudeTodos.length, 2);
  assert.equal(a.claudeTodos[1].activeForm, '修 bug 中');
  handleHook(store, ev('Stop'), cfg);
  assert.equal(a.status, 'waiting');
  assert.equal(a.activity, '（暫停）修 bug 中');
});

test('PostToolUse TaskCreate / TaskUpdate 也會鏡像（盡力而為）', () => {
  const store = new Store(null);
  handleHook(store, ev('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: '加快取' }, tool_response: 'Task #1 created successfully' }), cfg);
  handleHook(store, ev('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: '寫文件' }, tool_response: { task: { id: '2' } } }), cfg);
  handleHook(store, ev('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress', activeForm: '加快取中' } }), cfg);
  handleHook(store, ev('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'deleted' } }), cfg);
  const todos = store.get(SID).claudeTodos;
  assert.deepEqual(
    todos.map((t) => [t.id, t.content, t.status]),
    [['1', '加快取', 'in_progress']]
  );
});

test('使用者在面板改了待辦，agent 工作途中（PostToolUse）只會收到一次通知', () => {
  const store = new Store(null);
  handleHook(store, ev('SessionStart', { source: 'startup' }), cfg);
  let r = handleHook(store, ev('PostToolUse', { tool_name: 'Read', tool_input: {} }), cfg);
  assert.equal(r.additionalContext, undefined);
  store.addTodo(SID, { text: '順便把 log 等級調低' }, 'user');
  store.addNote(SID, { text: '先不要 push' }, 'user');
  r = handleHook(store, ev('PostToolUse', { tool_name: 'Read', tool_input: {} }), cfg);
  assert.match(r.additionalContext, /使用者新增待辦 t1/);
  assert.match(r.additionalContext, /先不要 push/);
  r = handleHook(store, ev('PostToolUse', { tool_name: 'Read', tool_input: {} }), cfg);
  assert.equal(r.additionalContext, undefined);
  assert.ok(store.get(SID).notes[0].deliveredAt);
});

test('Notification 要授權時狀態變「需要授權」，SessionEnd 變已結束', () => {
  const store = new Store(null);
  handleHook(store, ev('UserPromptSubmit', { prompt: 'x' }), cfg);
  handleHook(store, ev('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }), cfg);
  assert.equal(store.get(SID).status, 'attention');
  handleHook(store, ev('SessionEnd', { reason: 'prompt_input_exit' }), cfg);
  assert.equal(store.get(SID).status, 'ended');
  assert.ok(store.get(SID).endedAt);
});

test('/clear 之後的新對話會被提示可以接續同專案的舊卡片', () => {
  const store = new Store(null);
  handleHook(store, ev('SessionStart', { source: 'startup' }), cfg);
  store.updateAgent(SID, { goal: '重構購物車' }, 'user');
  handleHook(store, ev('SessionEnd', { reason: 'clear' }), cfg);
  const r = handleHook(store, { ...ev('SessionStart', { source: 'clear' }), session_id: 'new-session-2222' }, cfg);
  assert.match(r.additionalContext, /board_adopt/);
  assert.match(r.additionalContext, new RegExp(`${SID}.*重構購物車`));
});

test('inject=off 不注入任何文字；inject=changes 只在有變更時注入', () => {
  const store = new Store(null);
  let r = handleHook(store, ev('UserPromptSubmit', { prompt: 'x' }), { inject: 'off' });
  assert.equal(r.additionalContext, undefined);
  r = handleHook(store, ev('UserPromptSubmit', { prompt: 'x' }), { inject: 'changes' });
  assert.equal(r.additionalContext, undefined);
  store.addTodo(SID, { text: 'y' }, 'user');
  r = handleHook(store, ev('UserPromptSubmit', { prompt: 'x' }), { inject: 'changes' });
  assert.match(r.additionalContext, /使用者新增待辦/);
});

test('缺 session_id 或事件名稱時什麼都不做', () => {
  const store = new Store(null);
  assert.deepEqual(handleHook(store, { hook_event_name: 'Stop' }, cfg), {});
  assert.deepEqual(handleHook(store, { session_id: 'x' }, cfg), {});
  assert.equal(store.list().length, 0);
});

test('其他進行中的 agent 不包含已結束、封存、或 12 小時沒動靜的', () => {
  const store = new Store(null);
  const me = store.ensureAgent('me');
  store.ensureAgent('live').status = 'working';
  store.ensureAgent('ended').status = 'ended';
  store.ensureAgent('old').lastEventAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  store.ensureAgent('arch').archived = true;
  assert.deepEqual(
    otherActive(store, me).map((a) => a.id),
    ['live']
  );
});

test('hook 送出前會把大欄位砍掉（Write 內容、Bash 輸出）', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const out = slim({
    session_id: 's',
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'a.txt', content: big },
    tool_response: { stdout: big },
  });
  assert.deepEqual(out.tool_input, { file_path: 'a.txt' });
  assert.equal(out.tool_response, undefined);
  assert.ok(JSON.stringify(out).length < 1000);
  const task = slim({ hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: { task: { id: '7' } } });
  assert.equal(task.tool_response, '{"task":{"id":"7"}}');
  const todo = slim({ hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a', status: 'pending' }] } });
  assert.deepEqual(todo.tool_input.todos, [{ content: 'a', status: 'pending' }]);
});

test('describeTool 對未知與 MCP 工具有合理描述', () => {
  assert.equal(describeTool('mcp__agent-board__board_add_todo', {}), '更新看板');
  assert.equal(describeTool('mcp__github__create_pr', {}), 'MCP 工具: github__create_pr');
  assert.equal(describeTool('Whatever', null), '使用工具: Whatever');
});
