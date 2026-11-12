/* Retro Special — camada de dados (servidor via SSE) */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var engine = window.RetroEngine;

  function isDemo() {
    return false;
  }

  function apiBase() {
    return Retro.env && Retro.env.apiBase ? String(Retro.env.apiBase).replace(/\/+$/, '') : '';
  }

  function apiURL(path) {
    return apiBase() + path;
  }

  function missingBase() {
    return !apiBase();
  }

  function configError() {
    return apiError('O servidor da sala não está configurado. Ajuste assets/js/config.js.', 0);
  }

  function apiError(message, status) {
    var error = new Error(message || 'Algo deu errado.');
    error.status = status || 0;
    return error;
  }

  async function request(path, options) {
    if (missingBase()) throw configError();
    var response;
    try {
      response = await fetch(apiURL(path), options);
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
    var source = new EventSource(apiURL('/api/rooms/' + encodeURIComponent(code) + '/stream?userId=' + encodeURIComponent(userId)));
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
        fetch(apiURL('/api/rooms/' + encodeURIComponent(code))).then(function (response) {
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
        if (handlers.onKicked) handlers.onKicked(payload.message || 'Você não está mais nesta sala.');
      }
    };

    return {
      close: function () {
        closed = true;
        try { source.close(); } catch (error) { /* noop */ }
      }
    };
  }

  Retro.api = {
    createRoom: realCreateRoom,
    joinRoom: realJoinRoom,
    action: realAction,
    connect: realConnect,
    isDemo: isDemo
  };
}());
