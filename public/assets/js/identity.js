/* Retro Special — identidade local (nome, avatar e foto) */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var KEY = 'retro-special:identity:v1';
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

  function storage() {
    try {
      var demo = Retro.env && Retro.env.demo;
      return demo ? window.sessionStorage : window.localStorage;
    } catch (error) {
      return null;
    }
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
    var store = storage();
    if (store) {
      try { store.setItem(KEY, JSON.stringify(identity)); } catch (error) { /* quota / modo privado */ }
    }
    return identity;
  }

  function load() {
    if (cached) return cached;
    var store = storage();
    var raw = null;
    if (store) {
      try { raw = store.getItem(KEY); } catch (error) { raw = null; }
    }
    var identity = null;
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          identity = {
            id: typeof parsed.id === 'string' && ID_RE.test(parsed.id) ? parsed.id : generateId(),
            name: cleanName(parsed.name),
            avatar: sanitizeAvatar(parsed.avatar) || defaultAvatar()
          };
        }
      } catch (error) { identity = null; }
    }
    if (!identity) {
      identity = { id: generateId(), name: '', avatar: defaultAvatar() };
    }
    cached = identity;
    save(identity);
    return identity;
  }

  function update(patch) {
    var identity = Object.assign({}, load(), patch || {});
    identity.id = typeof identity.id === 'string' && ID_RE.test(identity.id) ? identity.id : generateId();
    identity.name = cleanName(identity.name);
    identity.avatar = sanitizeAvatar(identity.avatar) || defaultAvatar();
    return save(identity);
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
