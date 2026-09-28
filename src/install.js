'use strict';

// 把 Agent Board 的 hooks 合併進 Claude Code 的 settings.json，並註冊 MCP server。
// 會先備份原檔；重複執行不會重複加入。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const MCP_SCRIPT = path.join(__dirname, 'mcp.js');
const MCP_NAME = 'agent-board';
// 加在 hook 指令尾端的標記參數，用來辨認哪些 hooks 是我們裝的（資料夾搬家或改名也認得）
const MARKER_ARG = '--agent-board-hook';
// 放行看板 MCP 的所有工具（只會讀寫本機看板）。實測 Claude Code 2.1.283：寫 server 名稱即涵蓋全部工具
const ALLOW_RULE = `mcp__${MCP_NAME}`;

const FULL_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
];

function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// Windows 路徑一律轉成正斜線：cmd、Git Bash、PowerShell 都吃得下
function slash(p) {
  return p.replace(/\\/g, '/');
}

function nodeOnPath() {
  const r = spawnSync('node', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' });
  return r.status === 0;
}

function nodeCommand() {
  return nodeOnPath() ? 'node' : `"${slash(process.execPath)}"`;
}

function hookCommand(node = nodeCommand()) {
  return `${node} "${slash(HOOK_SCRIPT)}" ${MARKER_ARG}`;
}

function isOurs(entry) {
  return (entry.hooks || []).some(
    (h) => typeof h.command === 'string' && (h.command.includes(MARKER_ARG) || h.command.includes(slash(HOOK_SCRIPT)))
  );
}

function stripOurs(settings) {
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
    if (!hooks[event].length) delete hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function addAllow(settings) {
  settings.permissions = settings.permissions || {};
  const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (!allow.includes(ALLOW_RULE)) allow.push(ALLOW_RULE);
  settings.permissions.allow = allow;
  return settings;
}

function stripAllow(settings) {
  const p = settings.permissions;
  if (!p || !Array.isArray(p.allow)) return settings;
  p.allow = p.allow.filter((r) => r !== ALLOW_RULE);
  if (!p.allow.length) delete p.allow;
  if (!Object.keys(p).length) delete settings.permissions;
  return settings;
}

function addOurs(settings, { minimal = false, command = hookCommand() } = {}) {
  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  const events = minimal ? FULL_EVENTS.filter((e) => e !== 'PreToolUse') : FULL_EVENTS;
  for (const event of events) {
    const entry = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (event === 'PreToolUse' || event === 'PostToolUse') entry.matcher = '*';
    if (minimal && event === 'PostToolUse') entry.matcher = 'TodoWrite|TaskCreate|TaskUpdate';
    settings.hooks[event] = [...(settings.hooks[event] || []), entry];
  }
  return settings;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON，為了不弄壞它，安裝中止。請先修好這個檔案。(${err.message})`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-agent-board-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return backup;
}

function quoteArg(a) {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function runClaude(args) {
  const cmd = ['claude', ...args].map(quoteArg).join(' ');
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { ok: r.status === 0, cmd, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function mcpAddArgs(node = nodeCommand().replace(/"/g, '')) {
  return ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', node, slash(MCP_SCRIPT)];
}

function install({
  settingsPath = defaultSettingsPath(),
  minimal = false,
  mcp = true,
  allow = true,
  dryRun = false,
  log = console.log,
} = {}) {
  const settings = readSettings(settingsPath);
  const next = addOurs(JSON.parse(JSON.stringify(settings)), { minimal });
  if (mcp && allow) addAllow(next);
  if (dryRun) {
    log(`[dry-run] 會寫入 ${settingsPath}:`);
    log(JSON.stringify({ hooks: next.hooks, permissions: next.permissions }, null, 2));
    if (mcp) log(`[dry-run] 會執行: ${['claude', ...mcpAddArgs()].map(quoteArg).join(' ')}`);
    return { settings: next };
  }
  const backup = writeSettings(settingsPath, next);
  log(`✔ hooks 已寫入 ${settingsPath}${backup ? `（原檔備份: ${backup}）` : ''}`);
  if (mcp && allow) log(`✔ 已在 permissions.allow 加入 "${ALLOW_RULE}"（agent 用看板工具時不再每次詢問；不要的話用 --no-allow）`);

  if (mcp) {
    runClaude(['mcp', 'remove', '--scope', 'user', MCP_NAME]);
    const r = runClaude(mcpAddArgs());
    if (r.ok) {
      log(`✔ MCP server "${MCP_NAME}" 已註冊（user scope）`);
    } else {
      log(`✘ 無法自動註冊 MCP（找不到 claude 指令或執行失敗）。請手動執行:\n  ${r.cmd}`);
      if (r.out) log(`  輸出: ${r.out}`);
    }
  }
  log('完成。已經開著的 Claude Code 對話要重新啟動（或 /resume）才會載入新的 hooks 與 MCP。');
  return { settings: next, backup };
}

function uninstall({ settingsPath = defaultSettingsPath(), mcp = true, log = console.log } = {}) {
  if (fs.existsSync(settingsPath)) {
    const settings = stripAllow(stripOurs(readSettings(settingsPath)));
    const backup = writeSettings(settingsPath, settings);
    log(`✔ 已從 ${settingsPath} 移除 Agent Board hooks（原檔備份: ${backup}）`);
  }
  if (mcp) {
    const r = runClaude(['mcp', 'remove', '--scope', 'user', MCP_NAME]);
    log(r.ok ? `✔ 已移除 MCP server "${MCP_NAME}"` : `請手動執行: ${r.cmd}`);
  }
}

module.exports = {
  install,
  uninstall,
  addOurs,
  stripOurs,
  addAllow,
  stripAllow,
  hookCommand,
  mcpAddArgs,
  defaultSettingsPath,
  FULL_EVENTS,
  ALLOW_RULE,
};
