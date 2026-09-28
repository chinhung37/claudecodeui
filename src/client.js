'use strict';

// hook 與 MCP 共用的 HTTP client。server 沒開時會自動在背景啟動它。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config: loadConfig } = require('./config');

const SERVER_SCRIPT = path.join(__dirname, 'server.js');

function request(cfg, method, urlPath, body, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host,
        port: cfg.port,
        method,
        path: urlPath,
        headers: {
          'X-Agent-Board': '1',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          if (res.statusCode >= 400) {
            const err = new Error((json && json.error) || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function spawnServer(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const out = fs.openSync(cfg.logFile, 'a');
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function waitForServer(cfg, totalMs = 4000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    try {
      const h = await request(cfg, 'GET', '/api/health', undefined, { timeoutMs: 500 });
      if (h && h.app === 'agent-board') return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EADDRNOTAVAIL']);

// 呼叫 API；連不上時（且允許自動啟動）先把 server 叫起來再重試一次
async function call(method, urlPath, body, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  try {
    return await request(cfg, method, urlPath, body, opts);
  } catch (err) {
    if (!UNREACHABLE.has(err.code) || !cfg.autostart || opts.noAutostart) throw err;
    spawnServer(cfg);
    if (!(await waitForServer(cfg))) throw err;
    return request(cfg, method, urlPath, body, opts);
  }
}

module.exports = { request, call, spawnServer, waitForServer };
