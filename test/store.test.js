'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Store } = require('../src/store');
const { tmpDir } = require('./helpers');

function fresh() {
  const store = new Store(null);
  store.ensureAgent('sess-aaaa-1111', { cwd: 'C:\\work\\shop-api' });
  return store;
}

test('新卡片從 cwd 推出專案名稱（Windows 路徑也可以）', () => {
  const store = fresh();
  const a = store.get('sess-aaaa-1111');
  assert.equal(a.project, 'shop-api');
});

test('待辦新增、修改、刪除，id 依序遞增', () => {
  const store = fresh();
  const t1 = store.addTodo('sess-aaaa-1111', { text: '寫 API' });
  const t2 = store.addTodo('sess-aaaa-1111', { text: '寫測試', status: 'doing' });
  assert.equal(t1.id, 't1');
  assert.equal(t2.id, 't2');
  assert.equal(t2.status, 'in_progress');
  store.updateTodo('sess-aaaa-1111', 't1', { status: 'completed' });
  assert.equal(store.get('sess-aaaa-1111').todos[0].status, 'done');
  store.removeTodo('sess-aaaa-1111', 't2');
  assert.deepEqual(
    store.get('sess-aaaa-1111').todos.map((t) => t.id),
    ['t1']
  );
  assert.throws(() => store.updateTodo('sess-aaaa-1111', 't1', { status: 'weird' }), /未知的待辦狀態/);
  assert.throws(() => store.addTodo('sess-aaaa-1111', { text: '   ' }), /不能是空的/);
});

test('使用者改動會記錄成待送達變更；agent 自己改的不會', () => {
  const store = fresh();
  const a = store.get('sess-aaaa-1111');
  store.addTodo(a.id, { text: 'agent 自己加的' }, `agent:${a.id}`);
  assert.equal(store.pendingChanges(a).length, 0);
  store.addTodo(a.id, { text: '使用者加的' }, 'user');
  store.updateAgent(a.id, { goal: '上線結帳功能' }, 'user');
  const pending = store.pendingChanges(a);
  assert.equal(pending.length, 2);
  assert.match(pending[0].text, /使用者新增待辦 t2/);
  assert.match(pending[1].text, /上線結帳功能/);
  assert.equal(a.goalBy, 'user');
  store.markDelivered(a);
  assert.equal(store.pendingChanges(a).length, 0);
});

test('別的 agent 改我的卡片也算外部變更', () => {
  const store = fresh();
  store.ensureAgent('sess-bbbb-2222', { cwd: '/x' });
  store.addTodo('sess-aaaa-1111', { text: '幫忙跑 migration' }, 'agent:sess-bbbb-2222');
  const pending = store.pendingChanges(store.get('sess-aaaa-1111'));
  assert.equal(pending.length, 1);
  assert.match(pending[0].text, /^agent sess-bbb/);
});

test('留言：送達後標記 deliveredAt', () => {
  const store = fresh();
  const a = store.get('sess-aaaa-1111');
  store.addNote(a.id, { text: '先不要動 schema' });
  assert.equal(store.undeliveredNotes(a).length, 1);
  store.markDelivered(a);
  assert.equal(store.undeliveredNotes(a).length, 0);
  assert.ok(a.notes[0].deliveredAt);
});

test('board_id 可以用唯一前綴', () => {
  const store = fresh();
  store.ensureAgent('sess-aaaa-2222');
  assert.equal(store.get('sess-aaaa-1111').id, 'sess-aaaa-1111');
  assert.throws(() => store.get('sess-aaaa'), /多張卡片/);
  assert.equal(store.get('sess-aaaa-2').id, 'sess-aaaa-2222');
  assert.throws(() => store.get('nope-nope'), /找不到/);
});

test('reorder 依給定順序排列，沒列到的放最後', () => {
  const store = fresh();
  for (const text of ['a', 'b', 'c']) store.addTodo('sess-aaaa-1111', { text });
  store.reorderTodos('sess-aaaa-1111', ['t3', 't1']);
  assert.deepEqual(
    store.get('sess-aaaa-1111').todos.map((t) => t.id),
    ['t3', 't1', 't2']
  );
});

test('adopt 把目標與待辦搬到新卡片並封存舊卡片', () => {
  const store = fresh();
  const old = store.get('sess-aaaa-1111');
  store.updateAgent(old.id, { goal: '完成報表匯出' });
  store.addTodo(old.id, { text: 'CSV' });
  store.addTodo(old.id, { text: 'Excel', status: 'done' });
  const neu = store.ensureAgent('sess-cccc-3333', { cwd: 'C:\\work\\shop-api' });
  store.adopt(neu.id, old.id);
  assert.equal(neu.goal, '完成報表匯出');
  assert.deepEqual(
    neu.todos.map((t) => [t.id, t.text, t.status]),
    [
      ['t1', 'CSV', 'pending'],
      ['t2', 'Excel', 'done'],
    ]
  );
  assert.equal(old.archived, true);
  assert.equal(old.mergedInto, neu.id);
  assert.equal(old.todos.length, 0);
  assert.throws(() => store.adopt(neu.id, neu.id), /不能接續自己/);
});

test('存檔後可以讀回來', () => {
  const file = path.join(tmpDir(), 'board.json');
  const s1 = new Store(file);
  s1.ensureAgent('sess-x', { cwd: '/home/me/proj' });
  s1.addTodo('sess-x', { text: '持久化' });
  s1.flush();
  const s2 = new Store(file).load();
  assert.equal(s2.get('sess-x').todos[0].text, '持久化');
  assert.equal(s2.get('sess-x').project, 'proj');
});
