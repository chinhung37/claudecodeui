'use strict';

// 產生注入給 agent 的文字。原則：精簡，每次 prompt 都會送，所以不要塞太多。

const MAX_OPEN = 25;
const MAX_DONE = 3;

const MARK = { pending: '[ ]', in_progress: '[>]', done: '[x]' };

function shortId(id) {
  return String(id).slice(0, 8);
}

function renderTodos(agent) {
  const open = agent.todos.filter((t) => t.status !== 'done');
  const done = agent.todos.filter((t) => t.status === 'done');
  const lines = [];
  lines.push(`待辦（未完成 ${open.length} / 共 ${agent.todos.length}，越上面越優先）:`);
  if (!agent.todos.length) lines.push('  (目前沒有)');
  for (const t of open.slice(0, MAX_OPEN)) lines.push(`  ${MARK[t.status]} ${t.id} ${t.text}${t.by === 'user' ? ' (使用者)' : ''}`);
  if (open.length > MAX_OPEN) lines.push(`  …還有 ${open.length - MAX_OPEN} 項，用 board_get 看完整清單`);
  const recentDone = done.slice(-MAX_DONE);
  for (const t of recentDone) lines.push(`  ${MARK.done} ${t.id} ${t.text}`);
  if (done.length > MAX_DONE) lines.push(`  （另有 ${done.length - MAX_DONE} 項已完成未列出）`);
  return lines;
}

function renderNotes(notes) {
  if (!notes.length) return [];
  const lines = ['使用者/其他 agent 給你的新留言（請優先處理）:'];
  for (const n of notes) {
    const from = n.from === 'user' ? '使用者' : `agent ${shortId(n.from)}`;
    lines.push(`  - ${n.id} [${from}] ${n.text}`);
  }
  return lines;
}

function renderChanges(changes) {
  if (!changes.length) return [];
  const lines = ['自上次以來看板被別人改過:'];
  for (const c of changes.slice(-10)) lines.push(`  - ${c.text}`);
  if (changes.length > 10) lines.push(`  …還有 ${changes.length - 10} 筆較舊的變更`);
  return lines;
}

function header(agent, boardUrl) {
  return `[Agent Board] 你的 board_id: ${agent.id}${boardUrl ? `（面板 ${boardUrl}）` : ''}`;
}

function goalLine(agent) {
  if (agent.goal) return `目標: ${agent.goal}`;
  return '目標: (尚未設定) — 請用 board_set_goal 寫下這個對話要替使用者達成的目標（一句話），並用 board_add_todo 列出主要待辦。';
}

const RULES = [
  '看板規則: 這張卡片是使用者用來追蹤多個對話的地方。',
  '  - 開始做某個待辦時用 board_update_todo 設成 in_progress，做完設成 done；發現新工作用 board_add_todo。',
  '  - 目標改變時用 board_set_goal 更新；用 board_set_focus 簡述你現在在做什麼。',
  '  - 使用者在面板改的待辦與留言優先於你自己的計畫。所有 board_* 工具都要帶上面的 board_id。',
];

// 新對話 / 壓縮後 / 恢復時：完整版
function sessionContext(agent, { boardUrl, others = [], candidates = [], pendingChanges = [], notes = [] } = {}) {
  const lines = [header(agent, boardUrl), goalLine(agent)];
  if (agent.focus) lines.push(`上次回報的焦點: ${agent.focus}`);
  lines.push(...renderTodos(agent));
  lines.push(...renderNotes(notes));
  lines.push(...renderChanges(pendingChanges));
  if (!agent.goal && candidates.length) {
    lines.push('同一個專案還有這些未完成的卡片，如果這個對話是接續其中之一，請先跟使用者確認，再用 board_adopt 接過來:');
    for (const c of candidates.slice(0, 5)) {
      const open = c.todos.filter((t) => t.status !== 'done').length;
      lines.push(`  - ${c.id} 「${c.goal || c.name || '(無目標)'}」未完成待辦 ${open}`);
    }
  }
  if (others.length) {
    lines.push('其他進行中的 agent（避免重複工作）:');
    for (const o of others.slice(0, 8)) {
      lines.push(`  - ${shortId(o.id)} [${o.project || '-'}] ${o.status} — ${o.goal || '(無目標)'}`);
    }
  }
  lines.push(...RULES);
  return lines.join('\n');
}

// 每次使用者送出 prompt：精簡版
function promptContext(agent, { boardUrl, pendingChanges = [], notes = [] } = {}) {
  const lines = [header(agent, boardUrl), goalLine(agent)];
  lines.push(...renderTodos(agent));
  lines.push(...renderNotes(notes));
  lines.push(...renderChanges(pendingChanges));
  lines.push('（完成或開始待辦時請用 board_update_todo 更新看板）');
  return lines.join('\n');
}

// 工作途中：只有看板被別人改過才送
function changesContext(agent, { boardUrl, pendingChanges = [], notes = [] } = {}) {
  if (!pendingChanges.length && !notes.length) return '';
  const lines = [`[Agent Board] 使用者剛在面板上更新了你的卡片 (board_id: ${agent.id}${boardUrl ? `，${boardUrl}` : ''})`];
  lines.push(...renderNotes(notes));
  lines.push(...renderChanges(pendingChanges));
  lines.push(goalLine(agent));
  lines.push(...renderTodos(agent));
  lines.push('請依照更新後的內容調整接下來的工作。');
  return lines.join('\n');
}

module.exports = { sessionContext, promptContext, changesContext, renderTodos, shortId };
