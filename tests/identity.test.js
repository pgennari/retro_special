/*
 * Identidade persistente: simula abrir uma nova aba/janela com o mesmo
 * localStorage (como acontece ao fechar e reabrir o browser).
 *
 * Roda com Node: node tests/identity.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'identity.js'), 'utf8');
const STORAGE_KEY = 'retro-special:identity:v1';
const LEGACY_KEY = 'retro-special:session:v1';
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function createStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return Array.from(map.keys())[index] || null;
    },
    get length() {
      return map.size;
    }
  };
}

function createTab(localStorage, sessionStorage) {
  const retro = {};
  const window = {
    localStorage,
    sessionStorage: sessionStorage || createStorage(),
    crypto: webcrypto,
    Retro: retro
  };
  const context = {
    window,
    Retro: retro,
    console,
    Date,
    Math,
    JSON
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'identity.js' });
  return context.Retro.identity;
}

test('primeira visita começa sem identidade ativa e com id novo', () => {
  const identity = createTab(createStorage());
  const value = identity.load();
  assert.ok(value.id, 'deveria gerar um id');
  assert.strictEqual(value.name, '');
  assert.strictEqual(identity.isActive(), false);
});

test('confirmar o nome salva a identidade no navegador', () => {
  const local = createStorage();
  const identity = createTab(local);
  identity.setName('Ana');

  assert.strictEqual(identity.isActive(), true);
  const saved = JSON.parse(local.getItem(STORAGE_KEY));
  assert.strictEqual(saved.id, identity.load().id);
  assert.strictEqual(saved.name, 'Ana');
});

test('fechar o browser e abrir a mesma sala reconecta com o mesmo id', () => {
  const local = createStorage();
  const first = createTab(local);
  first.setName('Ana');
  const id = first.load().id;

  const reopened = createTab(local);
  assert.strictEqual(reopened.load().id, id);
  assert.strictEqual(reopened.load().name, 'Ana');
  assert.strictEqual(reopened.isActive(), true);
});

test('nova aba começa com a mesma identidade salva', () => {
  const local = createStorage();
  const first = createTab(local);
  first.setName('Ana');

  const second = createTab(local);
  assert.strictEqual(second.load().id, first.load().id);
  assert.strictEqual(second.load().name, 'Ana');
  assert.strictEqual(second.isActive(), true);
});

test('editar o nome mantém o id da pessoa', () => {
  const local = createStorage();
  const identity = createTab(local);
  identity.setName('Ana');
  const id = identity.load().id;

  identity.setName('Ana Souza');
  assert.strictEqual(identity.load().id, id);

  const reopened = createTab(local);
  assert.strictEqual(reopened.load().id, id);
  assert.strictEqual(reopened.load().name, 'Ana Souza');
});

test('trocar pessoa gera novo id e pede o nome antes de salvar', () => {
  const local = createStorage();
  const identity = createTab(local);
  identity.setName('Ana');
  const anaId = identity.load().id;

  const changed = identity.startNewPerson();
  assert.notStrictEqual(changed.id, anaId);
  assert.strictEqual(changed.name, '');
  assert.strictEqual(identity.isActive(), false, 'não deve entrar sem confirmar o nome');

  identity.setName('Bruno');
  assert.strictEqual(identity.load().id, changed.id);

  const reopened = createTab(local);
  assert.strictEqual(reopened.load().id, changed.id);
  assert.strictEqual(reopened.load().name, 'Bruno');
});

test('identidade antiga do sessionStorage é migrada para o localStorage', () => {
  const local = createStorage();
  const legacy = createStorage();
  legacy.setItem(LEGACY_KEY, JSON.stringify({
    id: 'user_legacy123',
    name: 'Ana',
    avatar: { kind: 'emoji', value: '🦊', bg: 'linear-gradient(135deg,#ff7ab6,#7b2cff)' }
  }));

  const identity = createTab(local, legacy);
  assert.strictEqual(identity.load().id, 'user_legacy123');
  assert.strictEqual(JSON.parse(local.getItem(STORAGE_KEY)).name, 'Ana');

  const reopened = createTab(local);
  assert.strictEqual(reopened.load().id, 'user_legacy123');
  assert.strictEqual(reopened.isActive(), true);
});

test('sem localStorage o app continua funcionando em memória', () => {
  const blocked = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('bloqueado'); },
    removeItem() { throw new Error('bloqueado'); }
  };
  const identity = createTab(blocked);
  identity.setName('Ana');
  assert.strictEqual(identity.load().name, 'Ana');
  assert.strictEqual(identity.isActive(), true);
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
  console.log(`Tudo certo! ${results.length} testes de identidade passaram.`);
}
