/*
 * Identidade por janela: simula abas/janelas com localStorage compartilhado
 * e sessionStorage independente (como duas janelas anônimas do Chrome).
 *
 * Roda no Node sem dependências: node tests/identity.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'identity.js'), 'utf8');
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
  const session = sessionStorage || createStorage();
  const retro = {};
  const window = {
    localStorage,
    sessionStorage: session,
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
  return { identity: context.Retro.identity, session };
}

test('primeira janela começa sem identidade ativa e com id novo', () => {
  const local = createStorage();
  const tab = createTab(local);
  const identity = tab.identity.load();
  assert.ok(identity.id, 'deveria gerar um id');
  assert.strictEqual(identity.name, '');
  assert.strictEqual(tab.identity.isActive(), false);
});

test('confirmar o nome ativa a identidade apenas naquela janela', () => {
  const local = createStorage();
  const tab = createTab(local);
  tab.identity.setName('Ana');
  assert.strictEqual(tab.identity.isActive(), true);
  assert.strictEqual(tab.identity.load().name, 'Ana');
});

test('segunda janela herda só o perfil, nunca o id da primeira', () => {
  const local = createStorage();
  const first = createTab(local);
  first.identity.setName('Ana');
  const ana = first.identity.load();

  const second = createTab(local);
  const suggested = second.identity.load();
  assert.strictEqual(suggested.name, 'Ana', 'o nome deve vir preenchido como sugestão');
  assert.notStrictEqual(suggested.id, ana.id, 'o id da segunda janela deve ser diferente');
  assert.strictEqual(second.identity.isActive(), false, 'a segunda janela não deve entrar logada');
});

test('cada janela confirma sua própria pessoa e a sala vê participantes distintos', () => {
  const local = createStorage();
  const first = createTab(local);
  first.identity.setName('Ana');

  const second = createTab(local);
  second.identity.setName('Bruno');

  assert.strictEqual(first.identity.load().name, 'Ana');
  assert.strictEqual(second.identity.load().name, 'Bruno');
  assert.notStrictEqual(first.identity.load().id, second.identity.load().id);
});

test('recarregar a mesma janela mantém a pessoa ativa', () => {
  const local = createStorage();
  const tab = createTab(local);
  tab.identity.setName('Ana');
  const id = tab.identity.load().id;

  const reloaded = createTab(local, tab.session);
  assert.strictEqual(reloaded.identity.load().id, id);
  assert.strictEqual(reloaded.identity.load().name, 'Ana');
  assert.strictEqual(reloaded.identity.isActive(), true);
});

test('"outra pessoa" troca o id só daquela janela', () => {
  const local = createStorage();
  const first = createTab(local);
  first.identity.setName('Ana');
  const anaId = first.identity.load().id;

  const second = createTab(local);
  second.identity.setName('Bruno');
  const brunoId = second.identity.load().id;

  const outra = first.identity.startNewPerson();
  assert.notStrictEqual(outra.id, anaId);
  assert.strictEqual(outra.name, '');
  assert.strictEqual(second.identity.load().id, brunoId, 'a outra janela não pode mudar');

  first.identity.setName('Carla');
  assert.strictEqual(second.identity.load().name, 'Bruno');
  assert.strictEqual(first.identity.load().name, 'Carla');
});

test('nova janela depois de "outra pessoa" sugere o perfil mais recente', () => {
  const local = createStorage();
  const first = createTab(local);
  first.identity.setName('Ana');
  first.identity.startNewPerson();
  first.identity.setName('Carla');

  const third = createTab(local);
  const suggested = third.identity.load();
  assert.strictEqual(suggested.name, 'Carla');
  assert.notStrictEqual(suggested.id, first.identity.load().id);
  assert.strictEqual(third.identity.isActive(), false);
});

test('sem sessionStorage o app continua funcionando com o perfil local', () => {
  const local = createStorage();
  const blocked = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('bloqueado'); },
    removeItem() { throw new Error('bloqueado'); }
  };
  const first = createTab(local);
  first.identity.setName('Ana');

  const tab = createTab(local, blocked);
  assert.strictEqual(tab.identity.load().name, 'Ana');
  assert.strictEqual(tab.identity.isActive(), true);
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
