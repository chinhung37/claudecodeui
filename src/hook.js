#!/usr/bin/env node
'use strict';

// Claude Code hook 入口：從 stdin 讀事件 JSON，丟給 Agent Board server，
// 若 server 回傳要注入的文字，就用 hookSpecificOutput.additionalContext 印出來。
// 任何錯誤都吞掉並 exit 0，絕不擋住 Claude Code。

const fs = require('fs');
const path = require('path');
const { call } = require('./client');
const { config: loadConfig } = require('./config');

const INJECTABLE = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);

// 看板只需要少數欄位；Write 的整個檔案內容、Bash 的大量輸出都不用送
const KEEP_INPUT = [
  'command', 'description', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'prompt',
  'todos', 'subject', 'activeForm', 'active_form', 'taskId', 'task_id', 'id', 'status',
];

function cut(v, max) {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : v;
}

function slim(payload) {
  const p = { ...payload, prompt: cut(payload.prompt, 4000), message: cut(payload.message, 1000) };
  if (p.tool_input && typeof p.tool_input === 'object') {
    const input = {};
    for (const k of KEEP_INPUT) if (p.tool_input[k] !== undefined) input[k] = cut(p.tool_input[k], 2000);
    p.tool_input = input;
  }
  if (p.tool_response !== undefined) {
    // 只有 TaskCreate 需要回應（拿 task id）
    p.tool_response = p.tool_name === 'TaskCreate' ? cut(typeof p.tool_response === 'string' ? p.tool_response : JSON.stringify(p.tool_response), 2000) : undefined;
  }
  return p;
}

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function logError(err) {
  if (process.env.AGENT_BOARD_DEBUG !== '1') return;
  try {
    const cfg = loadConfig();
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.dataDir, 'hook-error.log'), `${new Date().toISOString()} ${err && err.stack}\n`);
  } catch {}
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const event = payload.hook_event_name;
  // 只有會注入文字的事件才需要等久一點（server 可能要冷啟動）
  const timeoutMs = INJECTABLE.has(event) ? 2500 : 1200;
  const res = await call('POST', '/api/hook', slim(payload), { timeoutMs });
  if (res && res.additionalContext && INJECTABLE.has(event)) {
    const out = JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: res.additionalContext },
    });
    // 等 stdout 真的寫完再結束（Windows 上 pipe 寫入是非同步的）
    await new Promise((resolve) => process.stdout.write(out, resolve));
  }
}

if (require.main === module) {
  main()
    .catch(logError)
    .finally(() => process.exit(0));
}

module.exports = { slim };
