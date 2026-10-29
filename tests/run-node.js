/* Roda os casos do motor no Node: npm test */
'use strict';

const engine = require('../shared/engine.js');
const cases = require('./cases.js');

const assert = {
  ok(value, message) {
    if (!value) throw new Error(message || 'esperava um valor verdadeiro');
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        (message || 'valores diferentes') +
        ': recebido ' + JSON.stringify(actual) + ', esperado ' + JSON.stringify(expected)
      );
    }
  },
  notEqual(actual, expected, message) {
    if (actual === expected) throw new Error(message || 'esperava valores diferentes');
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((message || 'estruturas diferentes') + ': ' + a + ' != ' + b);
  }
};

const results = cases.run(engine, assert);
const passed = results.filter((result) => result.ok).length;
const failed = results.length - passed;

results.forEach((result) => {
  if (result.ok) {
    console.log('  ✓ ' + result.name);
  } else {
    console.log('  ✕ ' + result.name);
    console.log('    ' + result.error);
  }
});

console.log('');
if (failed) {
  console.log(`${failed} falha(s) — ${passed} de ${results.length} testes passaram.`);
  process.exitCode = 1;
} else {
  console.log(`Tudo certo! ${passed} testes passaram.`);
}
