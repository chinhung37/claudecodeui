'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startTestServer } = require('./helpers');
const { request } = require('../src/client');

let srv;
test.before(async () => {
  srv = await startTestServer();
});
test.after(async () => {
  await srv.closeAll();
});

function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.cfg.port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('面板靜態檔案可以取得', async () => {
  const r = await raw('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Agent Board/);
  assert.equal((await raw('GET', '/app.js')).status, 200);
  assert.equal((await raw('GET', '/../package.json')).status, 404);
});

test('非本機 Host header 會被拒絕（防 DNS rebinding）', async () => {
  const r = await raw('GET', '/api/state', { headers: { Host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

test('沒有 X-Agent-Board header 的寫入請求會被拒絕（防跨站請求）', async () => {
  const r = await raw('POST', '/api/agents', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(r.status, 403);
});

test('完整流程：hook 建卡、使用者加待辦、agent 更新狀態', async () => {
  const cfg = srv.cfg;
  const hook = await request(cfg, 'POST', '/api/hook', {
    session_id: 'sess-api-1',
    cwd: '/home/me/proj',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.match(hook.additionalContext, /sess-api-1/);

  const todo = await request(cfg, 'POST', '/api/agents/sess-api-1/todos', { text: '修登入' });
  assert.equal(todo.id, 't1');
  assert.equal(todo.by, 'user');

  const upd = await request(cfg, 'PATCH', '/api/agents/sess-api-1/todos/t1', {
    status: 'in_progress',
    actor: 'agent:sess-api-1',
  });
  assert.equal(upd.status, 'in_progress');

  await request(cfg, 'PATCH', '/api/agents/sess-api-1', { goal: '修好登入流程', actor: 'agent:sess-api-1' });
  const card = await request(cfg, 'GET', '/api/agents/sess-api-1');
  assert.equal(card.goal, '修好登入流程');
  assert.equal(card.goalBy, 'agent');

  await request(cfg, 'POST', '/api/agents/sess-api-1/notes', { text: '記得寫測試' });
  await request(cfg, 'POST', '/api/agents/sess-api-1/seen', {});
  const after = await request(cfg, 'GET', '/api/agents/sess-api-1');
  assert.ok(after.notes[0].deliveredAt);

  await request(cfg, 'DELETE', '/api/agents/sess-api-1/todos/t1');
  const state = await request(cfg, 'GET', '/api/state');
  assert.equal(state.agents.find((a) => a.id === 'sess-api-1').todos.length, 0);
});

test('錯誤會回傳對應狀態碼與中文訊息', async () => {
  await assert.rejects(request(srv.cfg, 'GET', '/api/agents/nope-nope'), (err) => err.status === 404 && /找不到/.test(err.message));
  await assert.rejects(request(srv.cfg, 'POST', '/api/agents/sess-api-1/todos', { text: '' }), (err) => err.status === 400);
});

test('手動卡片可以被接續', async () => {
  const manual = await request(srv.cfg, 'POST', '/api/agents', { name: '報表', goal: '做月報匯出' });
  assert.match(manual.id, /^manual-/);
  await request(srv.cfg, 'POST', `/api/agents/${manual.id}/todos`, { text: '匯出 CSV' });
  await request(srv.cfg, 'POST', '/api/hook', { session_id: 'sess-api-2', cwd: '/p', hook_event_name: 'SessionStart' });
  const merged = await request(srv.cfg, 'POST', '/api/agents/sess-api-2/adopt', { from: manual.id });
  assert.equal(merged.goal, '做月報匯出');
  assert.equal(merged.todos[0].text, '匯出 CSV');
});

test('SSE 連線後立即收到完整狀態，之後有變更會推播', async () => {
  const events = [];
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: srv.cfg.port, path: '/api/events' }, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
          if (events.length === 1) {
            request(srv.cfg, 'POST', '/api/agents', { name: 'sse 測試' }).catch(reject);
          }
          if (events.length === 2) {
            req.destroy();
            resolve();
          }
        }
      });
    });
    req.on('error', (e) => (events.length >= 2 ? resolve() : reject(e)));
  });
  assert.ok(Array.isArray(events[0].agents));
  assert.ok(events[1].agents.some((a) => a.name === 'sse 測試'));
  assert.ok(events[1].rev > events[0].rev);
});
