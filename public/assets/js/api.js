/* Retro Special — camada de dados (WebSocket, com SSE e REST como fallback) */
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

  // WebSocket é o canal preferencial: as ações chegam na hora, sem esperar
  // um intervalo. SSE entra se o upgrade for bloqueado e, se o EventSource
  // também ficar preso no proxy, o REST por polling mantém a sala viva.
  var WS_OPEN_TIMEOUT = 6000;
  var WS_MAX_ERRORS = 3;
  var WS_RETRY_DELAY = 30000;
  var WS_PING_INTERVAL = 25000;
  var SSE_OPEN_TIMEOUT = 6000;
  var SSE_MAX_ERRORS = 3;
  var SSE_RETRY_DELAY = 30000;
  var POLL_INTERVAL = 2500;

  function webSocketURL(path) {
    try {
      var url = new URL(apiURL(path), window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString();
    } catch (error) {
      return '';
    }
  }

  function realConnect(code, userId, handlers) {
    var closed = false;
    var lastStatus = '';
    var lastEventKey = '';
    var unexpectedCloses = 0;

    var ws = null;
    var wsOpenTimer = null;
    var wsRetryTimer = null;
    var wsPingTimer = null;
    var wsErrors = 0;

    var source = null;
    var sseOpenTimer = null;
    var sseRetryTimer = null;
    var sseErrors = 0;

    var pollTimer = null;
    var polling = false;
    var pollingBusy = false;

    var wsUrl = webSocketURL('/ws/rooms/' + encodeURIComponent(code) + '?userId=' + encodeURIComponent(userId));
    var streamUrl = apiURL('/api/rooms/' + encodeURIComponent(code) + '/stream?userId=' + encodeURIComponent(userId));
    var stateUrl = apiURL('/api/rooms/' + encodeURIComponent(code) + '/state?userId=' + encodeURIComponent(userId));
    var roomUrl = apiURL('/api/rooms/' + encodeURIComponent(code));

    function updateStatus(next) {
      if (closed || next === lastStatus) return;
      lastStatus = next;
      if (handlers.onStatus) handlers.onStatus(next);
    }

    function receive(payload) {
      if (closed || !payload) return;
      if (payload.type === 'state') {
        if (handlers.onState) handlers.onState(payload.state);
        if (payload.event && handlers.onEvent) {
          var key = String(payload.state && payload.state.version || '') + '|' + JSON.stringify(payload.event);
          // A mesma versão pode chegar por WS e SSE durante a troca de canal.
          if (key !== lastEventKey) {
            lastEventKey = key;
            handlers.onEvent(payload.event);
          }
        }
      } else if (payload.type === 'kicked') {
        finish(payload.message || 'Você não está mais nesta sala.');
      }
    }

    function clearTimer(name) {
      if (name === 'wsOpen') { clearTimeout(wsOpenTimer); wsOpenTimer = null; }
      else if (name === 'wsRetry') { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
      else if (name === 'sseOpen') { clearTimeout(sseOpenTimer); sseOpenTimer = null; }
      else if (name === 'sseRetry') { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
    }

    function stopWsPing() {
      if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    }

    function stopWebSocket() {
      clearTimer('wsOpen');
      stopWsPing();
      if (ws) {
        var socket = ws;
        ws = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try { socket.close(); } catch (error) { /* noop */ }
      }
    }

    function stopSse() {
      clearTimer('sseOpen');
      if (source) {
        var stream = source;
        source = null;
        stream.onopen = null;
        stream.onmessage = null;
        stream.onerror = null;
        try { stream.close(); } catch (error) { /* noop */ }
      }
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      polling = false;
    }

    function finish(message) {
      if (closed) return;
      closed = true;
      clearTimer('wsOpen');
      clearTimer('wsRetry');
      clearTimer('sseOpen');
      clearTimer('sseRetry');
      stopWsPing();
      stopPolling();
      stopSse();
      stopWebSocket();
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
      }).catch(function (error) { /* rede indisponível */ });
    }

    function scheduleWebSocketRetry() {
      clearTimer('wsRetry');
      if (closed || ws) return;
      wsRetryTimer = setTimeout(function () {
        wsRetryTimer = null;
        startWebSocket();
      }, WS_RETRY_DELAY);
    }

    function scheduleSseRetry() {
      clearTimer('sseRetry');
      if (closed) return;
      sseRetryTimer = setTimeout(startSse, SSE_RETRY_DELAY);
    }

    function startWsPing() {
      stopWsPing();
      wsPingTimer = setInterval(function () {
        if (!ws || ws.readyState !== 1) { stopWsPing(); return; }
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (error) { /* noop */ }
      }, WS_PING_INTERVAL);
    }

    function startWebSocket() {
      if (closed || ws || !window.WebSocket || !wsUrl) return;
      clearTimer('wsRetry');

      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        scheduleWebSocketRetry();
        return;
      }

      var socket = ws;
      wsOpenTimer = setTimeout(function () {
        if (closed || ws !== socket) return;
        // Sem upgrade a tempo, o proxy pode estar bloqueando WebSockets.
        stopWebSocket();
        updateStatus('reconnecting');
        startSse();
        scheduleWebSocketRetry();
      }, WS_OPEN_TIMEOUT);

      socket.onopen = function () {
        if (closed || ws !== socket) return;
        clearTimer('wsOpen');
        wsErrors = 0;
        unexpectedCloses = 0;
        stopSse();
        stopPolling();
        updateStatus('online');
        startWsPing();
      };

      socket.onmessage = function (message) {
        if (closed || ws !== socket) return;
        var payload;
        try { payload = JSON.parse(message.data); } catch (error) { return; }
        receive(payload);
      };

      socket.onerror = function () {
        if (closed || ws !== socket) return;
        wsErrors += 1;
      };

      socket.onclose = function () {
        if (closed || ws !== socket) return;
        clearTimer('wsOpen');
        stopWsPing();
        ws = null;
        updateStatus('reconnecting');
        startSse();
        scheduleWebSocketRetry();
        unexpectedCloses += 1;
        if (unexpectedCloses > WS_MAX_ERRORS) checkRoomGone();
      };
    }

    function startSse() {
      if (closed || source || ws) return;
      clearTimer('sseRetry');
      try {
        source = new EventSource(streamUrl);
      } catch (error) {
        startPolling();
        scheduleSseRetry();
        return;
      }

      sseOpenTimer = setTimeout(function () {
        if (closed || !source) return;
        // Nenhum header recebido a tempo: o proxy provavelmente bloqueou ou
        // bufferizou o fluxo. Mantemos o polling e tentamos o SSE depois.
        startPolling();
        stopSse();
        scheduleSseRetry();
      }, SSE_OPEN_TIMEOUT);

      source.onopen = function () {
        if (closed) return;
        clearTimer('sseOpen');
        sseErrors = 0;
        stopPolling();
        updateStatus('online');
      };

      source.onerror = function () {
        if (closed) return;
        clearTimer('sseOpen');
        sseErrors += 1;
        startPolling();
        if (sseErrors >= SSE_MAX_ERRORS) {
          stopSse();
          scheduleSseRetry();
        }
        if (sseErrors === 4) checkRoomGone();
      };

      source.onmessage = function (message) {
        if (closed) return;
        var payload;
        try { payload = JSON.parse(message.data); } catch (error) { return; }
        receive(payload);
      };
    }

    startWebSocket();

    return {
      close: function () {
        closed = true;
        clearTimer('wsOpen');
        clearTimer('wsRetry');
        clearTimer('sseOpen');
        clearTimer('sseRetry');
        stopWsPing();
        stopPolling();
        stopSse();
        stopWebSocket();
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
