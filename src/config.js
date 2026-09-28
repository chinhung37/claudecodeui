'use strict';

const os = require('os');
const path = require('path');

const DEFAULT_PORT = 47821;

function config(env = process.env) {
  const port = Number(env.AGENT_BOARD_PORT) || DEFAULT_PORT;
  const host = env.AGENT_BOARD_HOST || '127.0.0.1';
  const dataDir = env.AGENT_BOARD_HOME || path.join(os.homedir(), '.agent-board');
  const inject = ['always', 'changes', 'off'].includes(env.AGENT_BOARD_INJECT) ? env.AGENT_BOARD_INJECT : 'always';
  return {
    port,
    host,
    dataDir,
    dataFile: path.join(dataDir, 'board.json'),
    logFile: path.join(dataDir, 'server.log'),
    inject,
    autostart: env.AGENT_BOARD_AUTOSTART !== '0',
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
  };
}

module.exports = { config, DEFAULT_PORT };
