'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, BoardError } = require('./store');
const { handleHook } = require('./events');
const { config: loadConfig } = require('./config');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const MAX_BODY = 5 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BoardError(413, 'request body 太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BoardError(400, 'JSON 格式錯誤'));
      }
    });
    req.on('error', reject);
  });
}

// 從 request body 取出操作者：面板是 user，MCP 帶 actor = 'agent:<boardId>'
function actorOf(body) {
  const a = body && body.actor;
  if (typeof a === 'string' && /^agent:[\w.-]+$/.test(a)) return a;
  return 'user';
}

function createServer({ store, cfg, onShutdown }) {
  const clients = new Set();
  let broadcastTimer = null;

  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const data = `event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
      for (const res of clients) res.write(data);
    }, 60);
  }
  store.on('change', broadcast);

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  const loopbackOnly = LOOPBACK.has(cfg.host);

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    // 防 DNS rebinding：只綁本機時，只接受 Host 是本機名稱的請求
    if (loopbackOnly) {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK.has(host)) return send(res, 403, { error: 'forbidden host' });
    }

    if (method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), type);
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    // 跨站防護：所有會改資料的請求都要帶自訂 header（瀏覽器跨站送不出來）
    if (method !== 'GET' && req.headers['x-agent-board'] !== '1') {
      return send(res, 403, { error: '缺少 X-Agent-Board header' });
    }

    if (method === 'GET' && p === '/api/health') {
      return send(res, 200, { ok: true, app: 'agent-board', version: pkg.version, pid: process.pid });
    }
    if (method === 'POST' && p === '/api/shutdown') {
      send(res, 200, { ok: true });
      if (onShutdown) setTimeout(onShutdown, 50);
      return;
    }
    if (method === 'GET' && p === '/api/state') return send(res, 200, store.snapshot());
    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
    const actor = actorOf(body);

    if (method === 'POST' && p === '/api/hook') {
      return send(res, 200, handleHook(store, body, { boardUrl: cfg.url, inject: cfg.inject }));
    }
    if (method === 'POST' && p === '/api/agents') {
      return send(res, 201, store.createManual(body, actor));
    }

    let m = p.match(/^\/api\/agents\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') return send(res, 200, store.get(id));
      if (method === 'PATCH') return send(res, 200, store.updateAgent(id, body, actor));
      if (method === 'DELETE') return send(res, 200, { removed: store.removeAgent(id).id });
    }

    m = p.match(/^\/api\/agents\/([^/]+)\/adopt$/);
    if (m && method === 'POST') {
      return send(res, 200, store.adopt(decodeURIComponent(m[1]), body.from, actor));
    }

    m = p.match(/^\/api\/agents\/([^/]+)\/seen$/);
    if (m && method === 'POST') {
      const agent = store.get(decodeURIComponent(m[1]));
      store.markDelivered(agent);
      return send(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/agents\/([^/]+)\/todos$/);
    if (m && method === 'POST') {
      return send(res, 201, store.addTodo(decodeURIComponent(m[1]), body, actor));
    }
    m = p.match(/^\/api\/agents\/([^/]+)\/todos\/reorder$/);
    if (m && method === 'POST') {
      return send(res, 200, store.reorderTodos(decodeURIComponent(m[1]), body.ids || [], actor));
    }
    m = p.match(/^\/api\/agents\/([^/]+)\/todos\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const todoId = decodeURIComponent(m[2]);
      if (method === 'PATCH') return send(res, 200, store.updateTodo(id, todoId, body, actor));
      if (method === 'DELETE') {
        const actorQ = url.searchParams.get('actor');
        return send(res, 200, store.removeTodo(id, todoId, actorOf({ actor: actorQ })));
      }
    }

    m = p.match(/^\/api\/agents\/([^/]+)\/notes$/);
    if (m && method === 'POST') {
      return send(res, 201, store.addNote(decodeURIComponent(m[1]), body, actor));
    }
    m = p.match(/^\/api\/agents\/([^/]+)\/notes\/([^/]+)$/);
    if (m && method === 'DELETE') {
      store.removeNote(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof BoardError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    });
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });
  return server;
}

function start(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const store = new Store(cfg.dataFile).load();
  const server = createServer({
    store,
    cfg,
    onShutdown: () => {
      store.flush();
      process.exit(0);
    },
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const flush = () => {
        try {
          store.flush();
        } catch {}
      };
      process.once('exit', flush);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(sig, () => {
          flush();
          process.exit(0);
        });
      }
      resolve({ server, store, cfg });
    });
  });
}

module.exports = { createServer, start };

if (require.main === module) {
  start()
    .then(({ cfg }) => {
      console.log(`Agent Board 已啟動: ${cfg.url}`);
      console.log(`資料檔: ${cfg.dataFile}`);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`連接埠 ${loadConfig().port} 已被使用（可能 Agent Board 已經在跑了）`);
        process.exit(0);
      }
      console.error(err);
      process.exit(1);
    });
}
