/* Retro Special — administração de salas, pessoas e cards */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var ui = Retro.ui;
  var KEY_STORAGE = 'retro-special:admin:v1';
  var POLL_MS = 10000;
  var PHASE_LABELS = {
    setup: 'preparando',
    collecting: 'coletando respostas',
    voting: 'votação',
    closed: 'revelação',
    done: 'concluída'
  };

  var state = {
    key: '',
    rooms: [],
    selected: '',
    detail: null,
    search: '',
    lastLoaded: 0,
    initialized: false,
    roomsLoading: false,
    detailSeq: 0
  };

  var els = {};
  var pollTimer = null;
  var warned = false;

  /* ------------------------------------------------------------------ *
   * armazenamento e API
   * ------------------------------------------------------------------ */

  function readKey() {
    try { return window.sessionStorage.getItem(KEY_STORAGE) || ''; } catch (error) { return ''; }
  }

  function saveKey(key) {
    try { window.sessionStorage.setItem(KEY_STORAGE, key); } catch (error) { /* sem storage */ }
  }

  function clearKey() {
    try { window.sessionStorage.removeItem(KEY_STORAGE); } catch (error) { /* sem storage */ }
  }

  function apiError(message, status) {
    var error = new Error(message || 'Algo deu errado.');
    error.status = status || 0;
    return error;
  }

  function apiRequest(path, options) {
    var base = Retro.env && Retro.env.apiBase
      ? String(Retro.env.apiBase).replace(/\/+$/, '')
      : '';
    if (Retro.env && Retro.env.hosted && !base) {
      return Promise.reject(apiError('O servidor da administração não está configurado.', 0));
    }

    options = options || {};
    var headers = {};
    Object.keys(options.headers || {}).forEach(function (key) { headers[key] = options.headers[key]; });
    headers.Authorization = 'Bearer ' + state.key;

    var init = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return fetch(base + path, init).catch(function () {
      throw apiError('Não consegui falar com o servidor da administração.', 0);
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (!response.ok || (data && data.ok === false)) {
          throw apiError((data && data.error) || ('Erro inesperado (' + response.status + ').'), response.status);
        }
        return data || {};
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * inicialização
   * ------------------------------------------------------------------ */

  function cache() {
    els.view = document.getElementById('admin-view');
    els.login = document.getElementById('admin-login');
    els.loginForm = document.getElementById('admin-login-form');
    els.keyInput = document.getElementById('admin-key-input');
    els.loginError = document.getElementById('admin-login-error');
    els.loginSubmit = document.getElementById('admin-login-submit');
    els.panel = document.getElementById('admin-panel');
    els.logout = document.getElementById('admin-logout');
    els.search = document.getElementById('admin-search');
    els.refresh = document.getElementById('admin-refresh');
    els.count = document.getElementById('admin-count');
    els.updated = document.getElementById('admin-updated');
    els.roomList = document.getElementById('admin-room-list');
    els.empty = document.getElementById('admin-empty');
    els.detail = document.getElementById('admin-detail');
    els.placeholder = document.getElementById('admin-placeholder');
    els.detailBody = document.getElementById('admin-detail-body');
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    cache();
    if (!els.view) return;

    state.key = readKey();

    els.loginForm.addEventListener('submit', onLogin);
    els.logout.addEventListener('click', function () {
      logout('Você saiu da administração.');
    });
    els.search.addEventListener('input', function () {
      state.search = els.search.value || '';
      renderRoomList();
    });
    els.refresh.addEventListener('click', function () {
      loadRooms(false);
      if (state.selected) loadRoom(state.selected, false);
    });
    els.roomList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-admin-room]');
      if (!button) return;
      loadRoom(button.getAttribute('data-admin-room'), false);
    });
    els.detail.addEventListener('click', onDetailClick);
    els.detail.addEventListener('submit', onDetailSubmit);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!state.key || !isVisible()) return;
      loadRooms(true);
      if (state.selected) loadRoom(state.selected, true);
    });
  }

  function isVisible() {
    return !!(els.view && !els.view.hidden);
  }

  function open() {
    if (!state.initialized) init();
    if (!els.view) return;
    if (!state.key) {
      showLogin();
      return;
    }
    showPanel();
    if (!state.detail) showPlaceholder('Escolha uma sala', 'Os detalhes, as pessoas e os cards aparecem aqui.');
    renderRoomList();
    loadRooms(false);
    startPolling();
  }

  function close() {
    stopPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.visibilityState !== 'visible' || !isVisible()) return;
      loadRooms(true);
      if (state.selected) loadRoom(state.selected, true);
    }, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ------------------------------------------------------------------ *
   * login / logout
   * ------------------------------------------------------------------ */

  function showLogin() {
    if (!els.view) return;
    els.login.hidden = false;
    els.panel.hidden = true;
    els.logout.hidden = true;
    els.loginError.hidden = true;
    els.keyInput.value = '';
    stopPolling();
    setTimeout(function () {
      try { els.keyInput.focus(); } catch (error) { /* noop */ }
    }, 40);
  }

  function showLoginError(message) {
    els.loginError.textContent = message || '';
    els.loginError.hidden = false;
  }

  function showPanel() {
    els.login.hidden = true;
    els.panel.hidden = false;
    els.logout.hidden = false;
  }

  function onLogin(event) {
    event.preventDefault();
    var candidate = els.keyInput.value.trim();
    if (!candidate) {
      showLoginError('Digite a chave de administrador.');
      return;
    }

    var previous = state.key;
    state.key = candidate;
    els.loginError.hidden = true;
    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Entrando…';

    apiRequest('/api/admin/session', { method: 'POST' }).then(function () {
      saveKey(candidate);
      state.rooms = [];
      state.selected = '';
      state.detail = null;
      state.lastLoaded = 0;
      warned = false;
      showPanel();
      renderRoomList();
      showPlaceholder('Escolha uma sala', 'Os detalhes, as pessoas e os cards aparecem aqui.');
      ui.toast('Bem-vindo(a) à administração.', 'success');
      loadRooms(false);
      startPolling();
    }).catch(function (error) {
      state.key = previous;
      showLoginError(error.message || 'Não consegui entrar.');
    }).then(function () {
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = 'Entrar';
    });
  }

  function logout(message) {
    clearKey();
    state.key = '';
    state.rooms = [];
    state.selected = '';
    state.detail = null;
    state.lastLoaded = 0;
    state.detailSeq += 1;
    warned = false;
    stopPolling();
    if (!els.view) return;
    showLogin();
    showPlaceholder('Escolha uma sala', 'Os detalhes, as pessoas e os cards aparecem aqui.');
    renderRoomList();
    if (message) ui.toast(message);
  }

  function handleAuthError(error) {
    if (error && error.status === 401) {
      logout('Sua chave de administrador não vale mais. Entre de novo.');
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * lista de salas
   * ------------------------------------------------------------------ */

  function loadRooms(quiet) {
    if (!state.key || state.roomsLoading) return Promise.resolve();
    state.roomsLoading = true;
    if (!quiet) setRefreshing(true);

    return apiRequest('/api/admin/rooms').then(function (data) {
      state.rooms = Array.isArray(data.rooms) ? data.rooms : [];
      state.lastLoaded = Date.now();
      if (data.warning && !warned) {
        warned = true;
        ui.toast(data.warning, 'error');
      }
      renderRoomList();

      var stillThere = state.selected && state.rooms.some(function (room) {
        return room.code === state.selected;
      });
      if (state.selected && !stillThere) {
        clearDetail();
      } else if (!state.selected && state.rooms.length) {
        loadRoom(state.rooms[0].code, true);
      }
    }).catch(function (error) {
      if (handleAuthError(error)) return;
      if (!quiet) ui.toast(error.message || 'Não consegui carregar as salas.', 'error');
    }).then(function () {
      state.roomsLoading = false;
      if (!quiet) setRefreshing(false);
    });
  }

  function setRefreshing(value) {
    if (!els.refresh) return;
    els.refresh.disabled = !!value;
    els.refresh.textContent = value ? 'Atualizando…' : 'Atualizar';
  }

  function visibleRooms() {
    var term = state.search.trim().toLowerCase();
    if (!term) return state.rooms;
    return state.rooms.filter(function (room) {
      return room.code.toLowerCase().indexOf(term) !== -1 ||
        String(room.organizerName || '').toLowerCase().indexOf(term) !== -1;
    });
  }

  function renderRoomList() {
    if (!els.roomList) return;
    var rooms = visibleRooms();
    var total = state.rooms.length;

    els.count.textContent = rooms.length === 1
      ? '1 sala'
      : rooms.length + ' salas' + (rooms.length !== total ? ' de ' + total : '');
    els.updated.textContent = state.lastLoaded ? 'atualizado ' + relativeTime(state.lastLoaded) : '';

    if (!rooms.length) {
      els.roomList.innerHTML = '';
      els.empty.hidden = false;
      els.empty.textContent = total
        ? 'Nenhuma sala combina com a busca.'
        : 'Nenhuma sala por aqui. Crie uma na tela inicial.';
      return;
    }

    els.empty.hidden = true;
    els.roomList.innerHTML = rooms.map(roomButtonHTML).join('');
  }

  function roomButtonHTML(room) {
    var active = room.code === state.selected;
    var online = room.onlineCount
      ? room.onlineCount + ' online'
      : 'ninguém online';
    return '<button class="admin-room' + (active ? ' is-active' : '') + '" type="button" ' +
      'data-admin-room="' + ui.esc(room.code) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
      '<span class="admin-room-top">' +
        '<strong>' + ui.esc(room.code) + '</strong>' +
        '<span class="admin-room-time">' + ui.esc(relativeTime(room.updatedAt)) + '</span>' +
      '</span>' +
      '<span class="admin-room-org">' +
        (room.organizerName ? 'org. ' + ui.esc(room.organizerName) : 'sem organizador') +
      '</span>' +
      '<span class="admin-room-stats">' +
        '<span title="Pessoas">👥 ' + room.userCount + '</span>' +
        '<span title="Acertos">✅ ' + room.acertos + '</span>' +
        '<span title="Melhorias">🔧 ' + room.melhorias + '</span>' +
        '<span class="admin-room-online">' + ui.esc(online) + '</span>' +
      '</span>' +
    '</button>';
  }

  /* ------------------------------------------------------------------ *
   * detalhe da sala
   * ------------------------------------------------------------------ */

  function loadRoom(code, quiet) {
    if (!state.key) return Promise.resolve();
    var seq = state.detailSeq + 1;
    state.detailSeq = seq;

    if (!quiet) {
      state.selected = code;
      renderRoomList();
      showPlaceholder('Carregando sala ' + code, 'Buscando os detalhes…');
    }

    return apiRequest('/api/admin/rooms/' + encodeURIComponent(code)).then(function (data) {
      if (seq !== state.detailSeq) return;
      if (!data.room) throw apiError('Sala não encontrada.', 404);
      state.selected = data.room.code;
      state.detail = data.room;
      renderDetail();
      renderRoomList();
    }).catch(function (error) {
      if (seq !== state.detailSeq) return;
      if (handleAuthError(error)) return;
      if (error.status === 404) {
        state.selected = '';
        state.detail = null;
        renderRoomList();
        clearDetail();
        if (!quiet) ui.toast('Sala não encontrada.', 'error');
        return;
      }
      if (!quiet) ui.toast(error.message || 'Não consegui carregar a sala.', 'error');
    });
  }

  function showPlaceholder(title, text) {
    if (!els.placeholder || !els.detailBody) return;
    els.placeholder.innerHTML =
      '<span class="admin-placeholder-mark" aria-hidden="true">✦</span>' +
      '<h2>' + ui.esc(title) + '</h2>' +
      '<p>' + ui.esc(text) + '</p>';
    els.placeholder.hidden = false;
    els.detailBody.hidden = true;
  }

  function clearDetail() {
    state.selected = '';
    state.detail = null;
    state.detailSeq += 1;
    showPlaceholder('Escolha uma sala', 'Os detalhes, as pessoas e os cards aparecem aqui.');
  }

  function renderDetail() {
    if (!state.detail) {
      clearDetail();
      return;
    }
    els.placeholder.hidden = true;
    els.detailBody.hidden = false;
    els.detailBody.innerHTML = detailHTML(state.detail);
  }

  function userMap(room) {
    var map = {};
    (room.users || []).forEach(function (user) { map[user.id] = user; });
    return map;
  }

  function detailHTML(room) {
    var users = userMap(room);
    var organizer = users[room.organizerId];
    var online = (room.users || []).filter(function (user) { return user.connected; }).length;
    var phase = PHASE_LABELS[room.dynamics.phase] || room.dynamics.phase;

    var metrics =
      '<div class="admin-metrics">' +
        metricHTML('Pessoas', room.users.length, online + ' online') +
        metricHTML('Acertos', room.acertos.count, room.acertos.revealed ? 'revelados' : 'ocultos') +
        metricHTML('Melhorias', room.melhorias.count, room.melhorias.revealed ? 'reveladas' : 'ocultas') +
        metricHTML('Dinâmica', phase, room.dynamics.answerCount + ' resposta' + (room.dynamics.answerCount === 1 ? '' : 's')) +
      '</div>';

    return '<div class="admin-detail-head">' +
        '<div class="admin-detail-title">' +
          '<span class="eyebrow">sala</span>' +
          '<h2>' + ui.esc(room.code) + '</h2>' +
          '<p>Organizador: <b>' + ui.esc(organizer ? organizer.name : 'ninguém') + '</b> · ' +
            'criada em ' + ui.esc(fullDate(room.createdAt)) + ' · última atividade ' + ui.esc(relativeTime(room.updatedAt)) + '</p>' +
        '</div>' +
        '<button class="btn btn-danger btn-small" type="button" data-admin-action="delete-room">Encerrar sala</button>' +
      '</div>' +
      metrics +
      membersHTML(room) +
      '<div class="admin-board">' +
        columnHTML(room, room.acertos, 'Acertos', '✅') +
        columnHTML(room, room.melhorias, 'Melhorias', '🔧') +
      '</div>' +
      dynamicsHTML(room);
  }

  function metricHTML(label, value, hint) {
    return '<article class="admin-metric">' +
      '<span>' + ui.esc(label) + '</span>' +
      '<strong>' + ui.esc(value) + '</strong>' +
      '<small>' + ui.esc(hint) + '</small>' +
    '</article>';
  }

  function membersHTML(room) {
    var rows = (room.users || []).map(function (user) {
      var badges = [];
      if (user.isOrganizer) badges.push('<span class="admin-badge org">organizador</span>');
      badges.push('<span class="admin-badge ' + (user.connected ? 'online' : 'offline') + '">' +
        (user.connected ? 'online' : 'offline') + '</span>');
      return '<div class="admin-member">' +
        '<span class="admin-member-avatar">' + ui.userAvatar(user, { size: 38 }) + '</span>' +
        '<div class="admin-member-info">' +
          '<strong>' + ui.esc(user.name) + '</strong>' +
          '<span>' + badges.join('') + ' entrou ' + ui.esc(relativeTime(user.joinedAt)) + '</span>' +
        '</div>' +
        '<button class="btn btn-danger btn-small" type="button" data-admin-action="remove-user" ' +
          'data-user-id="' + ui.esc(user.id) + '">Remover</button>' +
      '</div>';
    }).join('');

    return '<section class="admin-section">' +
      '<div class="admin-section-head">' +
        '<h3>Pessoas</h3>' +
        '<span class="admin-section-count">' + (room.users || []).length + '</span>' +
      '</div>' +
      (rows ? '<div class="admin-member-list">' + rows + '</div>' : '<p class="admin-empty-inline">Ninguém na sala.</p>') +
    '</section>';
  }

  function authorOptions(room) {
    var options = (room.users || []).map(function (user) {
      return '<option value="' + ui.esc(user.id) + '">' + ui.esc(user.name) +
        (user.isOrganizer ? ' (organizador)' : '') + '</option>';
    }).join('');
    return '<option value="">sem autor (anônimo)</option>' + options;
  }

  function columnHTML(room, column, title, icon) {
    var cards = (column.cards || []).map(function (card) {
      return cardHTML(room, column.key, card);
    }).join('');

    return '<section class="admin-section admin-column" data-admin-column="' + ui.esc(column.key) + '">' +
      '<div class="admin-section-head">' +
        '<h3>' + icon + ' ' + ui.esc(title) + '</h3>' +
        '<span class="admin-section-count">' + column.count + '</span>' +
      '</div>' +
      '<p class="admin-column-state">' +
        (column.revealed ? 'visível para todos' : 'conteúdo oculto até a revelação') +
      '</p>' +
      '<form class="admin-add-card" data-admin-form="add-card" data-column="' + ui.esc(column.key) + '">' +
        '<textarea name="text" rows="2" maxlength="600" placeholder="Adicionar um card em ' + ui.esc(title.toLowerCase()) + '…" required></textarea>' +
        '<div class="admin-add-card-row">' +
          '<select name="authorId" aria-label="Autor do card">' + authorOptions(room) + '</select>' +
          '<button class="btn btn-secondary btn-small" type="submit">Adicionar</button>' +
        '</div>' +
      '</form>' +
      (cards ? '<div class="admin-card-list">' + cards + '</div>' : '<p class="admin-empty-inline">Nenhum card ainda.</p>') +
    '</section>';
  }

  function cardHTML(room, columnKey, card) {
    var users = userMap(room);
    var author = card.authorId
      ? (card.authorName || (users[card.authorId] && users[card.authorId].name) || 'autor removido')
      : 'sem autor (anônimo)';
    var plan = card.actionPlan || {};
    var assigneeNames = (plan.assignees || []).map(function (id) {
      return users[id] ? users[id].name : 'pessoa removida';
    });

    return '<article class="admin-card">' +
      '<p class="admin-card-text">' + ui.esc(card.text) + '</p>' +
      '<div class="admin-card-meta">' +
        '<span>' + ui.esc(author) + '</span>' +
        '<span>👍 ' + (card.likeCount || 0) + '</span>' +
        '<span>' + ui.esc(relativeTime(card.createdAt)) + '</span>' +
      '</div>' +
      (plan.text || assigneeNames.length
        ? '<div class="admin-plan">' +
            '<span>🎯 plano de ação</span>' +
            (plan.text ? '<p>' + ui.esc(plan.text) + '</p>' : '') +
            (assigneeNames.length ? '<small>responsáveis: ' + ui.esc(assigneeNames.join(', ')) + '</small>' : '') +
          '</div>'
        : '') +
      '<div class="admin-card-actions">' +
        '<button class="btn btn-ghost btn-small" type="button" data-admin-action="edit-card" ' +
          'data-column="' + ui.esc(columnKey) + '" data-card-id="' + ui.esc(card.id) + '">Editar</button>' +
        '<button class="btn btn-danger btn-small" type="button" data-admin-action="delete-card" ' +
          'data-column="' + ui.esc(columnKey) + '" data-card-id="' + ui.esc(card.id) + '">Remover</button>' +
      '</div>' +
    '</article>';
  }

  function dynamicsHTML(room) {
    var d = room.dynamics;
    var phase = PHASE_LABELS[d.phase] || d.phase;
    return '<section class="admin-section">' +
      '<div class="admin-section-head">' +
        '<h3>Dinâmica</h3>' +
        '<span class="admin-section-count">' + ui.esc(phase) + '</span>' +
      '</div>' +
      '<div class="admin-dynamics">' +
        '<div><span>Fase</span><strong>' + ui.esc(phase) + '</strong></div>' +
        '<div><span>Pergunta</span><strong>' + ui.esc(d.question || 'sem pergunta') + '</strong></div>' +
        '<div><span>Participantes</span><strong>' + d.participantCount + '</strong></div>' +
        '<div><span>Respostas</span><strong>' + d.answerCount + '</strong></div>' +
        '<div><span>Reveladas</span><strong>' + d.revealedCount + ' de ' + d.totalAnswers + '</strong></div>' +
      '</div>' +
    '</section>';
  }

  /* ------------------------------------------------------------------ *
   * ações
   * ------------------------------------------------------------------ */

  function findCard(columnKey, cardId) {
    if (!state.detail) return null;
    var column = columnKey === 'melhorias' ? state.detail.melhorias : state.detail.acertos;
    if (!column) return null;
    for (var i = 0; i < column.cards.length; i += 1) {
      if (column.cards[i].id === cardId) return column.cards[i];
    }
    return null;
  }

  function applyRoom(room) {
    if (!room) return;
    state.selected = room.code;
    state.detail = room;
    renderDetail();
    renderRoomList();
  }

  function onDetailClick(event) {
    var button = event.target.closest('[data-admin-action]');
    if (!button || !state.detail) return;
    var action = button.getAttribute('data-admin-action');
    if (action === 'remove-user') removeUser(button);
    else if (action === 'edit-card') editCard(button);
    else if (action === 'delete-card') deleteCard(button);
    else if (action === 'delete-room') deleteRoom();
  }

  function removeUser(button) {
    var room = state.detail;
    var userId = button.getAttribute('data-user-id');
    var user = null;
    room.users.forEach(function (item) { if (item.id === userId) user = item; });
    if (!user) return;

    ui.confirmDialog({
      title: 'Remover pessoa?',
      message: 'Remover ' + user.name + ' da sala? Os cards, joinhas e respostas dessa pessoa também serão apagados.',
      confirmLabel: 'Remover',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      button.disabled = true;
      apiRequest('/api/admin/rooms/' + encodeURIComponent(room.code) + '/users/' + encodeURIComponent(userId) + '/remove', {
        method: 'POST'
      }).then(function (data) {
        applyRoom(data.room);
        ui.toast(user.name + ' foi removido(a) da sala.', 'success');
        loadRooms(true);
      }).catch(function (error) {
        button.disabled = false;
        if (handleAuthError(error)) return;
        ui.toast(error.message || 'Não consegui remover a pessoa.', 'error');
      });
    });
  }

  function editCard(button) {
    var room = state.detail;
    var column = button.getAttribute('data-column');
    var cardId = button.getAttribute('data-card-id');
    var card = findCard(column, cardId);
    if (!card) return;

    var root = ui.openModal('Editar card',
      '<label class="field">' +
        '<span class="field-label">Texto do card</span>' +
        '<textarea id="admin-card-text" class="admin-textarea" rows="5" maxlength="600">' + ui.esc(card.text) + '</textarea>' +
      '</label>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-admin-edit-cancel>Cancelar</button>' +
        '<button class="btn btn-primary" type="button" data-admin-edit-save>Salvar card</button>' +
      '</div>'
    );
    if (!root) return;

    var textarea = root.querySelector('#admin-card-text');
    var save = root.querySelector('[data-admin-edit-save]');
    var cancel = root.querySelector('[data-admin-edit-cancel]');
    if (cancel) cancel.addEventListener('click', function () { ui.closeModal(false); });
    if (save) save.addEventListener('click', function () {
      var text = textarea ? textarea.value : '';
      if (!text.trim()) {
        ui.toast('O card não pode ficar vazio.', 'error');
        return;
      }
      save.disabled = true;
      apiRequest('/api/admin/rooms/' + encodeURIComponent(room.code) + '/cards/' + encodeURIComponent(cardId) + '/edit', {
        method: 'POST',
        body: { column: column, text: text }
      }).then(function (data) {
        ui.closeModal(true);
        applyRoom(data.room);
        ui.toast('Card atualizado.', 'success');
        loadRooms(true);
      }).catch(function (error) {
        save.disabled = false;
        if (handleAuthError(error)) return;
        ui.toast(error.message || 'Não consegui editar o card.', 'error');
      });
    });
  }

  function deleteCard(button) {
    var room = state.detail;
    var column = button.getAttribute('data-column');
    var cardId = button.getAttribute('data-card-id');
    var card = findCard(column, cardId);

    ui.confirmDialog({
      title: 'Remover card?',
      message: card ? 'Remover o card "' + card.text + '"? Essa ação não pode ser desfeita.' : 'Remover este card?',
      confirmLabel: 'Remover',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      button.disabled = true;
      apiRequest('/api/admin/rooms/' + encodeURIComponent(room.code) + '/cards/' + encodeURIComponent(cardId) + '/delete', {
        method: 'POST',
        body: { column: column }
      }).then(function (data) {
        applyRoom(data.room);
        ui.toast('Card removido.', 'success');
        loadRooms(true);
      }).catch(function (error) {
        button.disabled = false;
        if (handleAuthError(error)) return;
        ui.toast(error.message || 'Não consegui remover o card.', 'error');
      });
    });
  }

  function deleteRoom() {
    var room = state.detail;
    ui.confirmDialog({
      title: 'Encerrar sala?',
      message: 'A sala ' + room.code + ' será apagada para sempre. Todo mundo será desconectado.',
      confirmLabel: 'Encerrar sala',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      apiRequest('/api/admin/rooms/' + encodeURIComponent(room.code) + '/delete', {
        method: 'POST'
      }).then(function () {
        state.rooms = state.rooms.filter(function (item) { return item.code !== room.code; });
        clearDetail();
        renderRoomList();
        ui.toast('Sala ' + room.code + ' encerrada.', 'success');
        loadRooms(true);
      }).catch(function (error) {
        if (handleAuthError(error)) return;
        if (error.status === 404) {
          state.rooms = state.rooms.filter(function (item) { return item.code !== room.code; });
          clearDetail();
          renderRoomList();
          ui.toast('Essa sala já não existia.', 'error');
          return;
        }
        ui.toast(error.message || 'Não consegui encerrar a sala.', 'error');
      });
    });
  }

  function onDetailSubmit(event) {
    var form = event.target.closest('[data-admin-form="add-card"]');
    if (!form || !state.detail) return;
    event.preventDefault();

    var room = state.detail;
    var column = form.getAttribute('data-column');
    var textarea = form.querySelector('[name="text"]');
    var author = form.querySelector('[name="authorId"]');
    var text = textarea ? textarea.value : '';
    if (!text.trim()) {
      ui.toast('Escreva o texto do card.', 'error');
      if (textarea) textarea.focus();
      return;
    }

    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    apiRequest('/api/admin/rooms/' + encodeURIComponent(room.code) + '/cards', {
      method: 'POST',
      body: {
        column: column,
        text: text,
        authorId: author ? author.value : ''
      }
    }).then(function (data) {
      applyRoom(data.room);
      ui.toast('Card adicionado.', 'success');
      loadRooms(true);
    }).catch(function (error) {
      if (submit) submit.disabled = false;
      if (handleAuthError(error)) return;
      ui.toast(error.message || 'Não consegui adicionar o card.', 'error');
    });
  }

  /* ------------------------------------------------------------------ *
   * utilidades
   * ------------------------------------------------------------------ */

  function relativeTime(timestamp) {
    var value = Number(timestamp) || 0;
    if (!value) return '—';
    var diff = Date.now() - value;
    if (diff < 45000) return 'agora';
    var minutes = Math.round(diff / 60000);
    if (minutes < 60) return 'há ' + minutes + ' min';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return 'há ' + hours + ' h';
    var days = Math.round(hours / 24);
    return 'há ' + days + ' d';
  }

  function fullDate(timestamp) {
    var value = Number(timestamp) || 0;
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (error) {
      return '—';
    }
  }

  Retro.admin = {
    init: init,
    open: open,
    close: close
  };
}());
