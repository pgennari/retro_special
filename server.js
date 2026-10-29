/*
 * Retro Special — servidor HTTP (sem dependências externas).
 *
 * - API REST para criar/entrar e executar ações
 * - Server-Sent Events para sincronizar a sala em tempo real
 *
 * Basta rodar: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Engine = require('./shared/engine.js');

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const MAX_BODY = 4 * 1024 * 1024;

const rooms = new Map(); // code -> room
const streams = new Map(); // code -> Map<userId, Set<res>>

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ *
 * infraestrutura HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('O conteúdo enviado é grande demais.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(Object.assign(new Error('JSON inválido.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, cacheControl) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado.');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl || 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJoin(baseDir, relativePath) {
  const target = path.resolve(baseDir, '.' + path.posix.normalize('/' + relativePath));
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return null;
  return target;
}

/* ------------------------------------------------------------------ *
 * sincronização em tempo real
 * ------------------------------------------------------------------ */

function getStreamsFor(code, userId) {
  if (!streams.has(code)) streams.set(code, new Map());
  const byUser = streams.get(code);
  if (!byUser.has(userId)) byUser.set(userId, new Set());
  return byUser.get(userId);
}

function writeSse(res, payload) {
  try {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  } catch (error) {
    /* conexão morta: o handler de close limpa */
  }
}

function broadcast(code, event) {
  const room = rooms.get(code);
  if (!room) return;
  const byUser = streams.get(code);
  if (!byUser) return;

  byUser.forEach((set, userId) => {
    const member = Engine.findUser(room, userId);
    if (!member) {
      set.forEach((res) => {
        writeSse(res, { type: 'kicked' });
        try { res.end(); } catch (error) { /* noop */ }
      });
      set.clear();
      byUser.delete(userId);
      return;
    }
    const state = Engine.getState(room, userId);
    set.forEach((res) => {
      writeSse(res, { type: 'state', state, event: event || null });
    });
  });
}

function cleanupUserStreams(code, userId) {
  const byUser = streams.get(code);
  if (!byUser) return;
  const set = byUser.get(userId);
  if (!set || set.size === 0) {
    byUser.delete(userId);
    const room = rooms.get(code);
    if (room && Engine.setConnected(room, userId, false)) {
      broadcast(code, { kind: 'presence', userId, connected: false });
    }
  }
}

function openStream(req, res, code, userId) {
  const room = rooms.get(code);
  if (!room) return sendError(res, 404, 'Sala não encontrada.');
  const user = Engine.findUser(room, userId);
  if (!user) return sendError(res, 403, 'Você não está nesta sala.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('retry: 1500\n\n');
  res.flushHeaders && res.flushHeaders();

  const set = getStreamsFor(code, userId);
  set.add(res);

  const becameConnected = Engine.setConnected(room, userId, true);
  if (becameConnected) {
    broadcast(code, { kind: 'presence', userId, connected: true });
  }

  const state = Engine.getState(room, userId);
  writeSse(res, { type: 'state', state, event: null });

  req.on('close', () => {
    set.delete(res);
    if (set.size === 0) {
      cleanupUserStreams(code, userId);
    }
  });
}

// keep-alive para proxies/navegadores
setInterval(() => {
  streams.forEach((byUser) => {
    byUser.forEach((set) => {
      set.forEach((res) => {
        try { res.write(': ping\n\n'); } catch (error) { /* noop */ }
      });
    });
  });
}, 20000).unref();

/* ------------------------------------------------------------------ *
 * ações
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime())
    });
  }

  // POST /api/rooms
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readJson(req);
    const identity = body.identity || {};
    let code = Engine.normalizeCode(body.code);
    if (!code || rooms.has(code)) {
      let attempts = 0;
      do {
        code = Engine.randomCode(6);
        attempts += 1;
      } while (rooms.has(code) && attempts < 100);
    }
    const room = Engine.createRoom(identity, code);
    rooms.set(code, room);
    const owner = room.users[0];
    return sendJson(res, 201, {
      ok: true,
      code,
      user: owner,
      state: Engine.getState(room, owner.id)
    });
  }

  // GET /api/rooms/:code
  if (req.method === 'GET' && segments.length === 3 && segments[1] === 'rooms') {
    const code = Engine.normalizeCode(segments[2]);
    const room = rooms.get(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada. Confira o código.');
    return sendJson(res, 200, {
      ok: true,
      code: room.code,
      users: room.users.length,
      createdAt: room.createdAt
    });
  }

  // POST /api/rooms/:code/join
  if (req.method === 'POST' && segments.length === 4 && segments[1] === 'rooms' && segments[3] === 'join') {
    const code = Engine.normalizeCode(segments[2]);
    const room = rooms.get(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada. Confira o código.');
    const body = await readJson(req);
    const result = Engine.joinRoom(room, body.identity || {});
    if (!result.ok) return sendError(res, 400, result.error);
    if (result.isNew) {
      broadcast(code, { kind: 'member-joined', userId: result.user.id });
    } else {
      broadcast(code, { kind: 'presence', userId: result.user.id, connected: true });
    }
    return sendJson(res, 200, {
      ok: true,
      code,
      user: result.user,
      isNew: result.isNew,
      state: Engine.getState(room, result.user.id)
    });
  }

  // GET /api/rooms/:code/stream?userId=...
  if (req.method === 'GET' && segments.length === 4 && segments[1] === 'rooms' && segments[3] === 'stream') {
    const code = Engine.normalizeCode(segments[2]);
    const userId = url.searchParams.get('userId') || '';
    return openStream(req, res, code, userId);
  }

  // POST /api/rooms/:code/actions
  if (req.method === 'POST' && segments.length === 4 && segments[1] === 'rooms' && segments[3] === 'actions') {
    const code = Engine.normalizeCode(segments[2]);
    const room = rooms.get(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    const body = await readJson(req);
    const userId = String(body.userId || '');
    const result = Engine.applyAction(room, userId, String(body.type || ''), body.payload || {});
    if (!result.ok) return sendError(res, 400, result.error);
    if (result.event) {
      result.event.actorId = userId;
      broadcast(code, result.event);
    }
    return sendJson(res, 200, {
      ok: true,
      event: result.event || null,
      state: Engine.getState(room, userId)
    });
  }

  return sendError(res, 404, 'Rota não encontrada.');
}

/* ------------------------------------------------------------------ *
 * servidor
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Endereço inválido.');
    return;
  }

  // libera CORS simples para EventSource/fetch em outros hosts da rede
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, error.status || 500, error.message || 'Erro interno.');
      } else {
        try { res.end(); } catch (e) { /* noop */ }
      }
    }
    return;
  }

  // link bonito -> rota no cliente (hash)
  const roomLink = pathname.match(/^\/sala\/([A-Za-z0-9]{4,8})\/?$/);
  if (roomLink) {
    res.writeHead(302, { Location: '/#/sala/' + roomLink[1].toUpperCase() });
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  if (pathname.startsWith('/shared/')) {
    const file = safeJoin(SHARED_DIR, pathname.slice('/shared/'.length));
    if (!file) return sendError(res, 403, 'Acesso negado.');
    return serveFile(res, file);
  }

  if (pathname.startsWith('/assets/')) {
    const file = safeJoin(PUBLIC_DIR, pathname.slice(1));
    if (!file) return sendError(res, 403, 'Acesso negado.');
    return serveFile(res, file);
  }

  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return serveFile(res, path.join(PUBLIC_DIR, 'favicon.svg'), 'public, max-age=86400');
  }

  if (pathname === '/robots.txt') {
    return serveFile(res, path.join(PUBLIC_DIR, 'robots.txt'), 'public, max-age=86400');
  }

  // fallback para o SPA (somente GET sem extensão)
  if (req.method === 'GET' && !path.extname(pathname)) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado.');
});

// limpeza de salas abandonadas
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  rooms.forEach((room, code) => {
    const hasStreams = streams.has(code) && Array.from(streams.get(code).values()).some((set) => set.size > 0);
    if (!hasStreams && room.updatedAt < cutoff) {
      rooms.delete(code);
      streams.delete(code);
    }
  });
  // limite de segurança
  if (rooms.size > 500) {
    const oldest = Array.from(rooms.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = rooms.size - 500;
    for (let i = 0; i < excess; i += 1) {
      const code = oldest[i][0];
      if (!streams.has(code)) {
        rooms.delete(code);
      }
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const address = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('\n  Retro Special rodando em http://' + address + ':' + PORT + '\n');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('A porta ' + PORT + ' já está em uso. Defina outra com PORT=xxxx node server.js');
  } else {
    console.error(error);
  }
  process.exit(1);
});
