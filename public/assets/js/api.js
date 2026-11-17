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

  // SSE é o canal preferencial. Em redes protegidas, porém, proxies podem
  // segurar a resposta do EventSource para sempre (sem onopen e sem onerror).
  // Nesse caso caímos para polling de um endpoint REST, que usa o mesmo canal
  // das chamadas de criar/entrar/ação e continua mantendo a sala atualizada.
  var SSE_OPEN_TIMEOUT = 6000;
  var SSE_MAX_ERRORS = 3;
  var SSE_RETRY_DELAY = 30000;
  var POLL_INTERVAL = 2500;

  function realConnect(code, userId, handlers) {
    var closed = false;
    var source = null;
    var openTimer = null;
    var retryTimer = null;
    var pollTimer = null;
    var polling = false;
    var pollingBusy = false;
    var errors = 0;
    var lastStatus = '';
    var streamUrl = apiURL('/api/rooms/' + encodeURIComponent(code) + '/stream?userId=' + encodeURIComponent(userId));
    var stateUrl = apiURL('/api/rooms/' + encodeURIComponent(code) + '/state?userId=' + encodeURIComponent(userId));
    var roomUrl = apiURL('/api/rooms/' + encodeURIComponent(code));

    function updateStatus(next) {
      if (closed || next === lastStatus) return;
      lastStatus = next;
      if (handlers.onStatus) handlers.onStatus(next);
    }

    function clearOpenTimer() {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    }

    function clearRetryTimer() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }

    function stopSse() {
      clearOpenTimer();
      if (source) {
        try { source.close(); } catch (error) { /* noop */ }
        source = null;
      }
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      polling = false;
    }

    function finish(message) {
      if (closed) return;
      closed = true;
      clearOpenTimer();
      clearRetryTimer();
      stopPolling();
      stopSse();
      if (handlers.onKicked) handlers.onKicked(message);
    }

    function pollNow() {
      if (closed || !polling || pollingBusy) return;
      pollingBusy = true;
      fetch(stateUrl, { cache: 'no-store' }).then(function (response) {
        if (closed) return null;
        if (response.status === 404) throw apiError('Esta sala não existe mais.', 404);
        if (response.status === 403) throw apiError('Você não está mais nesta sala.', 403);
        if (!response.ok) throw apiError('', response.status);
        return response.json();
      }).then(function (data) {
        if (closed || !data || !data.state) return;
        if (handlers.onState) handlers.onState(data.state);
      }).catch(function (error) {
        if (closed) return;
        if (error && (error.status === 404 || error.status === 403)) finish(error.message);
      }).then(function () { pollingBusy = false; });
    }

    function startPolling() {
      if (closed || polling) return;
      polling = true;
      updateStatus('polling');
      pollNow();
      pollTimer = setInterval(pollNow, POLL_INTERVAL);
    }

    function checkRoomGone() {
      fetch(roomUrl, { cache: 'no-store' }).then(function (response) {
        if (!closed && response.status === 404) finish('Esta sala não existe mais.');
      }).catch(function () { /* rede indisponível */ });
    }

    function scheduleSseRetry() {
      clearRetryTimer();
      retryTimer = setTimeout(startSse, SSE_RETRY_DELAY);
    }

    function startSse() {
      if (closed || source) return;
      clearRetryTimer();
      try {
        source = new EventSource(streamUrl);
      } catch (error) {
        startPolling();
        scheduleSseRetry();
        return;
      }

      openTimer = setTimeout(function () {
        if (closed || !source) return;
        // Nenhum header recebido a tempo: o proxy provavelmente bloqueou ou
        // bufferizou o fluxo. Mantemos o polling e tentamos o SSE depois.
        startPolling();
        stopSse();
        scheduleSseRetry();
      }, SSE_OPEN_TIMEOUT);

      source.onopen = function () {
        if (closed) return;
        clearOpenTimer();
        errors = 0;
        stopPolling();
        updateStatus('online');
      };

      source.onerror = function () {
        if (closed) return;
        clearOpenTimer();
        errors += 1;
        startPolling();
        if (errors >= SSE_MAX_ERRORS) {
          stopSse();
          scheduleSseRetry();
        }
        if (errors === 4) checkRoomGone();
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
          finish(payload.message || 'Você não está mais nesta sala.');
        }
      };
    }

    startSse();

    return {
      close: function () {
        closed = true;
        clearOpenTimer();
        clearRetryTimer();
        stopPolling();
        stopSse();
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
