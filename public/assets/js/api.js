/* Retro Special — camada de dados (servidor via SSE ou demo local) */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var engine = window.RetroEngine;
  var DEMO_KEY = 'retro-special:demo:rooms:v1';
  var DEMO_CHANNEL = 'retro-special:demo:v1';

  var demoSubs = [];
  var demoBc = null;
  var demoBcReady = false;
  var demoStorageBound = false;
  var memoryRooms = null;

  function isDemo() {
    return !!(Retro.env && Retro.env.demo);
  }

  function apiError(message, status) {
    var error = new Error(message || 'Algo deu errado.');
    error.status = status || 0;
    return error;
  }

  async function request(path, options) {
    var response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      throw apiError('Não consegui falar com o servidor. Ele está rodando?', 0);
    }
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok || (data && data.ok === false)) {
      throw apiError((data && data.error) || ('Erro inesperado (' + response.status + ').'), response.status);
    }
    return data || {};
  }

  /* ------------------------------- real -------------------------------- */

  async function realCreateRoom(identity) {
    var data = await request('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identity })
    });
    return { code: data.code, state: data.state };
  }

  async function realJoinRoom(code, identity) {
    var data = await request('/api/rooms/' + encodeURIComponent(code) + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identity })
    });
    return { code: code, state: data.state, user: data.user, isNew: data.isNew };
  }

  async function realAction(code, userId, type, payload) {
    var data = await request('/api/rooms/' + encodeURIComponent(code) + '/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, type: type, payload: payload || {} })
    });
    return { state: data.state, event: data.event || null };
  }

  function realConnect(code, userId, handlers) {
    var source = new EventSource('/api/rooms/' + encodeURIComponent(code) + '/stream?userId=' + encodeURIComponent(userId));
    var closed = false;
    var errors = 0;

    source.onopen = function () {
      if (closed) return;
      errors = 0;
      if (handlers.onStatus) handlers.onStatus('online');
    };

    source.onerror = function () {
      if (closed) return;
      errors += 1;
      if (handlers.onStatus) handlers.onStatus('reconnecting');
      if (errors === 4) {
        fetch('/api/rooms/' + encodeURIComponent(code)).then(function (response) {
          if (closed) return;
          if (response.status === 404) {
            closed = true;
            source.close();
            if (handlers.onKicked) handlers.onKicked('Esta sala não existe mais.');
          }
        }).catch(function () { /* rede indisponível */ });
      }
    };

    source.onmessage = function (message) {
      if (closed) return;
      var payload;
      try { payload = JSON.parse(message.data); } catch (error) { return; }
      if (!payload) return;
      if (payload.type === 'state') {
        if (handlers.onState) handlers.onState(payload.state);
        if (payload.event && handlers.onEvent) handlers.onEvent(payload.event);
      } else if (payload.type === 'kicked') {
        closed = true;
        source.close();
        if (handlers.onKicked) handlers.onKicked();
      }
    };

    return {
      close: function () {
        closed = true;
        try { source.close(); } catch (error) { /* noop */ }
      }
    };
  }

  /* ------------------------------- demo -------------------------------- */

  function demoStore() {
    try { return window.localStorage; } catch (error) { return null; }
  }

  function loadRooms() {
    var store = demoStore();
    if (!store) {
      if (!memoryRooms) memoryRooms = {};
      return memoryRooms;
    }
    // sempre relê do storage: outras abas podem ter alterado as salas
    try {
      var raw = store.getItem(DEMO_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      memoryRooms = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (!memoryRooms) memoryRooms = {};
    }
    return memoryRooms;
  }

  function saveRooms(rooms) {
    memoryRooms = rooms;
    var store = demoStore();
    if (!store) return;
    try {
      store.setItem(DEMO_KEY, JSON.stringify(rooms));
    } catch (error) {
      // se estourar a quota, remove salas antigas e tenta de novo
      try {
        var entries = Object.keys(rooms).map(function (code) { return [code, rooms[code]]; });
        entries.sort(function (a, b) { return (a[1].updatedAt || 0) - (b[1].updatedAt || 0); });
        while (entries.length > 6) {
          delete rooms[entries.shift()[0]];
        }
        store.setItem(DEMO_KEY, JSON.stringify(rooms));
      } catch (secondError) {
        console.warn('Modo demo: não foi possível persistir as salas.', secondError);
      }
    }
  }

  function demoLoadRoom(code) {
    var rooms = loadRooms();
    return rooms[code] || null;
  }

  function demoSaveRoom(room) {
    var rooms = loadRooms();
    rooms[room.code] = room;
    // mantém no máximo 12 salas de demonstração
    var codes = Object.keys(rooms);
    if (codes.length > 12) {
      codes.sort(function (a, b) { return (rooms[a].updatedAt || 0) - (rooms[b].updatedAt || 0); });
      while (codes.length > 12) {
        var oldest = codes.shift();
        if (!demoSubs.some(function (sub) { return sub.code === oldest; })) {
          delete rooms[oldest];
        }
      }
    }
    saveRooms(rooms);
  }

  function ensureBroadcast() {
    if (demoBcReady) return demoBc;
    demoBcReady = true;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        demoBc = new BroadcastChannel(DEMO_CHANNEL);
        demoBc.onmessage = function (event) {
          var data = event && event.data;
          if (data && data.code) deliverDemo(data.code, data.event || null);
        };
      }
    } catch (error) {
      demoBc = null;
    }

    if (!demoBc && !demoStorageBound) {
      demoStorageBound = true;
      window.addEventListener('storage', function (event) {
        if (event.key !== DEMO_KEY) return;
        var codes = {};
        demoSubs.forEach(function (sub) { codes[sub.code] = true; });
        Object.keys(codes).forEach(function (code) { deliverDemo(code); });
      });
    }
    return demoBc;
  }

  function notifyDemo(code, event) {
    deliverDemo(code, event || null);
    var bc = ensureBroadcast();
    if (bc) {
      try {
        bc.postMessage({ code: code, event: event || null, at: Date.now() });
      } catch (error) { /* noop */ }
    }
  }

  function deliverDemo(code, event) {
    var room = demoLoadRoom(code);
    if (!room) {
      demoSubs.slice().forEach(function (sub) {
        if (sub.code !== code) return;
        removeDemoSub(sub);
        if (sub.handlers.onKicked) sub.handlers.onKicked('Esta sala não existe mais.');
      });
      return;
    }
    demoSubs.slice().forEach(function (sub) {
      if (sub.code !== code) return;
      var user = engine.findUser(room, sub.userId);
      if (!user) {
        removeDemoSub(sub);
        if (sub.handlers.onKicked) sub.handlers.onKicked('Você não está mais nesta sala.');
        return;
      }
      var state = engine.getState(room, sub.userId);
      if (sub.handlers.onState) sub.handlers.onState(state);
      if (event && sub.handlers.onEvent) sub.handlers.onEvent(event);
    });
  }

  function removeDemoSub(sub) {
    var index = demoSubs.indexOf(sub);
    if (index !== -1) demoSubs.splice(index, 1);
  }

  async function demoCreateRoom(identity) {
    var rooms = loadRooms();
    var code;
    var attempts = 0;
    do {
      code = engine.randomCode(6);
      attempts += 1;
    } while (rooms[code] && attempts < 100);
    var room = engine.createRoom(identity, code);
    demoSaveRoom(room);
    return { code: code, state: engine.getState(room, identity.id) };
  }

  async function demoJoinRoom(code, identity) {
    var room = demoLoadRoom(code);
    if (!room) throw apiError('Sala não encontrada. Confira o código.', 404);
    var result = engine.joinRoom(room, identity);
    if (!result.ok) throw apiError(result.error, 400);
    demoSaveRoom(room);
    var state = engine.getState(room, identity.id);
    notifyDemo(code, result.isNew
      ? { kind: 'member-joined', userId: result.user.id }
      : { kind: 'presence', userId: result.user.id, connected: true });
    return { code: code, state: state, user: result.user, isNew: result.isNew };
  }

  async function demoAction(code, userId, type, payload) {
    var room = demoLoadRoom(code);
    if (!room) throw apiError('Sala não encontrada.', 404);
    var result = engine.applyAction(room, userId, type, payload || {});
    if (!result.ok) throw apiError(result.error, 400);
    demoSaveRoom(room);
    var event = result.event ? Object.assign({}, result.event, { actorId: userId }) : null;
    notifyDemo(code, event);
    return { state: engine.getState(room, userId), event: event };
  }

  function demoConnect(code, userId, handlers) {
    ensureBroadcast();
    var room = demoLoadRoom(code);
    if (!room) {
      setTimeout(function () {
        if (handlers.onKicked) handlers.onKicked('Sala não encontrada.');
      }, 30);
      return { close: function () {} };
    }

    if (engine.setConnected(room, userId, true)) {
      demoSaveRoom(room);
    }

    var sub = { code: code, userId: userId, handlers: handlers };
    var closed = false;
    demoSubs.push(sub);

    function disconnect() {
      if (closed) return;
      closed = true;
      window.removeEventListener('pagehide', handlePageHide);
      removeDemoSub(sub);
      var currentRoom = demoLoadRoom(code);
      if (currentRoom && engine.setConnected(currentRoom, userId, false)) {
        demoSaveRoom(currentRoom);
        notifyDemo(code);
      }
    }

    function handlePageHide(event) {
      // persisted = entrou no cache de páginas: mantém presença para voltar rápido
      if (event && event.persisted) return;
      disconnect();
    }

    window.addEventListener('pagehide', handlePageHide);

    if (handlers.onStatus) handlers.onStatus('online');
    var state = engine.getState(room, userId);
    if (handlers.onState) handlers.onState(state);

    // presencia outros participantes já conectados
    notifyDemo(code);

    return {
      close: disconnect
    };
  }

  /* ------------------------------- API --------------------------------- */

  Retro.api = {
    createRoom: function (identity) {
      return isDemo() ? demoCreateRoom(identity) : realCreateRoom(identity);
    },
    joinRoom: function (code, identity) {
      return isDemo() ? demoJoinRoom(code, identity) : realJoinRoom(code, identity);
    },
    action: function (code, userId, type, payload) {
      return isDemo() ? demoAction(code, userId, type, payload) : realAction(code, userId, type, payload);
    },
    connect: function (code, userId, handlers) {
      return isDemo() ? demoConnect(code, userId, handlers) : realConnect(code, userId, handlers);
    },
    isDemo: isDemo
  };
}());
