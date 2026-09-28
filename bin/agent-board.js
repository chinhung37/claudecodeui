#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { config: loadConfig } = require('../src/config');
const { call, request } = require('../src/client');

const HELP = `Agent Board — 追蹤多個 Claude Code 對話的目標與待辦

用法: agent-board <指令> [選項]

  start [--open]        在前景啟動面板 server（預設 ${loadConfig().url}）
  open                  在瀏覽器開啟面板（server 沒開會自動在背景啟動）
  status                在終端機列出所有卡片
  stop                  關閉背景執行的 server
  install [選項]        把 hooks 寫進 ~/.claude/settings.json 並註冊 MCP
      --minimal           不裝 PreToolUse（少一點延遲，但看不到即時「目前在做」）
      --no-mcp            不註冊 MCP server
      --no-allow          不要在 permissions.allow 放行看板工具（agent 每次用都會詢問）
      --settings <檔案>   改寫其他 settings.json（例如專案的 .claude/settings.json）
      --dry-run           只顯示會寫入什麼
  uninstall [--settings <檔案>] [--no-mcp]

環境變數: AGENT_BOARD_PORT, AGENT_BOARD_HOME（資料夾）, AGENT_BOARD_INJECT=always|changes|off,
          AGENT_BOARD_AUTOSTART=0（不要自動啟動 server）`;

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function flag(args, name) {
  return args.includes(name);
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case 'start': {
      const { start } = require('../src/server');
      try {
        await start();
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          console.log(`連接埠 ${cfg.port} 已被使用，Agent Board 可能已經在跑: ${cfg.url}`);
          if (flag(args, '--open')) openBrowser(cfg.url);
          return;
        }
        throw err;
      }
      console.log(`Agent Board 已啟動: ${cfg.url}`);
      console.log(`資料檔: ${cfg.dataFile}（Ctrl+C 結束）`);
      if (flag(args, '--open')) openBrowser(cfg.url);
      return;
    }
    case 'open':
      await call('GET', '/api/health');
      openBrowser(cfg.url);
      console.log(cfg.url);
      return;
    case 'status': {
      const state = await call('GET', '/api/state', undefined, { noAutostart: true });
      const list = state.agents.filter((a) => !a.archived);
      if (!list.length) return console.log('(看板上沒有卡片)');
      for (const a of list) {
        const open = a.todos.filter((t) => t.status !== 'done');
        console.log(`● ${a.name || a.project || '-'}  [${a.status}]  ${a.id.slice(0, 8)}`);
        console.log(`  目標: ${a.goal || '(未設定)'}`);
        if (a.activity) console.log(`  目前: ${a.activity}`);
        for (const t of open) console.log(`  ${t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.id} ${t.text}`);
      }
      return;
    }
    case 'stop':
      try {
        await request(cfg, 'POST', '/api/shutdown', {});
        console.log('已關閉');
      } catch {
        console.log('server 沒有在跑');
      }
      return;
    case 'install':
      require('../src/install').install({
        settingsPath: option(args, '--settings'),
        minimal: flag(args, '--minimal'),
        mcp: !flag(args, '--no-mcp'),
        allow: !flag(args, '--no-allow'),
        dryRun: flag(args, '--dry-run'),
      });
      return;
    case 'uninstall':
      require('../src/install').uninstall({
        settingsPath: option(args, '--settings'),
        mcp: !flag(args, '--no-mcp'),
      });
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err.code === 'ECONNREFUSED' ? 'Agent Board server 沒有在跑（agent-board start）' : err.message);
  process.exit(1);
});
