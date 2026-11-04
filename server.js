/*
 * Retro Special — servidor HTTP (sem dependências externas).
 *
 * - API REST para criar/entrar e executar ações
 * - Server-Sent Events para sincronizar a sala em tempo real
 * - Persistência opcional no Firestore (REST + service account)
 *
 * Basta rodar: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./public/assets/js/engine.js');
const store = require('./lib/store.js');

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 4 * 1024 * 1024;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();

const rooms = new Map(); // code -> room
const streams = new Map(); // code -> Map<userId, Set<res>>
const loading = new Map(); // code -> Promise<room|null>

// Origens oficiais do projeto. Continuam liberadas mesmo que a variável
// ALLOWED_ORIGINS do Render fique desatualizada em relação a este arquivo.
const PROJECT_ORIGINS = [
  'https://retro-special.web.app',
  'https://retro-special-pgennari.web.app',
  'https://retro-special-pgennari.firebaseapp.com'
];

const CONFIGURED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const ALLOWED_ORIGINS = CONFIGURED_ORIGINS.length
  ? Array.from(new Set(CONFIGURED_ORIGINS.concat(PROJECT_ORIGINS)))
  : [];

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

function corsOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (!ALLOWED_ORIGINS.length) return '*';
  if (!origin) return null;
  return ALLOWED_ORIGINS.indexOf(origin) === -1 ? null : origin;
}

function applyCors(req, res) {
  const allowed = corsOrigin(req);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
  if (allowed !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

/* ------------------------------------------------------------------ *
 * autenticação da administração
 * ------------------------------------------------------------------ */

function safeEqual(left, right) {
  const a = Buffer.from(String(left == null ? '' : left), 'utf8');
  const b = Buffer.from(String(right == null ? '' : right), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function adminToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    sendError(res, 503, 'A administração não está configurada. Defina ADMIN_KEY no servidor.');
    return false;
  }
  if (!safeEqual(adminToken(req), ADMIN_KEY)) {
    sendError(res, 401, 'Chave de administrador inválida.');
    return false;
  }
  return true;
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
 * persistência / carregamento sob demanda
 * ------------------------------------------------------------------ */

function isRoomShapeValid(room) {
  return !!(
    room &&
    typeof room.code === 'string' &&
    Array.isArray(room.users) &&
    room.columns &&
    room.columns.acertos &&
    room.columns.melhorias &&
    room.dynamics
  );
}

function storeError(error) {
  console.error('[store]', error && error.stack ? error.stack : error);
  return Object.assign(new Error('Não consegui acessar os dados da sala. Tente novamente.'), { status: 503 });
}

async function getRoom(rawCode) {
  const code = Engine.normalizeCode(rawCode);
  if (!code) return null;
  if (rooms.has(code)) return rooms.get(code);
  if (loading.has(code)) return loading.get(code);

  const pending = (async () => {
    let room;
    try {
      room = await store.loadRoom(code);
    } catch (error) {
      throw storeError(error);
    }
    if (!room) return null;

    if (!isRoomShapeValid(room)) {
      try { await store.deleteRoom(code); } catch (error) { /* noop */ }
      return null;
    }

    room.code = code;
    room.updatedAt = Number(room.updatedAt) || Number(room.createdAt) || Date.now();
    // Ao carregar do banco não há SSE aberto: todos voltam como offline
    // e cada pessoa fica online de novo quando abrir o stream.
    room.users.forEach((user) => { user.connected = false; });

    if (Date.now() - room.updatedAt > ROOM_TTL_MS) {
      try { await store.deleteRoom(code); } catch (error) { /* noop */ }
      return null;
    }

    rooms.set(code, room);
    return room;
  })();

  loading.set(code, pending);
  try {
    return await pending;
  } finally {
    if (loading.get(code) === pending) loading.delete(code);
  }
}

async function allocateRoom(identity, requestedCode) {
  let code = Engine.normalizeCode(requestedCode);
  if (!code || rooms.has(code) || loading.has(code)) code = '';

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!code) {
      do {
        code = Engine.randomCode(6);
      } while (rooms.has(code) || loading.has(code));
    }

    const room = Engine.createRoom(identity, code);
    try {
      // quando o Firestore está ativo, a criação é atômica:
      // se o código já existir, tenta outro.
      await store.createRoom(room);
    } catch (error) {
      if (error && (error.status === 409 || error.code === 'already-exists' || error.conflict)) {
        code = '';
        continue;
      }
      throw storeError(error);
    }

    rooms.set(code, room);
    return room;
  }

  throw Object.assign(new Error('Não consegui criar a sala. Tente novamente.'), { status: 503 });
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
        writeSse(res, { type: 'kicked', message: 'Você não está mais nesta sala.' });
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
      store.saveRoom(room);
      broadcast(code, { kind: 'presence', userId, connected: false });
    }
  }
}

function closeRoomStreams(code, message) {
  const byUser = streams.get(code);
  if (byUser) {
    byUser.forEach((set) => {
      set.forEach((res) => {
        writeSse(res, { type: 'kicked', message: message || 'Esta sala não existe mais.' });
        try { res.end(); } catch (error) { /* noop */ }
      });
      set.clear();
    });
  }
  streams.delete(code);
}

/* ------------------------------------------------------------------ *
 * administração — resumos das salas
 * ------------------------------------------------------------------ */

function roomSummary(room) {
  if (!room) return null;
  const organizer = Engine.findUser(room, room.organizerId);
  const acertos = room.columns && room.columns.acertos ? room.columns.acertos.cards : [];
  const melhorias = room.columns && room.columns.melhorias ? room.columns.melhorias.cards : [];
  return {
    code: room.code,
    createdAt: room.createdAt || 0,
    updatedAt: room.updatedAt || 0,
    userCount: room.users.length,
    onlineCount: room.users.filter((user) => user.connected).length,
    organizerName: organizer ? organizer.name : '',
    organizerId: room.organizerId || '',
    acertos: Array.isArray(acertos) ? acertos.length : 0,
    melhorias: Array.isArray(melhorias) ? melhorias.length : 0,
    phase: room.dynamics ? room.dynamics.phase : 'setup'
  };
}

/**
 * Junta o cache em memória com o que está salvo no Firestore. Em memória
 * sempre vence, porque é o estado mais recente.
 */
async function listAllRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  const byCode = new Map();
  let warning = null;

  try {
    const stored = await store.listRooms();
    stored.forEach((room) => {
      if (!room || !room.code || !isRoomShapeValid(room)) return;
      if (room.updatedAt && room.updatedAt < cutoff) return;
      // uma sala só no banco não tem SSE aberto: ninguém está online de fato
      const users = (room.users || []).map((user) => Object.assign({}, user, { connected: false }));
      byCode.set(room.code, Object.assign({}, room, { users }));
    });
  } catch (error) {
    warning = 'Não consegui listar as salas do Firestore: ' + (error && error.message ? error.message : 'erro desconhecido');
    console.error('[admin]', warning);
  }

  rooms.forEach((room, code) => byCode.set(code, room));

  return {
    rooms: Array.from(byCode.values())
      .map(roomSummary)
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    warning
  };
}

function openStream(req, res, room, userId) {
  const code = room.code;
  const user = Engine.findUser(room, userId);
  if (!user) return sendError(res, 403, 'Você não está nesta sala.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1500\n\n');
  res.flushHeaders && res.flushHeaders();

  const set = getStreamsFor(code, userId);
  set.add(res);

  const becameConnected = Engine.setConnected(room, userId, true);
  if (becameConnected) {
    store.saveRoom(room);
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

/* ------------------------------------------------------------------ *
 * administração — rotas
 * ------------------------------------------------------------------ */

function adminState(room) {
  return Engine.getAdminState(room);
}

async function handleAdmin(req, res, url, segments) {
  if (!requireAdmin(req, res)) return;

  // POST /api/admin/session — valida a chave sem expor nenhum dado.
  if (req.method === 'POST' && url.pathname === '/api/admin/session') {
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/admin/rooms
  if (req.method === 'GET' && segments.length === 3 && segments[2] === 'rooms') {
    const data = await listAllRooms();
    return sendJson(res, 200, { ok: true, rooms: data.rooms, warning: data.warning });
  }

  const code = Engine.normalizeCode(segments[3]);
  if (!code || segments.length < 4 || segments[2] !== 'rooms') {
    return sendError(res, 404, 'Rota de administração não encontrada.');
  }

  // GET /api/admin/rooms/:code
  if (req.method === 'GET' && segments.length === 4) {
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    return sendJson(res, 200, { ok: true, room: adminState(room) });
  }

  // POST /api/admin/rooms/:code/users/:userId/remove
  if (req.method === 'POST' && segments.length === 7 && segments[4] === 'users' && segments[6] === 'remove') {
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    const userId = segments[5];
    const result = Engine.adminRemoveUser(room, userId);
    if (!result.ok) return sendError(res, 400, result.error);
    store.saveRoom(room);
    if (result.event) broadcast(code, result.event);
    return sendJson(res, 200, { ok: true, room: adminState(room) });
  }

  // POST /api/admin/rooms/:code/cards
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'cards') {
    const body = await readJson(req);
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    const result = Engine.adminAddCard(room, String(body.column || ''), body);
    if (!result.ok) return sendError(res, 400, result.error);
    store.saveRoom(room);
    if (result.event) broadcast(code, result.event);
    return sendJson(res, 200, { ok: true, room: adminState(room) });
  }

  // POST /api/admin/rooms/:code/cards/:cardId/edit|delete
  if (req.method === 'POST' && segments.length === 7 && segments[4] === 'cards') {
    const cardId = segments[5];
    const action = segments[6];
    const body = await readJson(req);
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    const result = action === 'edit'
      ? Engine.adminEditCard(room, String(body.column || ''), cardId, body.text)
      : (action === 'delete' ? Engine.adminDeleteCard(room, String(body.column || ''), cardId) : null);
    if (!result) return sendError(res, 404, 'Rota de administração não encontrada.');
    if (!result.ok) return sendError(res, 400, result.error);
    store.saveRoom(room);
    if (result.event) broadcast(code, result.event);
    return sendJson(res, 200, { ok: true, room: adminState(room) });
  }

  // POST /api/admin/rooms/:code/delete
  if (req.method === 'POST' && segments.length === 5 && segments[4] === 'delete') {
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    try {
      await store.deleteRoom(code);
    } catch (error) {
      throw storeError(error);
    }
    rooms.delete(code);
    loading.delete(code);
    closeRoomStreams(code, 'Esta sala foi encerrada pelo administrador.');
    return sendJson(res, 200, { ok: true, deleted: true });
  }

  return sendError(res, 404, 'Rota de administração não encontrada.');
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const persistence = store.status();
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      persistence: persistence.enabled ? 'firestore' : 'memory',
      pendingWrites: persistence.pending,
      storeError: persistence.lastError || null
    });
  }

  if (segments[1] === 'admin') {
    return handleAdmin(req, res, url, segments);
  }

  // POST /api/rooms
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readJson(req);
    const identity = body.identity || {};
    const room = await allocateRoom(identity, body.code);
    const owner = room.users[0];
    return sendJson(res, 201, {
      ok: true,
      code: room.code,
      user: owner,
      state: Engine.getState(room, owner.id)
    });
  }

  // GET /api/rooms/:code
  if (req.method === 'GET' && segments.length === 3 && segments[1] === 'rooms') {
    const code = Engine.normalizeCode(segments[2]);
    const room = await getRoom(code);
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
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada. Confira o código.');
    const body = await readJson(req);
    const result = Engine.joinRoom(room, body.identity || {});
    if (!result.ok) return sendError(res, 400, result.error);
    store.saveRoom(room);
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
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    return openStream(req, res, room, userId);
  }

  // POST /api/rooms/:code/actions
  if (req.method === 'POST' && segments.length === 4 && segments[1] === 'rooms' && segments[3] === 'actions') {
    const code = Engine.normalizeCode(segments[2]);
    const room = await getRoom(code);
    if (!room) return sendError(res, 404, 'Sala não encontrada.');
    const body = await readJson(req);
    const userId = String(body.userId || '');
    const result = Engine.applyAction(room, userId, String(body.type || ''), body.payload || {});
    if (!result.ok) return sendError(res, 400, result.error);
    store.saveRoom(room);
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

  applyCors(req, res);
  if (req.headers.origin && ALLOWED_ORIGINS.length && !corsOrigin(req)) {
    sendError(res, 403, 'Origem não permitida.');
    return;
  }
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

/* ------------------------------------------------------------------ *
 * limpeza e encerramento
 * ------------------------------------------------------------------ */

async function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;

  for (const [code, room] of Array.from(rooms.entries())) {
    const hasStreams = streams.has(code) && Array.from(streams.get(code).values()).some((set) => set.size > 0);
    if (!hasStreams && room.updatedAt < cutoff) {
      rooms.delete(code);
      streams.delete(code);
      try { await store.deleteRoom(code); } catch (error) { console.error('[store] falha ao apagar sala antiga', code, error.message); }
    }
  }

  // limite de segurança
  if (rooms.size > 500) {
    const oldest = Array.from(rooms.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = rooms.size - 500;
    for (let i = 0; i < excess; i += 1) {
      const code = oldest[i][0];
      if (!streams.has(code)) {
        rooms.delete(code);
        try { await store.deleteRoom(code); } catch (error) { console.error('[store] falha ao apagar sala antiga', code, error.message); }
      }
    }
  }
}

setInterval(() => {
  cleanupRooms().catch((error) => console.error('[cleanup]', error.message));
}, 10 * 60 * 1000).unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  ' + signal + ': salvando salas e encerrando…');
  store.flush()
    .catch((error) => console.error('[store] falha ao salvar no encerramento', error.message))
    .finally(() => {
      setTimeout(() => process.exit(0), 50);
    });
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  const address = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const persistence = store.status();
  console.log('\n  Retro Special rodando em http://' + address + ':' + PORT);
  console.log('  persistência: ' + (persistence.enabled ? 'Firestore (' + persistence.projectId + ')' : 'memória (local)'));
  if (persistence.lastError) console.log('  atenção: ' + persistence.lastError);
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('A porta ' + PORT + ' já está em uso. Defina outra com PORT=xxxx node server.js');
  } else {
    console.error(error);
  }
  process.exit(1);
});
