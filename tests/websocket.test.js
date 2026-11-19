/*
 * Teste de integração do canal principal: dois clientes WebSocket na mesma
 * sala recebem as ações na hora, sem depender do polling de 2,5 s.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

function assert(value, message) {
  if (!value) throw new Error(message || 'esperava um valor verdadeiro');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || 'valores diferentes') +
      ': recebido ' + JSON.stringify(actual) + ', esperado ' + JSON.stringify(expected)
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const pending = [];

    function deliver(payload) {
      messages.push(payload);
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i];
        if (!item.test(payload)) continue;
        clearTimeout(item.timer);
        pending.splice(i, 1);
        item.resolve(payload);
      }
    }

    ws.on('message', (raw) => {
      let payload = null;
      try { payload = JSON.parse(raw.toString()); } catch (error) { return; }
      deliver(payload);
    });
    ws.on('error', () => { /* tratado pelo once abaixo e pelo close */ });
    ws.once('error', reject);
    ws.once('open', () => {
      resolve({
        messages,
        waitFor(test, timeout) {
          const found = messages.find(test);
          if (found) return Promise.resolve(found);
          return new Promise((resolveMatch, rejectMatch) => {
            const item = {
              test,
              resolve: resolveMatch,
              reject: rejectMatch,
              timer: setTimeout(() => {
                const index = pending.indexOf(item);
                if (index !== -1) pending.splice(index, 1);
                rejectMatch(new Error('tempo esgotado esperando mensagem do WebSocket'));
              }, timeout || 3000)
            };
            pending.push(item);
          });
        },
        send(payload) {
          ws.send(JSON.stringify(payload));
        },
        close() {
          try { ws.close(); } catch (error) { /* noop */ }
        }
      });
    });
  });
}

async function main() {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    FIREBASE_SERVICE_ACCOUNT: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    FIREBASE_PROJECT_ID: '',
    ALLOWED_ORIGINS: ''
  });

  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  const clients = [];

  async function call(pathname, options) {
    options = options || {};
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + pathname, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { status: response.status, data };
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(base + '/api/health');
        if (response.ok) { healthy = true; break; }
      } catch (error) { /* ainda subindo */ }
      await wait(100);
    }
    assert(healthy, 'o servidor não respondeu em /api/health');

    const created = await call('/api/rooms', {
      method: 'POST',
      body: { identity: { id: 'user_ana', name: 'Ana', avatar: { kind: 'emoji', value: '🦊' } } }
    });
    equal(created.status, 201, 'criação da sala');
    const code = created.data.code;

    const joined = await call('/api/rooms/' + code + '/join', {
      method: 'POST',
      body: { identity: { id: 'user_bia', name: 'Bia', avatar: { kind: 'emoji', value: '🐻' } } }
    });
    equal(joined.status, 200, 'entrada da segunda pessoa');

    const wsBase = 'ws://127.0.0.1:' + port + '/ws/rooms/' + code + '?userId=';
    const ana = await connect(wsBase + 'user_ana');
    clients.push(ana);
    await ana.waitFor((msg) => msg.type === 'state' && msg.state, 3000);

    const bia = await connect(wsBase + 'user_bia');
    clients.push(bia);
    await bia.waitFor((msg) => msg.type === 'state' && msg.state, 3000);

    const started = Date.now();
    const action = await call('/api/rooms/' + code + '/actions', {
      method: 'POST',
      body: { userId: 'user_ana', type: 'card:add', payload: { column: 'acertos', text: 'Card ao vivo' } }
    });
    equal(action.status, 200, 'ação pelo REST');

    const pushed = await bia.waitFor((msg) => msg.type === 'state' && msg.event && msg.event.kind === 'card-added', 2000);
    equal(pushed.state.acertos.cards.length, 1, 'o outro cliente recebe o card novo');
    assert(Date.now() - started < 1500, 'a ação chegou sem esperar o polling');

    ana.send({ type: 'ping' });
    const pong = await ana.waitFor((msg) => msg.type === 'pong', 1000);
    assert(pong, 'o servidor responde ao ping do cliente');

    const callResult = await call('/api/rooms/' + code + '/actions', {
      method: 'POST',
      body: { userId: 'user_ana', type: 'dynamics:call', payload: {} }
    });
    equal(callResult.status, 200, 'chamada para a dinâmica');
    const called = await bia.waitFor(
      (msg) => msg.type === 'state' && msg.event && msg.event.kind === 'dynamics-call',
      2000
    );
    assert(called.state.dynamics.call, 'o chamado aparece no estado enviado ao outro cliente');
    equal(called.state.dynamics.call.by, 'user_ana', 'o organizador que chamou');

    const rejected = await new Promise((resolve) => {
      const bad = new WebSocket(wsBase + 'intruso');
      bad.once('open', () => {
        try { bad.close(); } catch (error) { /* noop */ }
        resolve(false);
      });
      bad.once('error', () => resolve(true));
    });
    assert(rejected, 'usuário de fora não abre WebSocket na sala');

    console.log('  ✓ WebSocket ao vivo');
  } catch (error) {
    console.error('\n[websocket.test] falhou:', error.message);
    if (logs.trim()) console.error(logs.trim());
    process.exitCode = 1;
  } finally {
    clients.forEach((client) => client.close());
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch (error) { /* noop */ }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error('[websocket.test]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
