/*
 * Teste de integração da administração: sobe o servidor em memória com
 * ADMIN_KEY e exercita as rotas protegidas com fetch nativo do Node 18+.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_KEY = 'test-admin-key-123';

function assert(value, message) {
  if (!value) throw new Error(message || 'esperava um valor verdadeiro');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'valores diferentes') + ': recebido ' + JSON.stringify(actual) + ', esperado ' + JSON.stringify(expected));
  }
}

function identity(id, name) {
  return { id, name, avatar: { kind: 'emoji', value: '🦊' } };
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
    ADMIN_KEY,
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
    if (options.key) headers.Authorization = 'Bearer ' + options.key;
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
      body: { identity: identity('user_ana', 'Ana') }
    });
    equal(created.status, 201, 'criação da sala');
    const code = created.data.code;
    assert(code, 'código da sala');

    const unauth = await call('/api/admin/rooms');
    equal(unauth.status, 401, 'listagem sem chave');

    const wrong = await call('/api/admin/session', { method: 'POST', key: 'errada' });
    equal(wrong.status, 401, 'sessão com chave errada');

    const session = await call('/api/admin/session', { method: 'POST', key: ADMIN_KEY });
    equal(session.status, 200, 'sessão com chave certa');

    const list = await call('/api/admin/rooms', { key: ADMIN_KEY });
    equal(list.status, 200, 'listagem autenticada');
    assert(list.data.rooms.some((room) => room.code === code), 'a sala criada aparece na listagem');

    const joined = await call('/api/rooms/' + code + '/join', {
      method: 'POST',
      body: { identity: identity('user_bia', 'Bia') }
    });
    equal(joined.status, 200, 'entrada da segunda pessoa');

    const detail = await call('/api/admin/rooms/' + code, { key: ADMIN_KEY });
    equal(detail.status, 200, 'detalhe da sala');
    equal(detail.data.room.users.length, 2, 'duas pessoas no detalhe');

    const added = await call('/api/admin/rooms/' + code + '/cards', {
      method: 'POST',
      key: ADMIN_KEY,
      body: { column: 'acertos', text: 'Card da administração', authorId: 'user_bia' }
    });
    equal(added.status, 200, 'adição de card');
    equal(added.data.room.acertos.count, 1, 'card adicionado');
    equal(added.data.room.acertos.cards[0].authorName, 'Bia', 'autor do card');
    const cardId = added.data.room.acertos.cards[0].id;

    const edited = await call('/api/admin/rooms/' + code + '/cards/' + cardId + '/edit', {
      method: 'POST',
      key: ADMIN_KEY,
      body: { column: 'acertos', text: 'Card revisado' }
    });
    equal(edited.status, 200, 'edição de card');
    equal(edited.data.room.acertos.cards[0].text, 'Card revisado', 'texto editado');

    const removedUser = await call('/api/admin/rooms/' + code + '/users/user_bia/remove', {
      method: 'POST',
      key: ADMIN_KEY
    });
    equal(removedUser.status, 200, 'remoção de pessoa');
    equal(removedUser.data.room.users.length, 1, 'pessoa removida');
    equal(removedUser.data.room.organizerId, 'user_ana', 'organizador preservado');

    const removedOrg = await call('/api/admin/rooms/' + code + '/users/user_ana/remove', {
      method: 'POST',
      key: ADMIN_KEY
    });
    equal(removedOrg.status, 200, 'remoção do organizador');
    equal(removedOrg.data.room.users.length, 0, 'sala vazia');
    equal(removedOrg.data.room.organizerId, '', 'sem organizador quando não há ninguém');

    const deleted = await call('/api/admin/rooms/' + code + '/delete', {
      method: 'POST',
      key: ADMIN_KEY
    });
    equal(deleted.status, 200, 'encerramento da sala');
    assert(deleted.data.deleted, 'sala marcada como apagada');

    const gone = await call('/api/rooms/' + code);
    equal(gone.status, 404, 'sala some depois de encerrada');

    console.log('  ✓ rotas de administração');
  } catch (error) {
    console.error('\n[admin.test] falhou:', error.message);
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
  console.error('[admin.test]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
