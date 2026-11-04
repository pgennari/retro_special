/*
 * Camada de persistência das salas.
 *
 * - Firestore quando FIREBASE_SERVICE_ACCOUNT (ou GOOGLE_APPLICATION_CREDENTIALS)
 *   está configurado.
 * - Memória quando não está (desenvolvimento local e testes).
 *
 * As fotos dos avatares ficam em subdocumentos (rooms/{code}/avatars/{userId})
 * para não estourar o limite de 1 MiB do documento principal e são gravadas
 * apenas quando mudam.
 */
'use strict';

const Engine = require('../public/assets/js/engine.js');
const firestore = require('./firestore.js');

const SAVE_DELAY = 350;
const MAX_RETRIES = 4;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function emojiFallback(user) {
  const internals = Engine._internals;
  const colors = internals.USER_COLORS;
  const backgrounds = internals.AVATAR_BACKGROUNDS;
  const index = Math.max(0, colors.indexOf(user && user.color));
  return {
    kind: 'emoji',
    value: '🦊',
    bg: backgrounds[index % backgrounds.length]
  };
}

/**
 * Separa as fotos do restante do estado, sem alterar a sala em memória.
 */
function snapshotForStorage(room) {
  const copy = JSON.parse(JSON.stringify(room));
  const photos = {};

  (copy.users || []).forEach((user) => {
    const avatar = user.avatar || {};
    if (avatar.kind === 'photo' && typeof avatar.value === 'string' && avatar.value) {
      photos[user.id] = avatar;
      user.avatar = { kind: 'photo', value: '', bg: avatar.bg || '' };
    }
  });

  return { room: copy, photos };
}

/**
 * Recoloca as fotos carregadas do Firestore na sala. Se o subdocumento sumiu,
 * cai para um avatar emoji em vez de deixar uma imagem quebrada.
 */
function applyStoredPhotos(room, photos) {
  if (!room || !Array.isArray(room.users)) return room;
  room.users.forEach((user) => {
    const avatar = user.avatar || {};
    if (avatar.kind !== 'photo') return;
    const stored = photos && photos[user.id];
    if (stored && typeof stored.value === 'string' && stored.value) {
      user.avatar = { kind: 'photo', value: stored.value, bg: stored.bg || '' };
    } else {
      user.avatar = emojiFallback(user);
    }
  });
  return room;
}

function isStale(room, now) {
  const stamp = Number(room && room.updatedAt) || 0;
  return !!stamp && (now || Date.now()) - stamp > ROOM_TTL_MS;
}

function createStore(options) {
  options = options || {};
  const client = options.client !== undefined ? options.client : firestore.createClientFromEnv();
  const enabled = !!client;
  const queues = new Map(); // code -> { timer, writing, dirty, room, retries, deleted }
  const savedPhotos = new Map(); // code -> Map<userId, avatar>
  let lastError = null;

  function rememberError(error, prefix) {
    lastError = (prefix ? prefix + ': ' : '') + (error && error.message ? error.message : String(error));
    console.error('[store]', lastError);
  }

  function mapPhotos(photos) {
    const map = new Map();
    Object.keys(photos || {}).forEach((id) => map.set(id, photos[id]));
    return map;
  }

  async function writePhotos(code, photos, previous) {
    const nextSaved = new Map();
    const prev = previous || new Map();
    let failed = false;

    for (const id of Object.keys(photos || {})) {
      const avatar = photos[id];
      const old = prev.get(id);
      if (old && old.value === avatar.value) {
        nextSaved.set(id, avatar);
        continue;
      }
      try {
        await client.set(['rooms', code, 'avatars', id], { avatar });
        nextSaved.set(id, avatar);
      } catch (error) {
        failed = true;
        rememberError(error, 'falha ao salvar foto de ' + id);
        if (old) nextSaved.set(id, old);
      }
    }

    for (const id of prev.keys()) {
      if (photos && photos[id]) continue;
      try {
        await client.remove(['rooms', code, 'avatars', id]);
      } catch (error) {
        failed = true;
        rememberError(error, 'falha ao remover foto de ' + id);
      }
    }

    return { saved: nextSaved, failed };
  }

  async function loadRoom(code) {
    if (!enabled) return null;
    const room = await client.get(['rooms', code]);
    if (!room) return null;

    const photos = {};
    const ids = (room.users || [])
      .filter((user) => user.avatar && user.avatar.kind === 'photo')
      .map((user) => user.id);

    await Promise.all(ids.map(async (id) => {
      try {
        const data = await client.get(['rooms', code, 'avatars', id]);
        if (data && data.avatar && typeof data.avatar.value === 'string' && data.avatar.value) {
          photos[id] = data.avatar;
        }
      } catch (error) {
        rememberError(error, 'falha ao carregar foto de ' + id);
      }
    }));

    applyStoredPhotos(room, photos);
    savedPhotos.set(code, mapPhotos(photos));
    return room;
  }

  async function createRoom(room) {
    if (!enabled) return;
    const snapshot = snapshotForStorage(room);
    await client.create(['rooms'], room.code, snapshot.room);
    const result = await writePhotos(room.code, snapshot.photos, new Map());
    savedPhotos.set(room.code, result.saved);
    if (!result.failed) lastError = null;
  }

  function schedule(code, item) {
    if (item.timer || item.writing) return;
    item.timer = setTimeout(() => {
      item.timer = null;
      flushItem(code, item);
    }, SAVE_DELAY);
    if (item.timer.unref) item.timer.unref();
  }

  function saveRoom(room) {
    if (!enabled || !room || !room.code) return;
    const code = room.code;
    let item = queues.get(code);
    if (!item) {
      item = { timer: null, writing: false, dirty: false, room: null, retries: 0, deleted: false };
      queues.set(code, item);
    }
    item.room = room;
    item.dirty = true;
    item.deleted = false;
    schedule(code, item);
  }

  async function flushItem(code, item) {
    if (!item || item.writing || !item.room) return;
    if (item.deleted) {
      item.room = null;
      item.dirty = false;
      return;
    }

    const room = item.room;
    item.room = null;
    item.dirty = false;
    item.writing = true;
    const snapshot = snapshotForStorage(room);

    try {
      await client.set(['rooms', code], snapshot.room);

      if (item.deleted) {
        await purgeRoom(code);
        return;
      }

      const result = await writePhotos(code, snapshot.photos, savedPhotos.get(code) || new Map());
      savedPhotos.set(code, result.saved);

      // a sala pode ter sido apagada enquanto as fotos eram gravadas
      if (item.deleted) {
        await purgeRoom(code);
        return;
      }

      if (!result.failed) lastError = null;
      item.retries = 0;
    } catch (error) {
      rememberError(error, 'falha ao salvar sala ' + code);
      if (!item.room) item.room = room;
      item.dirty = true;
      item.retries += 1;
      if (item.retries <= MAX_RETRIES) {
        const delay = Math.min(10000, 500 * Math.pow(2, item.retries));
        item.timer = setTimeout(() => {
          item.timer = null;
          flushItem(code, item);
        }, delay);
        if (item.timer.unref) item.timer.unref();
      } else {
        console.error('[store] desisti de salvar a sala ' + code + ' depois de ' + MAX_RETRIES + ' tentativas.');
      }
    } finally {
      item.writing = false;
      if (item.dirty && !item.timer && item.room && !item.deleted) schedule(code, item);
    }
  }

  async function purgeRoom(code) {
    savedPhotos.delete(code);

    try {
      const docs = await client.list(['rooms', code, 'avatars']);
      for (const doc of docs) {
        await client.remove(['rooms', code, 'avatars', doc.id]);
      }
    } catch (error) {
      rememberError(error, 'falha ao listar fotos da sala ' + code);
    }

    try {
      await client.remove(['rooms', code]);
    } catch (error) {
      rememberError(error, 'falha ao apagar sala ' + code);
      throw error;
    }
  }

  async function deleteRoom(code) {
    if (!enabled) return;
    const item = queues.get(code);
    if (item) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = null;
      item.deleted = true;
      item.room = null;
      item.dirty = false;
      queues.delete(code);
    }

    await purgeRoom(code);
  }

  /**
   * Lista as salas salvas (sem carregar as fotos dos avatares). O servidor
   * mescla com o cache em memória para montar o painel de administração.
   */
  async function listRooms() {
    if (!enabled) return [];
    const docs = await client.list(['rooms']);
    return docs
      .map((doc) => {
        const data = doc && doc.data;
        if (!data || !Array.isArray(data.users) || !data.columns) return null;
        return Object.assign({}, data, {
          code: Engine.normalizeCode(data.code || (doc && doc.id))
        });
      })
      .filter((room) => !!(room && room.code));
  }

  function waitForIdle(item, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!item.writing) return resolve();
        if (Date.now() - started > timeout) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  async function flush() {
    if (!enabled) return;

    const entries = Array.from(queues.entries());
    entries.forEach(([, item]) => {
      if (item.timer) {
        clearTimeout(item.timer);
        item.timer = null;
      }
    });

    for (const [code, item] of entries) {
      if (item.writing) await waitForIdle(item, 5000);
      if (item.room && item.dirty) await flushItem(code, item);
    }
  }

  function status() {
    return {
      enabled,
      projectId: client ? client.projectId : '',
      pending: Array.from(queues.values()).filter((item) => item.room || item.dirty).length,
      lastError
    };
  }

  return {
    enabled,
    projectId: client ? client.projectId : '',
    loadRoom,
    listRooms,
    createRoom,
    saveRoom,
    deleteRoom,
    flush,
    status
  };
}

const defaultStore = createStore();

module.exports = defaultStore;
module.exports.createStore = createStore;
module.exports.ROOM_TTL_MS = ROOM_TTL_MS;
module.exports._internals = {
  snapshotForStorage,
  applyStoredPhotos,
  emojiFallback,
  isStale
};
