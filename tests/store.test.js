/*
 * Persistência: codec do Firestore e fila de gravação (com cliente falso).
 * Roda sem rede e sem credenciais: node tests/store.test.js
 */
'use strict';

const assert = require('assert');
const Engine = require('../public/assets/js/engine.js');
const firestore = require('../lib/firestore.js');
const { createStore, ROOM_TTL_MS, _internals } = require('../lib/store.js');

const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((error) => results.push({ name, ok: false, error: error.message }));
}

function fakeClient() {
  const docs = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  return {
    projectId: 'teste',
    docs,
    async get(parts) {
      const key = parts.join('/');
      return docs.has(key) ? clone(docs.get(key)) : null;
    },
    async create(collectionParts, id, value) {
      const key = collectionParts.concat(id).join('/');
      if (docs.has(key)) {
        const error = new Error('documento já existe');
        error.status = 409;
        error.conflict = true;
        throw error;
      }
      docs.set(key, clone(value));
      return { id, data: clone(value) };
    },
    async set(parts, value) {
      docs.set(parts.join('/'), clone(value));
      return { id: parts[parts.length - 1], data: clone(value) };
    },
    async remove(parts) {
      docs.delete(parts.join('/'));
    },
    async list(collectionParts) {
      const prefix = collectionParts.join('/') + '/';
      return Array.from(docs.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ id: key.slice(prefix.length), data: clone(docs.get(key)) }));
    }
  };
}

async function run() {
  await test('codec do Firestore preserva strings, números, listas e mapas', () => {
    const sample = {
      text: 'Olá, mundo! 🦊',
      inteiro: 42,
      decimal: 1.5,
      sim: true,
      nao: false,
      vazio: '',
      nulo: null,
      lista: [1, '2', false, null, { x: 'y' }],
      listaVazia: [],
      mapaVazio: {},
      aninhado: { a: { b: 'c' } }
    };
    const encoded = firestore._internals.encodeFields(sample);
    const decoded = firestore._internals.decodeFields(encoded);
    assert.deepStrictEqual(decoded, sample);
  });

  await test('snapshot separa fotos sem alterar a sala em memória', () => {
    const photo = 'data:image/jpeg;base64,AAAA';
    const room = Engine.createRoom({
      id: 'user_ana_1',
      name: 'Ana',
      avatar: { kind: 'photo', value: photo }
    }, 'ABC123');

    const snapshot = _internals.snapshotForStorage(room);
    assert.strictEqual(room.users[0].avatar.value, photo);
    assert.strictEqual(snapshot.photos.user_ana_1.value, photo);
    assert.strictEqual(snapshot.room.users[0].avatar.value, '');
    assert.strictEqual(snapshot.room.users[0].avatar.kind, 'photo');
  });

  await test('foto ausente vira emoji em vez de imagem quebrada', () => {
    const room = Engine.createRoom({ id: 'user_bia_1', name: 'Bia' }, 'ABC123');
    room.users[0].avatar = { kind: 'photo', value: '' };
    _internals.applyStoredPhotos(room, {});
    assert.strictEqual(room.users[0].avatar.kind, 'emoji');
    assert.ok(room.users[0].avatar.value.length > 0);
  });

  await test('sala antiga é considerada expirada após 6 horas', () => {
    const now = Date.now();
    assert.strictEqual(_internals.isStale({ updatedAt: now }, now), false);
    assert.strictEqual(_internals.isStale({ updatedAt: now - ROOM_TTL_MS - 1 }, now), true);
    assert.strictEqual(_internals.isStale({ updatedAt: 0 }, now), false);
  });

  await test('createRoom grava documento principal e subdocumento da foto', async () => {
    const client = fakeClient();
    const store = createStore({ client });
    const photo = 'data:image/jpeg;base64,BBBB';
    const room = Engine.createRoom({
      id: 'user_ana_1',
      name: 'Ana',
      avatar: { kind: 'photo', value: photo }
    }, 'ABC123');

    await store.createRoom(room);

    const main = client.docs.get('rooms/ABC123');
    const avatar = client.docs.get('rooms/ABC123/avatars/user_ana_1');
    assert.ok(main);
    assert.ok(avatar);
    assert.strictEqual(main.users[0].avatar.value, '');
    assert.strictEqual(avatar.avatar.value, photo);
  });

  await test('loadRoom junta a foto salva no subdocumento', async () => {
    const client = fakeClient();
    const store = createStore({ client });
    const photo = 'data:image/jpeg;base64,CCCC';
    const room = Engine.createRoom({
      id: 'user_ana_1',
      name: 'Ana',
      avatar: { kind: 'photo', value: photo }
    }, 'ABC123');

    await store.createRoom(room);
    const loaded = await store.loadRoom('ABC123');

    assert.ok(loaded);
    assert.strictEqual(loaded.users[0].name, 'Ana');
    assert.strictEqual(loaded.users[0].avatar.value, photo);
  });

  await test('saveRoom faz flush da última versão da sala', async () => {
    const client = fakeClient();
    const store = createStore({ client });
    const room = Engine.createRoom({ id: 'user_ana_1', name: 'Ana' }, 'ABC123');

    await store.createRoom(room);
    room.users[0].name = 'Ana Paula';
    store.saveRoom(room);
    await store.flush();

    const saved = client.docs.get('rooms/ABC123');
    assert.strictEqual(saved.users[0].name, 'Ana Paula');
    assert.strictEqual(store.status().pending, 0);
  });

  await test('deleteRoom apaga documento principal e fotos', async () => {
    const client = fakeClient();
    const store = createStore({ client });
    const photo = 'data:image/jpeg;base64,DDDD';
    const room = Engine.createRoom({
      id: 'user_ana_1',
      name: 'Ana',
      avatar: { kind: 'photo', value: photo }
    }, 'ABC123');

    await store.createRoom(room);
    await store.deleteRoom('ABC123');

    assert.strictEqual(client.docs.has('rooms/ABC123'), false);
    assert.strictEqual(client.docs.has('rooms/ABC123/avatars/user_ana_1'), false);
  });

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
    console.log(`Tudo certo! ${results.length} testes de persistência passaram.`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
