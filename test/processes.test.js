'use strict';

// 以子程序實際跑 hook.js 與 mcp.js，模擬 Claude Code 呼叫它們的方式。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { startTestServer, runNode } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'src', 'hook.js');
const MCP = path.join(__dirname, '..', 'src', 'mcp.js');

let srv;
test.before(async () => {
  srv = await startTestServer();
});
test.after(async () => {
  await srv.closeAll();
});

test('hook.js：UserPromptSubmit 輸出 hookSpecificOutput.additionalContext', async () => {
  const payload = {
    session_id: 'proc-sess-1',
    cwd: 'C:/work/demo',
    hook_event_name: 'UserPromptSubmit',
    prompt: '幫我加分頁功能',
  };
  const r = await runNode(HOOK, { input: JSON.stringify(payload), env: srv.env });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /board_id: proc-sess-1/);
  assert.equal(srv.store.get('proc-sess-1').lastPrompt, '幫我加分頁功能');
});

test('hook.js：PreToolUse 不輸出任何東西，只更新狀態', async () => {
  const payload = {
    session_id: 'proc-sess-1',
    cwd: 'C:/work/demo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
  };
  const r = await runNode(HOOK, { input: JSON.stringify(payload), env: srv.env });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(srv.store.get('proc-sess-1').activity, '執行指令: npm run build');
});

test('hook.js：server 沒開、輸入壞掉都安靜地 exit 0', async () => {
  const env = { ...srv.env, AGENT_BOARD_PORT: '1' };
  const t0 = Date.now();
  let r = await runNode(HOOK, { input: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }), env });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 5000);
  r = await runNode(HOOK, { input: 'not json', env: srv.env });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

function mcpSession(env) {
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  let nextId = 1;
  return {
    rpc(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

test('mcp.js：initialize / tools/list / tools/call 全流程', async () => {
  srv.store.ensureAgent('mcp-sess-1', { cwd: '/p' });
  const m = mcpSession(srv.env);
  try {
    const init = await m.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'agent-board');
    assert.ok(init.result.capabilities.tools);
    m.notify('notifications/initialized');

    const list = await m.rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['board_get', 'board_list', 'board_set_goal', 'board_add_todo', 'board_update_todo', 'board_adopt']) {
      assert.ok(names.includes(n), n);
    }

    let r = await m.rpc('tools/call', { name: 'board_set_goal', arguments: { board_id: 'mcp-sess-1', goal: '完成 MCP 測試' } });
    assert.match(r.result.content[0].text, /目標已更新/);
    r = await m.rpc('tools/call', { name: 'board_add_todo', arguments: { board_id: 'mcp-sess-1', text: '第一件事' } });
    assert.match(r.result.content[0].text, /已新增 t1/);
    r = await m.rpc('tools/call', { name: 'board_update_todo', arguments: { board_id: 'mcp-sess-1', todo_id: 't1', status: 'done' } });
    assert.match(r.result.content[0].text, /\[x\] t1 第一件事/);

    const card = srv.store.get('mcp-sess-1');
    assert.equal(card.goal, '完成 MCP 測試');
    assert.equal(card.goalBy, 'agent');
    // agent 改自己的卡片不算外部變更
    assert.equal(srv.store.pendingChanges(card).length, 0);

    r = await m.rpc('tools/call', { name: 'board_get', arguments: { board_id: 'nope-nope-nope' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /找不到/);

    r = await m.rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    assert.equal(r.error.code, -32602);

    r = await m.rpc('does/not/exist', {});
    assert.equal(r.error.code, -32601);

    r = await m.rpc('ping', {});
    assert.deepEqual(r.result, {});
  } finally {
    m.close();
  }
});

test('mcp.js：agent 可以留言給另一個 agent，對方下次 hook 會收到', async () => {
  srv.store.ensureAgent('mcp-sess-2', { cwd: '/p' });
  const m = mcpSession(srv.env);
  try {
    await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const r = await m.rpc('tools/call', {
      name: 'board_send_note',
      arguments: { board_id: 'mcp-sess-1', target_board_id: 'mcp-sess-2', text: 'API 介面我改好了，你可以接著做前端' },
    });
    assert.match(r.result.content[0].text, /已留言/);
  } finally {
    m.close();
  }
  const hook = await runNode(HOOK, {
    input: JSON.stringify({ session_id: 'mcp-sess-2', cwd: '/p', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }),
    env: srv.env,
  });
  const out = JSON.parse(hook.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /API 介面我改好了/);
});
