'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { addOurs, stripOurs, addAllow, stripAllow, install, uninstall, FULL_EVENTS } = require('../src/install');
const { tmpDir } = require('./helpers');

const CMD = 'node "C:/tools/whatever/src/hook.js" --agent-board-hook';

test('addOurs 加入所有事件，並保留使用者原本的 hooks', () => {
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  const settings = { model: 'x', hooks: { PreToolUse: [mine] } };
  addOurs(settings, { command: CMD });
  for (const e of FULL_EVENTS) assert.ok(settings.hooks[e], e);
  assert.deepEqual(settings.hooks.PreToolUse[0], mine);
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, CMD);
  assert.equal(settings.model, 'x');
});

test('重複安裝不會重複加入', () => {
  const settings = {};
  addOurs(settings, { command: CMD });
  addOurs(settings, { command: CMD });
  for (const e of FULL_EVENTS) assert.equal(settings.hooks[e].length, 1, e);
});

test('--minimal 不裝 PreToolUse，PostToolUse 只看待辦工具', () => {
  const settings = addOurs({}, { command: CMD, minimal: true });
  assert.equal(settings.hooks.PreToolUse, undefined);
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'TodoWrite|TaskCreate|TaskUpdate');
});

test('stripOurs 只移除自己的 hooks', () => {
  const mine = { hooks: [{ type: 'command', command: 'python notify.py' }] };
  const settings = addOurs({ hooks: { Stop: [mine] } }, { command: CMD });
  stripOurs(settings);
  assert.deepEqual(settings.hooks, { Stop: [mine] });
});

test('addAllow / stripAllow 只動自己那條規則', () => {
  const settings = { permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] } };
  addAllow(settings);
  addAllow(settings);
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)', 'mcp__agent-board']);
  stripAllow(settings);
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] });
  const empty = addAllow({});
  stripAllow(empty);
  assert.deepEqual(empty, {});
});

test('install --no-mcp 時不加放行規則（沒有 MCP 就不需要）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  install({ settingsPath: file, mcp: false, log: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).permissions, undefined);
});

test('install / uninstall 實際寫檔並備份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
  const logs = [];
  install({ settingsPath: file, mcp: false, log: (m) => logs.push(m) });
  let written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.permissions, { allow: ['Bash(ls:*)'] });
  // 加上放行規則後，uninstall 要一併移除
  written = addAllow(written);
  fs.writeFileSync(file, JSON.stringify(written));
  assert.match(written.hooks.UserPromptSubmit[0].hooks[0].command, /hook\.js" --agent-board-hook$/);
  assert.doesNotMatch(written.hooks.UserPromptSubmit[0].hooks[0].command, /\\/);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.bak-agent-board-')));

  uninstall({ settingsPath: file, mcp: false, log: () => {} });
  const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cleaned.hooks, undefined);
  assert.deepEqual(cleaned.permissions, { allow: ['Bash(ls:*)'] });
});

test('settings.json 壞掉時拒絕安裝，不覆蓋', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => install({ settingsPath: file, mcp: false, log: () => {} }), /不是合法的 JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});
