/*
 * Teste de integração do fallback de sincronização: o SSE continua disponível
 * e o estado da sala também pode ser consultado por REST, para redes onde o
 * EventSource fica preso no proxy.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

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

  async function call(pathname, options) {
    options = options || {};
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + pathname, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { status: response.status, data, response };
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

    const first = await call('/api/rooms/' + code + '/state?userId=user_ana');
    equal(first.status, 200, 'consulta de estado com membro da sala');
    assert(first.data.state && first.data.state.isMember, 'estado do membro');
    const version = first.data.state.version;

    const stranger = await call('/api/rooms/' + code + '/state?userId=intruso');
    equal(stranger.status, 403, 'consulta de estado com usuário de fora');

    const action = await call('/api/rooms/' + code + '/actions', {
      method: 'POST',
      body: { userId: 'user_ana', type: 'card:add', payload: { column: 'acertos', text: 'Card pelo REST' } }
    });
    equal(action.status, 200, 'ação pelo REST');

    const second = await call('/api/rooms/' + code + '/state?userId=user_ana');
    equal(second.status, 200, 'segunda consulta de estado');
    assert(second.data.state.version > version, 'o fallback vê a versão atualizada');
    equal(second.data.state.acertos.cards.length, 1, 'o fallback vê o card novo');

    const reveal = await call('/api/rooms/' + code + '/actions', {
      method: 'POST',
      body: { userId: 'user_ana', type: 'column:reveal', payload: { column: 'acertos' } }
    });
    equal(reveal.status, 200, 'revelação dos acertos');

    const lateCard = await call('/api/rooms/' + code + '/actions', {
      method: 'POST',
      body: { userId: 'user_ana', type: 'card:add', payload: { column: 'acertos', text: 'Card tardio' } }
    });
    equal(lateCard.status, 400, 'novo card após revelação é recusado pela API');
    equal(lateCard.data.ok, false, 'a API sinaliza a recusa');

    const controller = new AbortController();
    const stream = await fetch(base + '/api/rooms/' + code + '/stream?userId=user_ana', {
      signal: controller.signal
    });
    try {
      equal(stream.status, 200, 'abertura do SSE');
      assert(String(stream.headers.get('content-type')).includes('text/event-stream'), 'content-type do SSE');
      const reader = stream.body.getReader();
      let received = '';
      while (!received.includes('"type":"state"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      assert(received.includes('"type":"state"'), 'o SSE envia o estado inicial');
    } finally {
      controller.abort();
    }

    console.log('  ✓ fallback de estado e SSE');
  } catch (error) {
    console.error('\n[stream-fallback.test] falhou:', error.message);
    if (logs.trim()) console.error(logs.trim());
    process.exitCode = 1;
  } finally {
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
  console.error('[stream-fallback.test]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
