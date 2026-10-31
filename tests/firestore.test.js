/*
 * Integração do cliente Firestore contra um servidor REST falso.
 * Valida JWT, rotas, codec e criação atômica sem tocar no Google.
 * Roda sem dependências: node tests/firestore.test.js
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const firestore = require('../lib/firestore.js');
const { createStore } = require('../lib/store.js');
const Engine = require('../public/assets/js/engine.js');

const PREFIX = '/v1/projects/teste/databases/(default)/documents';
const docs = new Map();
let tokenRequests = 0;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const text = await readRaw(req);
  if (!text) return null;
  return JSON.parse(text);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function documentResponse(key) {
  return {
    name: 'projects/teste/databases/(default)/documents/' + key,
    fields: firestore._internals.encodeFields(docs.get(key))
  };
}

function createMockServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/token' && req.method === 'POST') {
      tokenRequests += 1;
      const body = await readRaw(req);
      if (!body || body.indexOf('assertion=') === -1) return send(res, 400, { error: 'missing assertion' });
      return send(res, 200, { access_token: 'token-falso', expires_in: 3600, token_type: 'Bearer' });
    }

    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, { error: 'not found' });
    if (req.headers.authorization !== 'Bearer token-falso') {
      return send(res, 401, { error: 'unauthorized' });
    }

    const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent);
    const key = segments.join('/');
    const isCollection = segments.length % 2 === 1;

    if (req.method === 'GET' && isCollection) {
      const prefix = key + '/';
      const children = Array.from(docs.keys())
        .filter((name) => name.startsWith(prefix) && name.slice(prefix.length).indexOf('/') === -1)
        .map(documentResponse);
      return send(res, 200, children.length ? { documents: children } : {});
    }

    if (req.method === 'GET') {
      if (!docs.has(key)) return send(res, 404, { error: { message: 'not found' } });
      return send(res, 200, documentResponse(key));
    }

    if (req.method === 'POST' && isCollection) {
      const id = url.searchParams.get('documentId');
      const fullKey = segments.concat(id).join('/');
      if (docs.has(fullKey)) return send(res, 409, { error: { message: 'already exists' } });
      const body = await readBody(req);
      docs.set(fullKey, firestore._internals.decodeFields((body && body.fields) || {}));
      return send(res, 200, documentResponse(fullKey));
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      docs.set(key, firestore._internals.decodeFields((body && body.fields) || {}));
      return send(res, 200, documentResponse(key));
    }

    if (req.method === 'DELETE') {
      docs.delete(key);
      return send(res, 200, {});
    }

    return send(res, 405, { error: 'method not allowed' });
  });
}

const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((error) => results.push({ name, ok: false, error: error.message }));
}

async function run() {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port + PREFIX;
  const tokenUri = 'http://127.0.0.1:' + port + '/token';

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const client = firestore.createClient({
    client_email: 'teste@example.com',
    private_key: privateKey,
    project_id: 'teste'
  }, { projectId: 'teste', baseUrl, tokenUri });

  const store = createStore({ client });

  try {
    await test('troca o JWT da service account por access token', async () => {
      const project = await client.get(['rooms', 'NAOEXISTE']);
      assert.strictEqual(project, null);
      assert.strictEqual(tokenRequests, 1);
    });

    await test('cria, carrega, salva e apaga uma sala pelo REST falso', async () => {
      const photo = 'data:image/jpeg;base64,EEEE';
      const room = Engine.createRoom({
        id: 'user_ana_1',
        name: 'Ana',
        avatar: { kind: 'photo', value: photo }
      }, 'ABC123');

      await store.createRoom(room);
      assert.strictEqual(docs.get('rooms/ABC123').users[0].avatar.value, '');
      assert.strictEqual(docs.get('rooms/ABC123/avatars/user_ana_1').avatar.value, photo);

      const loaded = await store.loadRoom('ABC123');
      assert.strictEqual(loaded.users[0].avatar.value, photo);

      loaded.users[0].name = 'Ana Paula';
      store.saveRoom(loaded);
      await store.flush();
      assert.strictEqual(docs.get('rooms/ABC123').users[0].name, 'Ana Paula');

      await store.deleteRoom('ABC123');
      assert.strictEqual(docs.has('rooms/ABC123'), false);
      assert.strictEqual(docs.has('rooms/ABC123/avatars/user_ana_1'), false);
    });

    await test('código repetido é reportado como conflito para a API tentar outro', async () => {
      const room = Engine.createRoom({ id: 'user_bia_1', name: 'Bia' }, 'ABC123');
      await store.createRoom(room);
      let error = null;
      try {
        await store.createRoom(room);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      assert.strictEqual(error.status, 409);
      assert.strictEqual(error.conflict, true);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((result) => !result.ok);
  results.forEach((result) => {
    if (result.ok) {
      console.log('  ✓ ' + result.name);
    } else {
      console.log('  ✕ ' + result.name);
      console.log('    ' + result.error);
    }
  });

  console.log('');
  if (failed.length) {
    console.log(`${failed.length} falha(s) — ${results.length - failed.length} de ${results.length} testes passaram.`);
    process.exitCode = 1;
  } else {
    console.log(`Tudo certo! ${results.length} testes de integração do Firestore passaram.`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
