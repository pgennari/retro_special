/*
 * Gerador de PDF: valida a estrutura do arquivo e o conteúdo exportado.
 *
 * Roda com Node: node tests/pdf.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'pdf.js'), 'utf8');
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

function createPdf() {
  const retro = {};
  const context = {
    window: { Retro: retro },
    Retro: retro,
    Uint8Array,
    String,
    Number,
    Array,
    Object,
    Math,
    JSON,
    console
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'pdf.js' });
  return context.Retro.pdf;
}

function toText(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function pdfString(lib, value) {
  return lib.encode(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function sampleData() {
  return {
    code: 'ABC123',
    generatedAt: '20/11/2026 10:00',
    columns: [
      {
        key: 'acertos',
        title: 'Acertos',
        revealed: true,
        cards: [
          { hidden: false, text: 'Deploy sem sustos', likes: 3, planText: '', assignees: [] },
          { hidden: true, text: 'SEGREDO NAO REVELADO', likes: 0, planText: 'Plano secreto', assignees: ['Ana'] }
        ]
      },
      {
        key: 'melhorias',
        title: 'Melhorias',
        revealed: true,
        cards: [
          {
            hidden: false,
            text: 'Revisão de código mais cedo',
            likes: 1,
            planText: 'Separar 30 minutos diários de revisão.',
            assignees: ['Ana', 'Bruno']
          },
          { hidden: false, text: 'Menos reuniões', likes: 0, planText: '', assignees: [] }
        ]
      }
    ]
  };
}

test('gera um PDF com cabeçalho, xref e trailer válidos', () => {
  const lib = createPdf();
  const pdf = toText(lib.build(sampleData()));
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.includes('/Type /Catalog'));
  assert.ok(pdf.includes('/Type /Pages'));
  assert.ok(pdf.includes('/Type /Font'));
  assert.ok(pdf.includes('xref\n0 '));
  assert.ok(pdf.includes('trailer\n<< /Size '));
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));
});

test('inclui cards, plano de ação e responsáveis no PDF', () => {
  const lib = createPdf();
  const enc = function (value) { return pdfString(lib, value); };
  const pdf = toText(lib.build(sampleData()));
  assert.ok(pdf.includes(enc('Retro Special — Relatório da sala ABC123')));
  assert.ok(pdf.includes(enc('Acertos (2)')));
  assert.ok(pdf.includes(enc('Melhorias (2)')));
  assert.ok(pdf.includes(enc('Deploy sem sustos')));
  assert.ok(pdf.includes(enc('Curtidas: 3')));
  assert.ok(pdf.includes(enc('Revisão de código mais cedo')));
  assert.ok(pdf.includes(enc('Plano de ação: Separar 30 minutos diários de revisão.')));
  assert.ok(pdf.includes(enc('Responsáveis: Ana, Bruno')));
  assert.ok(pdf.includes(enc('Sem plano de ação registrado.')));
});

test('não expõe o texto de cards ainda ocultos', () => {
  const lib = createPdf();
  const pdf = toText(lib.build(sampleData()));
  assert.ok(pdf.includes(pdfString(lib, '[Conteúdo oculto')));
  assert.ok(!pdf.includes('SEGREDO NAO REVELADO'));
  assert.ok(!pdf.includes('Plano secreto'));
});

test('quebra o conteúdo em várias páginas quando necessário', () => {
  const lib = createPdf();
  const enc = function (value) { return pdfString(lib, value); };
  const data = sampleData();
  data.columns[0].cards = [];
  for (let i = 0; i < 90; i += 1) {
    data.columns[0].cards.push({
      hidden: false,
      text: 'Cartão ' + (i + 1) + ' com um texto razoavelmente longo para ocupar espaço na página do relatório.',
      likes: i,
      planText: '',
      assignees: []
    });
  }
  const pdf = toText(lib.build(data));
  assert.ok(/\/Count \d+/.test(pdf));
  const count = Number(pdf.match(/\/Count (\d+)/)[1]);
  assert.ok(count > 1, 'deveria ter criado mais de uma página');
  assert.ok(pdf.includes(enc('página 1 de ' + count)));
  assert.ok(pdf.includes(enc('página ' + count + ' de ' + count)));
});

const failed = results.filter((result) => !result.ok);
results.forEach((result) => {
  if (result.ok) console.log('  ✓ ' + result.name);
  else {
    console.log('  ✕ ' + result.name);
    console.log('    ' + result.error);
  }
});

console.log('');
if (failed.length) {
  console.log(`${failed.length} falha(s) — ${results.length - failed.length} de ${results.length} testes passaram.`);
  process.exitCode = 1;
} else {
  console.log(`Tudo certo! ${results.length} testes de PDF passaram.`);
}
