/* Retro Special — geração de PDF sem dependências externas */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  // A4 em pontos. Toda string montada aqui usa no máximo um byte por caractere
  // (WinAnsi), para que os offsets do xref e o /Length dos streams sejam exatos.
  var PAGE_W = 595.28;
  var PAGE_H = 841.89;
  var MARGIN = 46;
  var BOTTOM = 58;
  var CONTENT_W = PAGE_W - MARGIN * 2;

  var INK = [0.12, 0.13, 0.22];
  var MUTED = [0.42, 0.43, 0.52];
  var ACCENT = [0.42, 0.16, 0.72];
  var LINE = [0.82, 0.82, 0.88];

  // WiderHelvetica/WinAnsi: apenas os caracteres que o PDF consegue mostrar.
  var EXTRA = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  // Larguras Helvetica (unidades/1000) para ASCII 32..126.
  var WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
  ];

  function winAnsi(value) {
    var text = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code === 9) { out += ' '; continue; }
      if (code === 10 || code === 13) { out += '\n'; continue; }
      if (code >= 0xD800 && code <= 0xDFFF) continue; // emoji fora do WinAnsi
      if (code < 32) continue;
      if (code <= 0x7E) out += String.fromCharCode(code);
      else if (EXTRA[code] != null) out += String.fromCharCode(EXTRA[code]);
      else if (code >= 0xA0 && code <= 0xFF) out += String.fromCharCode(code);
      else out += '?';
    }
    return out;
  }

  function escapePdf(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  function textWidth(value, size, bold) {
    var text = winAnsi(value);
    var total = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      var unit = code >= 32 && code <= 126 ? WIDTHS[code - 32] : (code === 160 ? 278 : 556);
      total += unit;
    }
    return total * size / 1000 * (bold ? 1.06 : 1);
  }

  function wrap(value, size, bold, maxWidth) {
    var paragraphs = String(value == null ? '' : value).replace(/\r/g, '').split('\n');
    var lines = [];
    paragraphs.forEach(function (paragraph) {
      var words = paragraph.split(/\s+/).filter(function (word) { return !!word; });
      if (!words.length) { lines.push(''); return; }

      var line = '';
      words.forEach(function (word) {
        var candidate = line ? line + ' ' + word : word;
        if (!line || textWidth(candidate, size, bold) <= maxWidth) {
          line = candidate;
          return;
        }
        lines.push(line);
        if (textWidth(word, size, bold) <= maxWidth) {
          line = word;
          return;
        }
        var chunk = '';
        for (var i = 0; i < word.length; i += 1) {
          if (chunk && textWidth(chunk + word[i], size, bold) > maxWidth) {
            lines.push(chunk);
            chunk = '';
          }
          chunk += word[i];
        }
        line = chunk;
      });
      if (line) lines.push(line);
    });
    return lines;
  }

  function rgb(color) {
    return color[0].toFixed(3) + ' ' + color[1].toFixed(3) + ' ' + color[2].toFixed(3);
  }

  function textOp(x, y, value, size, bold, color) {
    return rgb(color || INK) + ' rg BT ' + (bold ? '/F2' : '/F1') + ' ' + size + ' Tf 1 0 0 1 ' +
      x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + escapePdf(winAnsi(value)) + ') Tj ET';
  }

  function lineOp(y) {
    return rgb(LINE) + ' RG 0.7 w ' + MARGIN + ' ' + y.toFixed(2) + ' m ' +
      (PAGE_W - MARGIN).toFixed(2) + ' ' + y.toFixed(2) + ' l S';
  }

  function pad(value, length) {
    var text = String(value);
    while (text.length < length) text = '0' + text;
    return text;
  }

  function cardLines(card, column) {
    var lines = [];
    function add(text, size, bold, color, indent) {
      lines.push({ text: text, size: size || 10, bold: !!bold, color: color || INK, indent: indent || 0 });
    }
    function addWrapped(text, size, bold, color) {
      wrap(text, size, bold, CONTENT_W - 18).forEach(function (line) {
        add(line, size, bold, color, 6);
      });
    }

    if (card.hidden) {
      add('[Conteúdo oculto — aguardando revelação]', 10, false, MUTED, 6);
      return lines;
    }

    var text = String(card.text || '').trim() || '(card sem texto)';
    addWrapped(text, 10, false, INK);
    if (card.likes) add('Curtidas: ' + card.likes, 9, false, MUTED, 6);

    var plan = String(card.planText || '').trim();
    var assignees = (card.assignees || []).filter(function (name) { return !!name; });
    if (plan || assignees.length) {
      if (plan) addWrapped('Plano de ação: ' + plan, 9.5, false, INK);
      if (assignees.length) addWrapped('Responsáveis: ' + assignees.join(', '), 9.5, false, INK);
    } else if (column.key === 'melhorias') {
      add('Sem plano de ação registrado.', 9, false, MUTED, 6);
    }
    return lines;
  }

  function build(data) {
    data = data || {};
    var pages = [];
    var ops = [];
    var y = PAGE_H - MARGIN;

    function newPage() {
      if (ops.length) pages.push(ops.join('\n'));
      ops = [];
      y = PAGE_H - MARGIN;
    }
    function ensure(space) {
      if (y - space < BOTTOM) newPage();
    }
    function addText(text, size, bold, color, indent, factor) {
      var leading = (size || 10) * (factor || 1.35);
      ensure(leading);
      y -= leading;
      ops.push(textOp(MARGIN + (indent || 0), y, text, size || 10, bold, color));
    }
    function addSeparator() {
      ensure(14);
      ops.push(lineOp(y - 2));
      y -= 14;
    }

    newPage();
    addText('Retro Special — Relatório da sala ' + (data.code || '—'), 18, true, INK, 0, 1.4);
    addText('Sala ' + (data.code || '—') + ' · gerado em ' + (data.generatedAt || ''), 9, false, MUTED);
    y -= 6;
    addSeparator();
    y -= 6;

    var columns = data.columns || [];
    if (!columns.length) addText('Nenhuma coluna disponível.', 10, false, MUTED);

    columns.forEach(function (column) {
      var cards = column.cards || [];
      ensure(46);
      addText((column.title || column.key || 'Coluna') + ' (' + cards.length + ')', 14, true, ACCENT);
      addText(column.revealed ? 'Bloco revelado' : 'Bloco oculto — cards ainda não revelados', 9, false, MUTED);
      y -= 4;

      if (!cards.length) addText('Nenhum card registrado.', 10, false, MUTED);

      cards.forEach(function (card) {
        var lines = cardLines(card, column);
        var height = lines.reduce(function (sum, line) { return sum + line.size * 1.35; }, 0) + 18;
        ensure(height);
        lines.forEach(function (line) {
          addText(line.text, line.size, line.bold, line.color, line.indent);
        });
        addSeparator();
      });
      y -= 12;
    });

    if (ops.length) pages.push(ops.join('\n'));
    if (!pages.length) pages.push('');

    var total = pages.length;
    pages = pages.map(function (content, index) {
      return content + '\n' + textOp(MARGIN, 32,
        'Retro Special · sala ' + (data.code || '—') + ' · página ' + (index + 1) + ' de ' + total,
        8, false, MUTED);
    });

    return assemble(pages);
  }

  function assemble(pages) {
    var pageIds = [];
    var contentIds = [];
    for (var i = 0; i < pages.length; i += 1) {
      pageIds.push(3 + i * 2);
      contentIds.push(4 + i * 2);
    }
    var fontRegular = 3 + pages.length * 2;
    var fontBold = fontRegular + 1;
    var size = fontBold + 1;

    var objects = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = '<< /Type /Pages /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') +
      '] /Count ' + pages.length + ' >>';

    pages.forEach(function (content, index) {
      objects[pageIds[index]] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        PAGE_W.toFixed(2) + ' ' + PAGE_H.toFixed(2) + '] /Resources << /ProcSet [/PDF /Text] /Font << /F1 ' +
        fontRegular + ' 0 R /F2 ' + fontBold + ' 0 R >> >> /Contents ' + contentIds[index] + ' 0 R >>';
      objects[contentIds[index]] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
    });

    objects[fontRegular] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[fontBold] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    var pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var offsets = [0];
    for (var id = 1; id < size; id += 1) {
      offsets[id] = pdf.length;
      pdf += id + ' 0 obj\n' + objects[id] + '\nendobj\n';
    }

    var xref = pdf.length;
    pdf += 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (id = 1; id < size; id += 1) {
      pdf += pad(offsets[id], 10) + ' 00000 n \n';
    }
    pdf += 'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';

    var bytes = new Uint8Array(pdf.length);
    for (i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xFF;
    return bytes;
  }

  function download(data, filename) {
    var bytes = build(data);
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename || 'retro-special.pdf';
    document.body.appendChild(link);
    link.click();
    if (link.parentNode) link.parentNode.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return true;
  }

  Retro.pdf = { build: build, download: download, encode: winAnsi };
}());
