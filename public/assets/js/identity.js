/* Retro Special — identidade local (nome, avatar e foto) */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  // Perfil salvo no navegador (preenche a próxima visita) e identidade ativa
  // da janela atual. A identidade ativa fica no sessionStorage: cada aba/janela
  // é uma pessoa diferente, mesmo em janelas anônimas que compartilham o
  // localStorage.
  var PROFILE_KEY = 'retro-special:identity:v1';
  var SESSION_KEY = 'retro-special:session:v1';
  var PHOTO_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
  var ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

  var EMOJIS = ['🦊', '🐼', '🐸', '👾', '🦄', '🐙', '🦁', '🐯', '🐨', '🐵', '🐧', '🦖', '🐳', '🦉', '🐝', '🦩'];

  var BACKGROUNDS = [
    'linear-gradient(135deg,#ff7ab6,#7b2cff)',
    'linear-gradient(135deg,#5ce1ff,#2563eb)',
    'linear-gradient(135deg,#b6ff5c,#0a9f6e)',
    'linear-gradient(135deg,#ffc857,#ff5c2b)',
    'linear-gradient(135deg,#b78cff,#5b2bff)',
    'linear-gradient(135deg,#64f0b2,#0e7490)',
    'linear-gradient(135deg,#ff9a5c,#ff2d75)',
    'linear-gradient(135deg,#8ab4ff,#4338ca)'
  ];

  var cached = null;
  var cachedActive = false;

  function safeStorage(kind) {
    try {
      var store = kind === 'session' ? window.sessionStorage : window.localStorage;
      if (!store) return null;
      var probe = '__retro_special_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
      return store;
    } catch (error) {
      return null;
    }
  }

  function readStored(store, key) {
    if (!store) return null;
    try {
      var raw = store.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function writeStored(store, key, value) {
    if (!store) return;
    try { store.setItem(key, JSON.stringify(value)); } catch (error) { /* quota / modo privado */ }
  }

  function normalizeIdentity(parsed, fallbackId) {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      id: typeof parsed.id === 'string' && ID_RE.test(parsed.id) ? parsed.id : fallbackId,
      name: cleanName(parsed.name),
      avatar: sanitizeAvatar(parsed.avatar) || defaultAvatar()
    };
  }

  function generateId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (error) { /* fallback */ }
    var random = Math.random().toString(36).slice(2);
    return 'user_' + Date.now().toString(36) + random;
  }

  function cleanName(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function sanitizeAvatar(value) {
    if (value && value.kind === 'photo' && typeof value.value === 'string') {
      var photo = value.value.replace(/\s+/g, '');
      if (PHOTO_RE.test(photo) && photo.length <= 900000) {
        return { kind: 'photo', value: photo };
      }
    }
    if (value && value.kind === 'emoji' && typeof value.value === 'string') {
      var emoji = value.value.trim();
      if (emoji && emoji.length <= 16) {
        return {
          kind: 'emoji',
          value: emoji,
          bg: typeof value.bg === 'string' && /^linear-gradient\([#a-zA-Z0-9(),.%\s-]+\)$/.test(value.bg)
            ? value.bg
            : BACKGROUNDS[0]
        };
      }
    }
    return null;
  }

  function emojiAvatar(index) {
    var i = Math.abs(Number(index) || 0) % EMOJIS.length;
    return { kind: 'emoji', value: EMOJIS[i], bg: BACKGROUNDS[i % BACKGROUNDS.length] };
  }

  function defaultAvatar() {
    return emojiAvatar(Math.floor(Math.random() * EMOJIS.length));
  }

  function save(identity) {
    cached = identity;
    cachedActive = true;
    var sessionStore = safeStorage('session');
    var localStore = safeStorage('local');
    writeStored(sessionStore, SESSION_KEY, identity);
    // o perfil guarda apenas nome/avatar/id para preencher a próxima visita
    writeStored(localStore, PROFILE_KEY, identity);
    return identity;
  }

  function load() {
    if (cached) return cached;

    var sessionStore = safeStorage('session');
    var active = readStored(sessionStore, SESSION_KEY);
    if (active) {
      cached = normalizeIdentity(active, generateId());
      cachedActive = true;
      return cached;
    }

    var localStore = safeStorage('local');
    var profile = readStored(localStore, PROFILE_KEY);

    // sem sessionStorage (navegador antigo/bloqueado): mantém o comportamento
    // antigo para o app continuar funcionando.
    if (!sessionStore && profile) {
      cached = normalizeIdentity(profile, generateId());
      cachedActive = true;
      return cached;
    }

    // janela nova: começa um participante novo, mas sugere o nome/avatar do
    // perfil salvo. Só entra de fato quando a pessoa confirma.
    cached = {
      id: generateId(),
      name: profile ? cleanName(profile.name) : '',
      avatar: (profile && sanitizeAvatar(profile.avatar)) || defaultAvatar()
    };
    cachedActive = false;
    return cached;
  }

  function update(patch) {
    var identity = Object.assign({}, load(), patch || {});
    identity.id = typeof identity.id === 'string' && ID_RE.test(identity.id) ? identity.id : generateId();
    identity.name = cleanName(identity.name);
    identity.avatar = sanitizeAvatar(identity.avatar) || defaultAvatar();
    return save(identity);
  }

  function isActive() {
    load();
    return cachedActive;
  }

  function hasSavedProfile() {
    var parsed = readStored(safeStorage('local'), PROFILE_KEY);
    return !!(parsed && (cleanName(parsed.name) || sanitizeAvatar(parsed.avatar)));
  }

  // Troca a pessoa desta janela sem mexer no perfil salvo nem nas outras abas.
  function startNewPerson() {
    cached = { id: generateId(), name: '', avatar: defaultAvatar() };
    cachedActive = true;
    writeStored(safeStorage('session'), SESSION_KEY, cached);
    return cached;
  }

  function setName(name) {
    return update({ name: name });
  }

  function setAvatar(avatar) {
    var sanitized = sanitizeAvatar(avatar);
    if (!sanitized) return load();
    return update({ avatar: sanitized });
  }

  function setEmoji(index) {
    return setAvatar(emojiAvatar(index));
  }

  function identityForServer() {
    var identity = load();
    return { id: identity.id, name: identity.name, avatar: identity.avatar };
  }

  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Nenhuma foto escolhida.'));
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        reject(new Error('Essa foto é grande demais. Escolha uma com menos de 15 MB.'));
        return;
      }
      if (file.type && !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        reject(new Error('Use uma foto PNG, JPG ou WebP.'));
        return;
      }

      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (error) {
        reject(new Error('Não consegui abrir essa foto.'));
        return;
      }

      var img = new Image();
      img.onload = function () {
        try {
          var side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
          if (!side) throw new Error('Imagem inválida.');
          var sx = ((img.naturalWidth || img.width) - side) / 2;
          var sy = ((img.naturalHeight || img.height) - side) / 2;
          var output = 192;
          var canvas = document.createElement('canvas');
          canvas.width = output;
          canvas.height = output;
          var ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
          // fundo para PNGs transparentes
          ctx.fillStyle = '#141428';
          ctx.fillRect(0, 0, output, output);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, output, output);
          var data = canvas.toDataURL('image/jpeg', 0.82);
          URL.revokeObjectURL(url);
          resolve({ kind: 'photo', value: data });
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(new Error('Não consegui preparar essa foto.'));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Não consegui ler essa imagem.'));
      };
      img.src = url;
    });
  }

  function listEmojis() {
    return EMOJIS.map(function (emoji, index) {
      return { emoji: emoji, avatar: emojiAvatar(index), index: index };
    });
  }

  Retro.identity = {
    load: load,
    save: save,
    update: update,
    isActive: isActive,
    hasSavedProfile: hasSavedProfile,
    startNewPerson: startNewPerson,
    setName: setName,
    setAvatar: setAvatar,
    setEmoji: setEmoji,
    identityForServer: identityForServer,
    readPhoto: readPhoto,
    listEmojis: listEmojis,
    emojiAvatar: emojiAvatar,
    EMOJIS: EMOJIS,
    BACKGROUNDS: BACKGROUNDS
  };
}());
