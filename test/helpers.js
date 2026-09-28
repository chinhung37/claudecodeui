'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'));
}

async function startTestServer() {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'board.json'), { saveDelayMs: 10 }).load();
  const cfg = { host: '127.0.0.1', port: 0, url: '', inject: 'always', dataDir: dir, autostart: false };
  const server = createServer({ store, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cfg.port = server.address().port;
  cfg.url = `http://127.0.0.1:${cfg.port}`;
  const env = {
    ...process.env,
    AGENT_BOARD_PORT: String(cfg.port),
    AGENT_BOARD_HOST: '127.0.0.1',
    AGENT_BOARD_HOME: dir,
    AGENT_BOARD_AUTOSTART: '0',
  };
  return {
    store,
    cfg,
    dir,
    env,
    close: () => new Promise((r) => server.close(r)),
    closeAll: () => {
      server.closeAllConnections && server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

function runNode(script, { input = '', env = process.env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: ${script}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

module.exports = { tmpDir, startTestServer, runNode };
