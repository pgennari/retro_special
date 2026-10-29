/* Retro Special — sala em tempo real */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var ui = Retro.ui;
  var identity = Retro.identity;

  var PHASE_LABELS = {
    setup: 'preparando',
    collecting: 'coletando respostas',
    voting: 'palpites abertos',
    closed: 'revelando autores',
    done: 'rodada encerrada'
  };

  var COLUMN_LABELS = { acertos: 'Acertos', melhorias: 'Melhorias' };

  var refs = {};
  var bound = false;
  var current = null;
  var currentCode = null;
  var currentUserId = null;
  var connection = null;
  var openToken = 0;
  var status = 'connecting';

  var drafts = { acertos: '', melhorias: '', answer: '', question: '' };
  var answerDirty = false;
  var questionDirty = false;
  var selectedTarget = null;
  var lastPhase = null;
  var lastRound = 0;

  var seenShuffle = 0;
  var shufflePlaying = false;
  var shuffleTimers = [];
  var shuffleGhostTimer = null;

  var prevScores = {};
  var actionLocks = {};
  var likeLocks = {};
  var lateTimers = [];

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  function $(selector, root) { return ui.$(selector, root); }
  function $$(selector, root) { return ui.$$(selector, root); }
  function esc(value) { return ui.esc(value); }

  function findUser(userId) {
    if (!current) return null;
    for (var i = 0; i < current.users.length; i += 1) {
      if (current.users[i].id === userId) return current.users[i];
    }
    return null;
  }

  function displayName(user) {
    if (!user) return 'Participante';
    return user.id === currentUserId ? 'Você' : user.name;
  }

  function later(fn, ms) {
    var timer = setTimeout(fn, ms);
    lateTimers.push(timer);
    return timer;
  }

  function clearLater() {
    lateTimers.forEach(clearTimeout);
    lateTimers = [];
  }

  function findCardEl(cardId) {
    var cards = $$('.card');
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].getAttribute('data-card-id') === cardId) return cards[i];
    }
    return null;
  }

  function findAnswerEl(answerId) {
    return $('.reveal-card[data-answer-id="' + esc(answerId) + '"]');
  }

  /* ------------------------------------------------------------------ *
   * ciclo de vida
   * ------------------------------------------------------------------ */

  function init() {
    if (bound) return;
    bound = true;

    refs.roomView = document.getElementById('room-view');
    refs.codeChip = document.getElementById('code-chip');
    refs.roomCode = document.getElementById('room-code');
    refs.footerCode = document.getElementById('footer-code');
    refs.roomDemoChip = document.getElementById('room-demo-chip');
    refs.livePill = document.getElementById('live-pill');
    refs.liveText = document.getElementById('live-text');
    refs.offlineBanner = document.getElementById('offline-banner');
    refs.offlineText = document.getElementById('offline-text');
    refs.peopleBtn = document.getElementById('people-btn');
    refs.peoplePopover = document.getElementById('people-popover');
    refs.peopleList = document.getElementById('people-list');
    refs.popCount = document.getElementById('pop-count');
    refs.avatarStack = document.getElementById('avatar-stack');
    refs.peopleCount = document.getElementById('people-count');
    refs.leaveBtn = document.getElementById('leave-btn');
    refs.phase = document.getElementById('dynamics-phase');
    refs.extra = document.getElementById('dynamics-extra');
    refs.dynamicsBody = document.getElementById('dynamics-body');
    refs.shuffleOverlay = document.getElementById('shuffle-overlay');
    refs.shuffleStage = document.getElementById('shuffle-stage');
    refs.shuffleGhosts = document.getElementById('shuffle-ghosts');
    refs.board = document.querySelector('.board-grid');

    refs.panels = {
      acertos: {
        panel: document.getElementById('panel-acertos'),
        count: $('#panel-acertos [data-count]'),
        action: $('#panel-acertos [data-action]'),
        cards: $('#panel-acertos [data-cards]'),
        form: $('[data-composer-form="acertos"]'),
        textarea: $('[data-composer-form="acertos"] [data-composer]')
      },
      melhorias: {
        panel: document.getElementById('panel-melhorias'),
        count: $('#panel-melhorias [data-count]'),
        action: $('#panel-melhorias [data-action]'),
        cards: $('#panel-melhorias [data-cards]'),
        form: $('[data-composer-form="melhorias"]'),
        textarea: $('[data-composer-form="melhorias"] [data-composer]')
      }
    };

    refs.panels.acertos.form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitCard('acertos');
    });
    refs.panels.melhorias.form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitCard('melhorias');
    });
    ['acertos', 'melhorias'].forEach(function (key) {
      refs.panels[key].textarea.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          refs.panels[key].form.requestSubmit();
        }
      });
    });

    refs.codeChip.addEventListener('click', copyRoomLink);
    refs.leaveBtn.addEventListener('click', leaveRoom);
    refs.peopleBtn.addEventListener('click', togglePeople);
    refs.peopleList.addEventListener('click', handlePeopleClick);

    refs.board.addEventListener('click', handleBoardClick);

    refs.extra.addEventListener('click', handleDynamicsClick);
    refs.dynamicsBody.addEventListener('click', handleDynamicsClick);
    refs.dynamicsBody.addEventListener('input', handleDynamicsInput);
    refs.dynamicsBody.addEventListener('keydown', handleDynamicsKeydown);
    refs.dynamicsBody.addEventListener('dragstart', handleDragStart);
    refs.dynamicsBody.addEventListener('dragover', handleDragOver);
    refs.dynamicsBody.addEventListener('dragleave', handleDragLeave);
    refs.dynamicsBody.addEventListener('drop', handleDrop);
    refs.dynamicsBody.addEventListener('dragend', handleDragEnd);

    document.addEventListener('click', function (event) {
      if (refs.peoplePopover.hidden) return;
      if (event.target.closest('#people-popover') || event.target.closest('#people-btn')) return;
      closePeople();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !refs.peoplePopover.hidden) closePeople();
    });
  }

  async function open(code, initialState) {
    init();
    code = ui.normalizeCode(code);
    if (!code) return;

    var token = ++openToken;
    destroyConnection();
    stopShuffle();
    closePeople();
    closeModalSafe();
    clearLater();

    current = null;
    currentCode = code;
    currentUserId = identity.load().id;
    drafts = { acertos: '', melhorias: '', answer: '', question: '' };
    answerDirty = false;
    questionDirty = false;
    selectedTarget = null;
    seenShuffle = readSeenShuffle(code);
    shufflePlaying = false;
    prevScores = {};
    lastPhase = null;
    lastRound = 0;
    actionLocks = {};
    likeLocks = {};

    resetRoomUi(code);

    var me = identity.load();
    if (!me.name) {
      Retro.app.goHome({ prefillCode: code });
      return;
    }

    var initial = initialState || null;
    if (!initial) {
      try {
        var result = await Retro.api.joinRoom(code, identity.identityForServer());
        if (token !== openToken) return;
        initial = result.state;
      } catch (error) {
        if (token !== openToken) return;
        Retro.app.goHome({ error: error.message, prefillCode: code });
        return;
      }
    }
    if (token !== openToken) return;

    applyState(initial, { force: true });
    if (token !== openToken) return;

    connection = Retro.api.connect(code, currentUserId, {
      onState: function (state) {
        if (token !== openToken) return;
        applyState(state);
      },
      onEvent: function (event) {
        if (token !== openToken) return;
        handleEvent(event);
      },
      onStatus: function (nextStatus) {
        if (token !== openToken) return;
        setStatus(nextStatus);
      },
      onKicked: function (message) {
        if (token !== openToken) return;
        Retro.app.goHome({ error: message || 'Você não está mais nesta sala.' });
      }
    });
  }

  function close() {
    openToken += 1;
    destroyConnection();
    stopShuffle();
    clearLater();
    closePeople();
    closeModalSafe();
    current = null;
    currentCode = null;
    currentUserId = null;
    status = 'connecting';
    if (refs.offlineBanner) refs.offlineBanner.hidden = true;
    clearTimeout(shuffleGhostTimer);
    shuffleGhostTimer = null;
  }

  function destroyConnection() {
    if (connection) {
      try { connection.close(); } catch (error) { /* noop */ }
      connection = null;
    }
  }

  function closeModalSafe() {
    try { ui.closeModal(false); } catch (error) { /* noop */ }
  }

  function copyRoomLink() {
    if (!currentCode) return;
    var url = Retro.app.shareURL(currentCode);
    ui.copyText(url).then(function (ok) {
      ui.toast(ok ? 'Link da sala copiado! Mande para o time.' : 'Não consegui copiar. Copie o endereço da página.', ok ? 'success' : 'error');
    });
  }

  function leaveRoom() {
    var message = current && current.isOrganizer
      ? 'A sala continua aberta e você pode voltar pelo código. Sair agora?'
      : 'Você pode voltar a qualquer momento usando o código da sala.';
    ui.confirmDialog({
      title: 'Sair da sala?',
      message: message,
      confirmLabel: 'Sair',
      danger: true
    }).then(function (ok) {
      if (ok) Retro.app.goHome();
    });
  }

  function togglePeople() {
    if (refs.peoplePopover.hidden) {
      renderPeople();
      refs.peoplePopover.hidden = false;
      refs.peopleBtn.setAttribute('aria-expanded', 'true');
    } else {
      closePeople();
    }
  }

  function closePeople() {
    if (!refs.peoplePopover) return;
    refs.peoplePopover.hidden = true;
    if (refs.peopleBtn) refs.peopleBtn.setAttribute('aria-expanded', 'false');
  }

  /* ------------------------------------------------------------------ *
   * estado
   * ------------------------------------------------------------------ */

  function applyState(next, options) {
    options = options || {};
    if (!next || next.code !== currentCode) return;
    if (!next.isMember) {
      Retro.app.goHome({ error: 'Você não está mais nesta sala.' });
      return;
    }
    if (current && next.version < current.version) return;
    if (current && next.version === current.version && !options.force) {
      current = next;
      return;
    }

    var previous = current;
    current = next;
    currentUserId = next.viewerId;

    if (previous && previous.dynamics.round !== next.dynamics.round) {
      drafts.question = '';
      drafts.answer = '';
      answerDirty = false;
      questionDirty = false;
      selectedTarget = null;
      prevScores = {};
      seenShuffle = 0;
    }

    if (!previous) {
      drafts.question = next.dynamics.question || '';
      drafts.answer = next.dynamics.myAnswer ? next.dynamics.myAnswer.text : '';
      answerDirty = false;
      questionDirty = false;
    } else {
      var prevPhase = previous.dynamics.phase;
      var phase = next.dynamics.phase;

      if (prevPhase !== phase && phase === 'collecting') {
        drafts.answer = next.dynamics.myAnswer ? next.dynamics.myAnswer.text : '';
        answerDirty = false;
      }
      if (prevPhase !== phase && phase === 'voting') {
        selectedTarget = null;
        answerDirty = false;
      }
      if (phase === 'collecting' && next.dynamics.myAnswer && !answerDirty) {
        drafts.answer = next.dynamics.myAnswer.text;
      }
      if (!questionDirty && next.dynamics.question && next.dynamics.question !== drafts.question) {
        var questionInput = document.getElementById('question-input');
        if (!questionInput || document.activeElement !== questionInput) {
          drafts.question = next.dynamics.question;
        }
      }
      if (!next.dynamics.question && phase === 'setup' && previous.dynamics.phase !== 'setup' && !questionDirty) {
        drafts.question = '';
      }
    }

    lastPhase = next.dynamics.phase;
    lastRound = next.dynamics.round;

    renderAll();
  }

  function resetRoomUi(code) {
    refs.roomCode.textContent = code;
    refs.footerCode.textContent = code;
    refs.peopleBtn.setAttribute('aria-label', 'Pessoas na sala (0)');
    refs.roomDemoChip.hidden = !Retro.env.demo;
    refs.avatarStack.innerHTML = '';
    refs.peopleCount.textContent = '0';
    refs.peopleList.innerHTML = '';
    refs.popCount.textContent = '0';
    refs.phase.textContent = 'conectando';
    refs.phase.removeAttribute('data-phase');
    refs.extra.innerHTML = '';
    refs.dynamicsBody.innerHTML =
      '<div class="dyn-waiting"><span class="wait-emoji">✦</span><h3>Entrando na sala…</h3><p>Conectando com o time.</p></div>';
    Object.keys(refs.panels).forEach(function (key) {
      var panel = refs.panels[key];
      panel.count.textContent = '0';
      panel.action.innerHTML = '<span class="state-pill">carregando</span>';
      panel.cards.innerHTML = '';
      panel.textarea.value = '';
    });
    setStatus('connecting');
    closePeople();
    refs.offlineBanner.hidden = false;
    refs.offlineText.textContent = 'Conectando à sala…';
  }

  function setStatus(nextStatus) {
    status = nextStatus;
    if (!refs.livePill) return;
    var online = status === 'online';
    refs.livePill.classList.toggle('is-offline', !online);
    refs.liveText.textContent = online ? 'ao vivo' : (status === 'connecting' ? 'conectando' : 'reconectando');
    refs.offlineBanner.hidden = online;
    refs.offlineText.textContent = status === 'connecting'
      ? 'Conectando à sala…'
      : 'Conexão caiu. Tentando reconectar…';
  }

  /* ------------------------------------------------------------------ *
   * render
   * ------------------------------------------------------------------ */

  function renderAll() {
    if (!current) return;
    renderHeader();
    renderColumn('acertos');
    renderColumn('melhorias');
    renderDynamics();
    renderPeople();
  }

  function renderHeader() {
    refs.roomCode.textContent = current.code;
    refs.footerCode.textContent = current.code;
    refs.roomDemoChip.hidden = !Retro.env.demo;

    var users = current.users.slice().sort(function (a, b) {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.isOrganizer !== b.isOrganizer) return a.isOrganizer ? -1 : 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });

    var shown = users.slice(0, 5);
    refs.avatarStack.innerHTML = shown.map(function (user) {
      return ui.avatarHTML(user.avatar, {
        size: 22,
        ring: user.connected ? user.color : null,
        className: user.connected ? '' : 'is-offline',
        title: user.name
      });
    }).join('') + (users.length > 5 ? '<span class="avatar-more">+' + (users.length - 5) + '</span>' : '');

    refs.peopleCount.textContent = String(users.length);
    refs.peopleBtn.setAttribute('aria-label', 'Pessoas na sala (' + users.length + ')');
    refs.popCount.textContent = String(users.length);
  }

  function renderPeople() {
    if (!current) return;
    var phase = current.dynamics.phase;
    var canKick = current.isOrganizer && phase !== 'voting' && phase !== 'closed';
    var users = current.users.slice().sort(function (a, b) {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.isOrganizer !== b.isOrganizer) return a.isOrganizer ? -1 : 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });

    refs.peopleList.innerHTML = users.map(function (user) {
      var badges = '';
      if (user.id === currentUserId) badges += '<span class="mini-badge">você</span>';
      if (user.isOrganizer) badges += '<span class="mini-badge org">org</span>';
      if (!user.connected) badges += '<span class="mini-badge off">off</span>';
      var kick = canKick && user.id !== currentUserId
        ? '<button class="kick-btn" type="button" data-kick="' + esc(user.id) + '" title="Remover ' + esc(user.name) + ' da sala">✕</button>'
        : '';
      return '<li>' +
        ui.userAvatar(user, { size: 27, ring: user.connected ? user.color : false }) +
        '<span class="person-name">' + esc(user.name) + '</span>' +
        '<span class="person-badges">' + badges + '</span>' +
        kick +
        '</li>';
    }).join('');
  }

  function renderColumn(key) {
    if (!current) return;
    var column = current[key];
    var panel = refs.panels[key];
    if (!column || !panel) return;

    panel.count.textContent = String(column.cards.length);

    if (column.revealed) {
      panel.action.innerHTML = '<span class="state-pill revealed">✓ revelado</span>';
    } else if (current.isOrganizer) {
      panel.action.innerHTML = '<button class="btn btn-reveal" type="button" data-action="reveal-column" ' +
        (column.cards.length ? '' : 'disabled title="Adicione pelo menos um card primeiro"') +
        '>👁 Revelar</button>';
    } else {
      panel.action.innerHTML = '<span class="state-pill">🔒 oculto</span>';
    }

    if (!column.cards.length) {
      panel.cards.innerHTML = '<div class="cards-empty"><span>✨</span>' +
        (key === 'acertos' ? 'Nenhum acerto ainda.<br>Comece pelo primeiro.' : 'Nenhuma melhoria ainda.<br>O que pode ficar melhor?') +
        '</div>';
      return;
    }

    panel.cards.innerHTML = column.cards.map(function (card) {
      return cardHTML(key, card, column);
    }).join('');
  }

  function cardHTML(key, card, column) {
    var heat = Math.min(card.likeCount, 8);
    var heatClass = heat === 0 ? '' : (heat <= 2 ? ' heat-1' : heat <= 4 ? ' heat-2' : heat <= 6 ? ' heat-3' : ' heat-4');
    var isLocked = !card.canRead;
    var plan = card.actionPlan || { text: '', assignees: [] };

    var actionsHTML = '';
    if (card.canRemove) {
      actionsHTML += '<button class="icon-btn danger" type="button" data-remove-card="' + esc(card.id) + '" title="Remover card">✕</button>';
    }
    if (column.revealed) {
      actionsHTML += '<button class="like-btn' + (card.likedByMe ? ' is-liked' : '') + '" type="button" ' +
        'data-like="' + esc(card.id) + '" ' +
        'style="--heat:' + (heat / 8).toFixed(2) + '" ' +
        'aria-pressed="' + (card.likedByMe ? 'true' : 'false') + '" ' +
        'title="' + (card.likedByMe ? 'Remover joinha' : 'Dar joinha') + '">' +
        '<span class="like-ico" aria-hidden="true">👍</span><span class="like-count">' + card.likeCount + '</span>' +
        '</button>';
    }

    var planHTML = '';
    if (key === 'melhorias') {
      if (plan.text || plan.assignees.length) {
        planHTML = '<div class="action-plan">' +
          '<div class="action-plan-head">🎯 plano de ação' +
          (card.canEditPlan ? '<button class="icon-btn" type="button" data-plan="' + esc(card.id) + '" title="Editar plano de ação">✎</button>' : '') +
          '</div>' +
          (plan.text ? '<p class="action-plan-text">' + esc(plan.text) + '</p>' : '') +
          (plan.assignees.length
            ? '<div class="plan-assignees">' + plan.assignees.map(function (userId) {
              var user = findUser(userId);
              return user ? ui.userAvatar(user, { size: 19, ring: false }) : '';
            }).join('') + '</div>'
            : '') +
          '</div>';
      } else if (card.canEditPlan) {
        planHTML = '<div class="plan-empty"><span>Sem plano de ação ainda</span>' +
          '<button class="link-btn" type="button" data-plan="' + esc(card.id) + '">Definir plano</button></div>';
      }
    }

    return '<article class="card' + (isLocked ? ' is-locked' : '') + heatClass + '" data-card-id="' + esc(card.id) + '" style="--heat:' + (heat / 8).toFixed(2) + '">' +
      '<p class="card-text">' + esc(card.text) + '</p>' +
      (isLocked ? '<div class="card-lock">🔒 <b>conteúdo oculto</b> · o organizador revela para todos</div>' : '') +
      (actionsHTML
        ? '<div class="card-foot"><div class="card-actions">' + actionsHTML + '</div></div>'
        : '') +
      planHTML +
      '</article>';
  }

  /* ------------------------------------------------------------------ *
   * dinâmica — render
   * ------------------------------------------------------------------ */

  function renderDynamics() {
    if (!current) return;
    var d = current.dynamics;
    var focus = ui.captureFocus(refs.dynamicsBody);

    refs.phase.textContent = PHASE_LABELS[d.phase] || d.phase;
    refs.phase.setAttribute('data-phase', d.phase);

    if (current.isOrganizer && d.questionAvailable && d.phase !== 'setup') {
      refs.extra.innerHTML = '<button class="eye-btn' + (d.questionVisible ? '' : ' is-hidden') + '" type="button" ' +
        'data-action="toggle-question" title="' + (d.questionVisible ? 'Ocultar pergunta' : 'Mostrar pergunta') + '">' +
        (d.questionVisible ? '👁' : '🙈') +
        '</button>';
    } else {
      refs.extra.innerHTML = '';
    }

    var body = stepsHTML(d.phase);
    if (d.phase === 'setup') body += setupHTML(d);
    else if (d.phase === 'collecting') body += collectingHTML(d);
    else if (d.phase === 'voting') body += votingHTML(d);
    else body += revealHTML(d);

    refs.dynamicsBody.innerHTML = body;
    ui.restoreFocus(refs.dynamicsBody, focus);

    // micro animação nos pontos que acabaram de subir
    if (d.phase === 'closed' || d.phase === 'done') {
      var bumps = [];
      (d.scores || []).forEach(function (score) {
        if (prevScores[score.userId] != null && score.points > prevScores[score.userId]) {
          bumps.push(score.userId);
        }
        prevScores[score.userId] = score.points;
      });
      if (bumps.length) {
        $$('.score-row', refs.dynamicsBody).forEach(function (row) {
          if (bumps.indexOf(row.getAttribute('data-user-id')) !== -1) {
            row.classList.add('score-bump');
          }
        });
      }
    } else {
      prevScores = {};
    }
  }

  function stepsHTML(phase) {
    var currentStep = { setup: 1, collecting: 2, voting: 3, closed: 4, done: 4 }[phase] || 1;
    var labels = ['Pergunta', 'Respostas', 'Palpites', 'Placar'];
    return '<ol class="dyn-steps">' + labels.map(function (label, index) {
      var step = index + 1;
      var cls = step < currentStep ? 'is-done' : (step === currentStep ? 'is-current' : '');
      return '<li class="dyn-step ' + cls + '"><i>' + step + '</i><span>' + label + '</span></li>';
    }).join('') + '</ol>';
  }

  function waitingHTML(emoji, title, text, showPeople) {
    var people = '';
    if (showPeople && current) {
      people = '<div class="wait-people">' + current.users.slice(0, 8).map(function (user) {
        return '<span class="wait-person">' + ui.userAvatar(user, { size: 22, ring: false }) + esc(user.name) + '</span>';
      }).join('') + '</div>';
    }
    return '<div class="dyn-waiting">' +
      '<span class="wait-emoji">' + emoji + '</span>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(text) + '</p>' +
      people +
      '</div>';
  }

  function setupHTML(d) {
    if (!current.isOrganizer) {
      return waitingHTML('🎲', 'O organizador está preparando a dinâmica', 'Em breve você vai responder a uma pergunta e tentar adivinhar quem escreveu cada resposta.', true);
    }
    var question = drafts.question || '';
    var disabled = !question.trim();
    return '<div class="dyn-setup">' +
      '<div class="dyn-copy">' +
        '<h3>Faça a pergunta da rodada</h3>' +
        '<p>Algo leve, específico e que renda boas histórias. Todos respondem escondido — depois o time tenta adivinhar quem escreveu o quê.</p>' +
        '<div class="dyn-tips"><span class="dyn-tip">leve</span><span class="dyn-tip">específica</span><span class="dyn-tip">sem julgamentos</span></div>' +
      '</div>' +
      '<div class="dyn-question-editor">' +
        '<textarea id="question-input" maxlength="300" placeholder="Ex.: qual foi a coisa mais inusitada que aconteceu nesta sprint?">' + esc(question) + '</textarea>' +
        '<div class="dyn-editor-foot">' +
          '<span class="char-count" id="question-count">' + question.length + '/300</span>' +
          '<div class="dyn-actions">' +
            '<button class="btn btn-secondary btn-small" type="button" data-action="save-question" ' + (disabled ? 'disabled' : '') + '>Salvar pergunta</button>' +
            '<button class="btn btn-primary btn-small" type="button" data-action="start-collecting" id="start-collecting-btn" ' + (disabled ? 'disabled' : '') + '>Liberar respostas →</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>' +
      '<p class="micro">Você pode ocultar a pergunta quando quiser. As respostas ficam anônimas até o final.</p>';
  }

  function questionBlockHTML(d) {
    if (d.question) {
      var hiddenNote = !d.questionVisible ? ' · oculta para o time' : '';
      return '<div class="question-banner">' +
        '<span class="question-label">A pergunta' + hiddenNote + '</span>' +
        '<h3>' + esc(d.question) + '</h3>' +
        '</div>';
    }
    if (d.questionHiddenForMe) {
      return '<div class="question-hidden">🔒 O organizador ocultou a pergunta.</div>';
    }
    return '';
  }

  function collectingHTML(d) {
    var html = questionBlockHTML(d);

    var answerBox = '';
    if (d.canAnswer) {
      var mine = !!d.myAnswer;
      answerBox = '<div class="answer-card">' +
        '<h4>✍️ Sua resposta ' + (mine ? '<span class="answer-status" style="margin-left:auto">✓ enviada</span>' : '') + '</h4>' +
        '<textarea id="answer-input" maxlength="500" placeholder="Pode escrever sem medo: só o texto será revelado depois, sem o seu nome.">' + esc(drafts.answer) + '</textarea>' +
        '<div class="answer-foot">' +
          '<span class="char-count" id="answer-count">' + drafts.answer.length + '/500</span>' +
          '<button class="btn btn-primary btn-small" type="button" data-action="submit-answer" id="submit-answer-btn" ' + (drafts.answer.trim() ? '' : 'disabled') + '>' + (mine ? 'Atualizar resposta' : 'Enviar resposta') + '</button>' +
        '</div>' +
      '</div>';
    } else if (d.questionHiddenForMe) {
      answerBox = '<div class="answer-locked"><span class="lock-ico">🙈</span>A pergunta está oculta pelo organizador.<br>Assim que ela voltar, você poderá responder.</div>';
    } else if (d.isSpectator) {
      answerBox = '<div class="answer-locked"><span class="lock-ico">👀</span>Você entrou depois do início desta rodada, então vai acompanhar de fora. Na próxima, participa!</div>';
    } else {
      answerBox = '<div class="answer-locked"><span class="lock-ico">⏳</span>Aguarde o organizador abrir a rodada.</div>';
    }

    var participants = (d.participants || []).filter(function (person) { return person.isParticipant; });
    var answeredCount = participants.filter(function (person) { return person.hasAnswered; }).length;
    var connectedCount = d.answerProgress.connected || 0;
    var total = d.answerProgress.totalParticipants || participants.length || 1;
    var progress = Math.round((answeredCount / total) * 100);

    var roster = '<div class="roster">' +
      '<div class="roster-head"><strong>Quem já respondeu</strong><span class="roster-count">' + answeredCount + '/' + total + '</span></div>' +
      '<ul class="roster-list">' +
      participants.map(function (person) {
        return '<li class="roster-item' + (person.hasAnswered ? ' is-answered' : '') + '" style="--user-color:' + esc(person.color) + '">' +
          ui.avatarHTML(person.avatar, { size: 28, title: person.name }) +
          '<span class="roster-name">' + esc(person.name) + (person.id === currentUserId ? ' (você)' : '') + '</span>' +
          (!person.connected ? '<span class="roster-off">offline</span>' : '') +
          '<span class="roster-check">✓</span>' +
          '</li>';
      }).join('') +
      '</ul>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + progress + '%"></div></div>' +
      '<p class="score-note">' + connectedCount + ' ' + ui.plural(connectedCount, 'pessoa conectada', 'pessoas conectadas') + ' agora.</p>' +
      '</div>';

    html += '<div class="collecting-grid">' + answerBox + roster + '</div>';

    var connectedPending = participants.filter(function (person) {
      return person.connected && !person.hasAnswered;
    });

    var footer;
    if (current.isOrganizer) {
      if (d.canShuffle) {
        footer = '<p>Todo mundo que está aqui já respondeu. 🎉</p>' +
          '<button class="btn btn-primary" type="button" data-action="shuffle">Embaralhar e revelar respostas →</button>';
      } else if (d.answerProgress.totalAnswers < 2 && connectedPending.length === 0) {
        footer = '<p class="helper">São necessárias pelo menos 2 respostas para a dinâmica funcionar.</p>' +
          '<button class="btn btn-primary" type="button" disabled>Embaralhar e revelar respostas →</button>';
      } else {
        var names = connectedPending.map(function (person) { return person.name; });
        footer = '<p class="helper">Aguardando ' + (names.length ? esc(names.join(', ')) : 'mais respostas') + '…</p>' +
          '<button class="btn btn-primary" type="button" disabled>Embaralhar e revelar respostas →</button>';
      }
    } else {
      footer = '<p>Assim que todos responderem, o organizador libera as respostas embaralhadas.</p>' +
        '<span class="helper">Sua resposta fica anônima até o final.</span>';
    }

    html += '<div class="dyn-footer">' + footer + '</div>';
    return html;
  }

  function assignmentChipsHTML(answerId, options) {
    if (!current) return '';
    options = options || {};
    var canEdit = !!options.canEdit;
    var revealedAuthorId = options.revealedAuthorId || null;
    var d = current.dynamics;
    var assignments = d.assignments || {};
    var rows = [];

    current.users.forEach(function (voter) {
      var map = assignments[voter.id];
      if (!map) return;
      Object.keys(map).forEach(function (aid) {
        if (aid !== answerId) return;
        var target = findUser(map[aid]);
        if (!target) return;
        rows.push({ voter: voter, target: target });
      });
    });

    rows.sort(function (a, b) {
      if (a.voter.id === currentUserId) return -1;
      if (b.voter.id === currentUserId) return 1;
      return (a.voter.joinedAt || 0) - (b.voter.joinedAt || 0);
    });

    return rows.map(function (row) {
      var mine = row.voter.id === currentUserId;
      var editable = mine && canEdit;
      var extra = '';
      if (revealedAuthorId) {
        extra = row.target.id === revealedAuthorId ? ' correct' : ' wrong';
      }
      var title = row.voter.name + ' acha que foi ' + row.target.name +
        (editable ? ' · clique para remover' : '');
      return '<button class="assignment' + (editable ? ' mine' : '') + extra + '" type="button" ' +
        'data-voter="' + esc(row.voter.id) + '" data-target="' + esc(row.target.id) + '" data-answer="' + esc(answerId) + '" ' +
        'title="' + esc(title) + '" ' + (editable ? '' : 'disabled') + '>' +
        ui.avatarHTML(row.target.avatar, { size: 25 }) +
        '<span class="voter-badge">' + ui.avatarHTML(row.voter.avatar, { size: 15 }) + '</span>' +
        (editable ? '<span class="remove-x" aria-hidden="true">×</span>' : '') +
        '</button>';
    }).join('');
  }

  function votingHTML(d) {
    var html = questionBlockHTML(d);
    var myAssigned = d.myVoting.assigned;
    var myTotal = d.myVoting.total;

    html += '<div class="voting-intro">' +
      '<div>' +
        '<h3>Quem escreveu cada resposta?</h3>' +
        '<p>Arraste o avatar de uma pessoa para a resposta que você acha que ela escreveu. No celular, toque na pessoa e depois na resposta. Cada palpite aparece no card para todo mundo.</p>' +
      '</div>' +
      (d.canVote
        ? '<span class="my-progress">seus palpites <strong>' + myAssigned + '/' + myTotal + '</strong></span>'
        : '<span class="my-progress">observando a rodada</span>') +
      '</div>';

    if (d.isSpectator) {
      html += '<div class="question-hidden">👀 Você entrou depois do início desta rodada. Pode acompanhar os palpites, mas não participa desta vez.</div>';
    }

    html += '<div class="vote-grid">' + (d.answers || []).map(function (answer, index) {
      var chips = assignmentChipsHTML(answer.id, { canEdit: d.canVote });
      var hint = chips ? '' : (d.canVote ? 'Arraste uma pessoa aqui' : 'Nenhum palpite ainda');
      return '<article class="vote-card" data-answer-id="' + esc(answer.id) + '">' +
        '<span class="vote-index">RESPOSTA ' + String(index + 1).padStart(2, '0') + '</span>' +
        '<p class="answer-text">' + esc(answer.text) + '</p>' +
        '<div class="dropzone' + (chips ? ' has-chips' : '') + '" data-dropzone="' + esc(answer.id) + '">' +
          (chips || '<span class="drop-hint">' + hint + '</span>') +
        '</div>' +
        '</article>';
    }).join('') + '</div>';

    if (d.canVote) {
      var placed = Object.keys(d.myAssignments || {}).map(function (key) { return d.myAssignments[key]; });
      var targets = (d.authorIds || []).filter(function (id) { return id !== currentUserId; }).map(findUser).filter(Boolean);
      html += '<div class="people-tray">' +
        '<span class="tray-label">Pessoas</span>' +
        '<div class="tray-people">' +
          targets.map(function (user) {
            var isPlaced = placed.indexOf(user.id) !== -1;
            return '<button class="tray-person' + (isPlaced ? ' is-placed' : '') + '" type="button" draggable="true" ' +
              'data-drag-user="' + esc(user.id) + '" aria-pressed="false" title="' + esc(user.name) + '">' +
              ui.avatarHTML(user.avatar, { size: 25 }) +
              esc(user.name) +
              (isPlaced ? '<span class="placed-check" aria-hidden="true">✓</span>' : '') +
              '</button>';
          }).join('') +
        '</div>' +
        '<span class="tray-hint">arraste ou toque</span>' +
        '</div>';
    }

    var pending = d.voting.pending || [];
    var voteStatus = '<div class="vote-status"><strong>' + d.voting.completeCount + ' de ' + d.voting.connected + '</strong> ' +
      ui.plural(d.voting.connected, 'pessoa já votou', 'pessoas já votaram') +
      (pending.length ? '<br><span class="warn">Faltam: ' + esc(pending.map(function (item) { return item.name; }).join(', ')) + '</span>' : '') +
      '</div>';

    var afterVote;
    if (current.isOrganizer) {
      afterVote = '<button class="btn btn-secondary" type="button" data-action="end-voting" ' + (d.canEndVoting ? '' : 'disabled title="Todos precisam terminar os palpites"') + '>Encerrar votação 🔒</button>';
    } else {
      afterVote = '<span class="helper">O organizador encerra quando todos terminarem.</span>';
    }

    html += '<div class="voting-footer">' + voteStatus + afterVote + '</div>';
    html += '<div class="vote-legend"><span class="mini-avatar-dot"></span> a bolinha pequena em cada avatar mostra quem fez aquele palpite.</div>';
    return html;
  }

  function revealHTML(d) {
    var html = '';
    if (d.phase === 'done') html += podiumHTML(d);
    html += questionBlockHTML(d);

    var revealAction;
    if (current.isOrganizer && d.phase === 'closed') {
      revealAction = '<button class="btn btn-primary" type="button" data-action="reveal-next" ' + (d.canRevealNext ? '' : 'disabled') + '>Revelar próxima resposta →</button>';
    } else if (current.isOrganizer && d.phase === 'done') {
      revealAction = '<button class="btn btn-secondary" type="button" data-action="reset-dynamics">Nova rodada ↺</button>';
    } else if (d.phase === 'closed') {
      revealAction = '<span class="helper">Aguardando o organizador revelar os autores…</span>';
    }

    html += '<div class="reveal-head">' +
      '<div><h3>' + (d.phase === 'done' ? 'Rodada revelada' : 'Hora da verdade') + '</h3>' +
      '<p>' + (d.phase === 'done'
        ? 'Todos os autores estão na mesa. Confira o placar final.'
        : 'O organizador revela os autores um por um. Cada acerto vale 1 ponto.') + '</p></div>' +
      '<div class="reveal-actions">' +
        '<span class="reveal-counter">' + d.revealedCount + '/' + d.totalAnswers + ' reveladas</span>' +
        revealAction +
      '</div>' +
      '</div>';

    var answers = d.answers || [];
    var answerCards = answers.map(function (answer, index) {
      var chips = assignmentChipsHTML(answer.id, {
        canEdit: false,
        revealedAuthorId: answer.revealed && answer.author ? answer.author.id : null
      });
      var authorBlock;
      if (answer.revealed && answer.author) {
        authorBlock = '<div class="author-row">' +
          ui.userAvatar(answer.author, { size: 27 }) +
          '<div><span class="author-label">autor' + (answer.author.id === currentUserId ? ' · você' : '') + '</span>' +
          '<span class="author-name">' + esc(answer.author.id === currentUserId ? 'Você' : answer.author.name) + '</span></div>' +
          '</div>';
      } else {
        authorBlock = '<div class="author-mystery"><span class="mystery-avatar">?</span> autor ainda oculto</div>';
      }

      var correctBlock = '';
      if (answer.revealed) {
        var correct = (answer.correctVoterIds || []).map(findUser).filter(Boolean);
        correctBlock = '<div class="correct-row">' +
          '<span class="correct-label">acertaram</span>' +
          '<div class="correct-avatars">' +
          (correct.length
            ? correct.map(function (user) {
              return ui.userAvatar(user, { size: 21, title: user.name });
            }).join('')
            : '<span class="none">ninguém ainda</span>') +
          (correct.length ? '<span class="point-badge">+1 cada</span>' : '') +
          '</div>' +
          '</div>';
      }

      return '<article class="reveal-card' + (answer.revealed ? ' is-revealed' : '') + '" data-answer-id="' + esc(answer.id) + '">' +
        '<span class="vote-index">RESPOSTA ' + String(index + 1).padStart(2, '0') + '</span>' +
        '<p class="answer-text">' + esc(answer.text) + '</p>' +
        '<div class="dropzone has-chips">' + (chips || '<span class="drop-hint">ninguém apostou aqui</span>') + '</div>' +
        authorBlock +
        correctBlock +
        '</article>';
    }).join('');

    html += '<div class="reveal-layout">' +
      '<div class="reveal-grid">' + answerCards + '</div>' +
      scoreboardHTML(d) +
      '</div>';
    return html;
  }

  function scoreboardHTML(d) {
    var scores = d.scores || [];
    var rows = scores.map(function (score, index) {
      return '<li class="score-row' + (score.userId === currentUserId ? ' is-me' : '') + '" data-user-id="' + esc(score.userId) + '">' +
        '<span class="rank">' + (index + 1) + '</span>' +
        ui.avatarHTML(score.avatar, { size: 23, title: score.name }) +
        '<span class="score-name">' + esc(displayName(score)) + '</span>' +
        '<span class="score-points' + (score.points ? '' : ' zero') + '">' + score.points + '</span>' +
        '</li>';
    }).join('');

    return '<aside class="scoreboard">' +
      '<h3>Placar</h3>' +
      '<ol class="score-list">' + (rows || '<li class="score-row"><span class="score-name">Aguardando revelações…</span></li>') + '</ol>' +
      '<p class="score-note">1 ponto por autor que cada pessoa acertou · ' + d.revealedCount + ' de ' + d.totalAnswers + ' respostas reveladas.</p>' +
      '</aside>';
  }

  function podiumHTML(d) {
    var scores = d.scores || [];
    if (!scores.length) return '';
    var top = scores[0];
    var winners = scores.filter(function (score) { return score.points === top.points && score.points > 0; });
    var title;
    if (top.points === 0) {
      title = 'Ninguém acertou ninguém. O mistério permanece. 👀';
    } else {
      var names = winners.map(function (winner) {
        return displayName(winner);
      });
      title = names.join(' e ') + (winners.length > 1 ? ' dividem' : ' leva') +
        ' a rodada com ' + top.points + ' ' + ui.plural(top.points, 'ponto', 'pontos') + '!';
    }
    return '<div class="podium">' +
      '<span class="podium-trophy" aria-hidden="true">🏆</span>' +
      '<div class="podium-copy">' +
        '<span class="podium-eyebrow">fim da rodada ' + d.round + '</span>' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>Que tal mais uma? O organizador pode começar uma nova dinâmica.</p>' +
      '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * ações
   * ------------------------------------------------------------------ */

  async function runAction(type, payload, options) {
    options = options || {};
    if (!currentCode || !currentUserId) return false;
    if (options.lockKey) {
      if (actionLocks[options.lockKey]) return false;
      actionLocks[options.lockKey] = true;
    }
    var codeAtStart = currentCode;
    try {
      var result = await Retro.api.action(codeAtStart, currentUserId, type, payload || {});
      if (codeAtStart !== currentCode) return false;
      if (result && result.state) applyState(result.state);
      return true;
    } catch (error) {
      ui.toast(error && error.message ? error.message : 'Não consegui completar a ação.', 'error');
      return false;
    } finally {
      if (options.lockKey) actionLocks[options.lockKey] = false;
    }
  }

  function submitCard(column) {
    var panel = refs.panels[column];
    if (!panel || panel.form.dataset.busy) return;
    var text = panel.textarea.value.trim();
    if (!text) {
      ui.toast('Escreva alguma coisa antes de adicionar.', 'error');
      panel.textarea.focus();
      return;
    }
    panel.form.dataset.busy = '1';
    var button = panel.form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    runAction('card:add', { column: column, text: text }, { lockKey: 'add-' + column }).then(function (ok) {
      if (ok) {
        panel.textarea.value = '';
        panel.textarea.focus({ preventScroll: true });
      }
      panel.form.dataset.busy = '';
      if (button) button.disabled = false;
    });
  }

  function saveQuestion(silent) {
    var text = drafts.question.trim();
    if (!text) {
      ui.toast('Escreva a pergunta da dinâmica.', 'error');
      var input = document.getElementById('question-input');
      if (input) input.focus();
      return Promise.resolve(false);
    }
    return runAction('dynamics:setQuestion', { text: text }, { lockKey: 'question' }).then(function (ok) {
      if (ok) {
        drafts.question = text;
        questionDirty = false;
        if (!silent) ui.toast('Pergunta salva. Agora é só liberar as respostas.', 'success');
      }
      return ok;
    });
  }

  async function startCollecting() {
    if (!current || current.dynamics.phase !== 'setup') return;
    var text = drafts.question.trim();
    if (!text) {
      ui.toast('Escreva a pergunta primeiro.', 'error');
      return;
    }
    if (actionLocks.start) return;
    if (text !== (current.dynamics.question || '')) {
      var saved = await saveQuestion(true);
      if (!saved) return;
    }
    await runAction('dynamics:startCollecting', {}, { lockKey: 'start' });
  }

  function submitAnswer() {
    if (!current || !current.dynamics.canAnswer) return;
    var text = drafts.answer.trim();
    if (!text) {
      ui.toast('Escreva a sua resposta.', 'error');
      var input = document.getElementById('answer-input');
      if (input) input.focus();
      return;
    }
    runAction('dynamics:answer', { text: text }, { lockKey: 'answer' }).then(function (ok) {
      if (ok) {
        drafts.answer = text;
        answerDirty = false;
      }
    });
  }

  function toggleQuestion() {
    if (!current || !current.isOrganizer) return;
    runAction('dynamics:toggleQuestion', { visible: !current.dynamics.questionVisible }, { lockKey: 'question-visibility' });
  }

  function shuffleAnswers() {
    if (!current || !current.dynamics.canShuffle) {
      ui.toast('Ainda faltam respostas para liberar a dinâmica.', 'error');
      return;
    }
    ui.confirmDialog({
      title: 'Embaralhar e revelar?',
      message: 'As respostas perdem a ordem e ninguém poderá editá-las depois. A autoria só aparece no final, quando o organizador revelar.',
      confirmLabel: 'Embaralhar'
    }).then(function (ok) {
      if (!ok) return;
      runAction('dynamics:shuffle', {}, { lockKey: 'shuffle' });
    });
  }

  function endVoting() {
    if (!current) return;
    if (!current.dynamics.canEndVoting) {
      ui.toast('Ainda faltam palpites. Todos precisam terminar.', 'error');
      return;
    }
    ui.confirmDialog({
      title: 'Encerrar a votação?',
      message: 'Os palpites serão bloqueados. Depois disso, o organizador revela os autores um por um.',
      confirmLabel: 'Encerrar votação'
    }).then(function (ok) {
      if (!ok) return;
      runAction('dynamics:endVoting', {}, { lockKey: 'end-voting' });
    });
  }

  function revealNext() {
    if (!current || !current.dynamics.canRevealNext) return;
    runAction('dynamics:revealNext', {}, { lockKey: 'reveal-next' });
  }

  function resetDynamics() {
    if (!current || !current.isOrganizer) return;
    ui.confirmDialog({
      title: 'Começar uma nova rodada?',
      message: 'As respostas, os palpites e o placar desta rodada serão apagados. Não dá para desfazer.',
      confirmLabel: 'Nova rodada',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      runAction('dynamics:reset', {}, { lockKey: 'reset' }).then(function (done) {
        if (done) {
          drafts.answer = '';
          drafts.question = '';
          answerDirty = false;
          questionDirty = false;
          selectedTarget = null;
          prevScores = {};
          ui.toast('Nova rodada pronta!', 'success');
          var input = document.getElementById('question-input');
          if (input) input.focus();
        }
      });
    });
  }

  function assignTarget(answerId, targetId) {
    if (!current || !current.dynamics.canVote) return;
    selectedTarget = null;
    updateTraySelection();
    runAction('dynamics:assign', { answerId: answerId, targetUserId: targetId });
  }

  function unassignTarget(targetId) {
    if (!current || !current.dynamics.canVote) return;
    runAction('dynamics:unassign', { targetUserId: targetId });
  }

  function updateTraySelection() {
    $$('[data-drag-user]', refs.dynamicsBody).forEach(function (el) {
      var active = el.getAttribute('data-drag-user') === selectedTarget;
      el.classList.toggle('is-selected', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------------ *
   * eventos de interface
   * ------------------------------------------------------------------ */

  function handleBoardClick(event) {
    var reveal = event.target.closest('[data-action="reveal-column"]');
    if (reveal) {
      var panel = reveal.closest('[data-panel]');
      var column = panel ? panel.getAttribute('data-panel') : '';
      if (!column || column === 'dynamics') return;
      ui.confirmDialog({
        title: 'Revelar ' + COLUMN_LABELS[column] + '?',
        message: 'Todo o time vai ver os conteúdos e poderá dar joinhas. Não dá para esconder de novo.',
        confirmLabel: 'Revelar'
      }).then(function (ok) {
        if (!ok) return;
        runAction('column:reveal', { column: column }, { lockKey: 'reveal-' + column });
      });
      return;
    }

    var like = event.target.closest('[data-like]');
    if (like) {
      var cardId = like.getAttribute('data-like');
      var cardPanel = like.closest('[data-panel]');
      var likeColumn = cardPanel ? cardPanel.getAttribute('data-panel') : '';
      if (!likeColumn || likeColumn === 'dynamics') return;
      var now = Date.now();
      if (likeLocks[cardId] && now - likeLocks[cardId] < 420) return;
      likeLocks[cardId] = now;
      runAction('card:like', { column: likeColumn, cardId: cardId });
      return;
    }

    var remove = event.target.closest('[data-remove-card]');
    if (remove) {
      var removeId = remove.getAttribute('data-remove-card');
      var removePanel = remove.closest('[data-panel]');
      var removeColumn = removePanel ? removePanel.getAttribute('data-panel') : '';
      if (!removeColumn || removeColumn === 'dynamics') return;
      ui.confirmDialog({
        title: 'Remover este card?',
        message: 'O card e os joinhas dele serão apagados para todo o time.',
        confirmLabel: 'Remover',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        runAction('card:remove', { column: removeColumn, cardId: removeId }, { lockKey: 'remove-' + removeId });
      });
      return;
    }

    var plan = event.target.closest('[data-plan]');
    if (plan) {
      openPlanModal(plan.getAttribute('data-plan'));
    }
  }

  function openPlanModal(cardId) {
    if (!current) return;
    var card = null;
    current.melhorias.cards.forEach(function (item) {
      if (item.id === cardId) card = item;
    });
    if (!card) return;
    if (!card.canEditPlan) {
      ui.toast('Só o organizador define o plano de ação, depois de revelar os cards.', 'error');
      return;
    }

    var selected = {};
    (card.actionPlan.assignees || []).forEach(function (id) { selected[id] = true; });

    var body = '<div class="plan-quote">' + esc(card.text) + '</div>' +
      '<label class="plan-field"><span class="field-label">O que vamos fazer?</span>' +
      '<textarea id="plan-text" maxlength="500" placeholder="Ex.: criar um checklist de deploy e revisar em dupla...">' + esc(card.actionPlan.text || '') + '</textarea></label>' +
      '<div class="field-label" style="margin-bottom:5px">Responsáveis</div>' +
      '<div class="assignee-grid">' +
      current.users.map(function (user) {
        return '<label class="assignee-option">' +
          '<input type="checkbox" value="' + esc(user.id) + '"' + (selected[user.id] ? ' checked' : '') + '>' +
          ui.avatarHTML(user.avatar, { size: 23 }) +
          '<span>' + esc(user.name) + (user.id === currentUserId ? ' (você)' : '') + '</span>' +
          '</label>';
      }).join('') +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" data-plan-cancel>Cancelar</button>' +
      '<button class="btn btn-primary" type="button" data-plan-save>Salvar plano</button>' +
      '</div>';

    var root = ui.openModal('Plano de ação', body);
    if (!root) return;

    var cancel = root.querySelector('[data-plan-cancel]');
    var save = root.querySelector('[data-plan-save]');
    if (cancel) cancel.addEventListener('click', function () { ui.closeModal(); });
    if (save) {
      save.addEventListener('click', function () {
        if (save.disabled) return;
        var text = root.querySelector('#plan-text').value.trim();
        var assignees = $$('.assignee-option input:checked', root).map(function (input) { return input.value; });
        save.disabled = true;
        save.textContent = 'Salvando…';
        runAction('card:actionPlan', { cardId: cardId, text: text, assignees: assignees }, { lockKey: 'plan-' + cardId }).then(function (ok) {
          if (ok) {
            ui.closeModal();
            ui.toast('Plano de ação salvo!', 'success');
          } else {
            save.disabled = false;
            save.textContent = 'Salvar plano';
          }
        });
      });
    }
  }

  function handlePeopleClick(event) {
    var kick = event.target.closest('[data-kick]');
    if (!kick) return;
    var userId = kick.getAttribute('data-kick');
    var user = findUser(userId);
    if (!user) return;
    ui.confirmDialog({
      title: 'Remover ' + user.name + '?',
      message: 'Os cards e respostas dessa pessoa serão apagados. Ela pode entrar de novo com o código da sala.',
      confirmLabel: 'Remover',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      runAction('room:kick', { userId: userId }, { lockKey: 'kick-' + userId });
    });
  }

  function handleDynamicsClick(event) {
    var action = event.target.closest('[data-action]');
    if (action) {
      var name = action.getAttribute('data-action');
      if (name === 'save-question') saveQuestion(false);
      else if (name === 'start-collecting') startCollecting();
      else if (name === 'toggle-question') toggleQuestion();
      else if (name === 'submit-answer') submitAnswer();
      else if (name === 'shuffle') shuffleAnswers();
      else if (name === 'end-voting') endVoting();
      else if (name === 'reveal-next') revealNext();
      else if (name === 'reset-dynamics') resetDynamics();
      return;
    }

    var chip = event.target.closest('.assignment.mine[data-target]');
    if (chip) {
      unassignTarget(chip.getAttribute('data-target'));
      return;
    }

    var person = event.target.closest('[data-drag-user]');
    if (person) {
      if (!current || !current.dynamics.canVote) return;
      var targetId = person.getAttribute('data-drag-user');
      selectedTarget = selectedTarget === targetId ? null : targetId;
      updateTraySelection();
      return;
    }

    var zone = event.target.closest('[data-dropzone]');
    if (zone && selectedTarget) {
      assignTarget(zone.getAttribute('data-dropzone'), selectedTarget);
    }
  }

  function handleDynamicsInput(event) {
    if (event.target.id === 'question-input') {
      drafts.question = event.target.value;
      questionDirty = true;
      refreshQuestionControls(event.target.value);
    } else if (event.target.id === 'answer-input') {
      drafts.answer = event.target.value;
      answerDirty = true;
      refreshAnswerControls(event.target.value);
    }
  }

  function handleDynamicsKeydown(event) {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
    if (event.target.id === 'answer-input') {
      event.preventDefault();
      submitAnswer();
    } else if (event.target.id === 'question-input') {
      event.preventDefault();
      saveQuestion(false);
    }
  }

  function refreshQuestionControls(value) {
    var count = document.getElementById('question-count');
    if (count) count.textContent = value.length + '/300';
    var save = document.querySelector('[data-action="save-question"]');
    if (save) save.disabled = !value.trim();
    var start = document.getElementById('start-collecting-btn');
    if (start) start.disabled = !value.trim();
  }

  function refreshAnswerControls(value) {
    var count = document.getElementById('answer-count');
    if (count) count.textContent = value.length + '/500';
    var submit = document.getElementById('submit-answer-btn');
    if (submit) submit.disabled = !value.trim();
  }

  /* ------------------------------- drag --------------------------------- */

  function handleDragStart(event) {
    var person = event.target.closest('[data-drag-user]');
    if (!person || !current || !current.dynamics.canVote) {
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'none';
      return;
    }
    var targetId = person.getAttribute('data-drag-user');
    selectedTarget = targetId;
    try {
      event.dataTransfer.setData('text/plain', targetId);
      event.dataTransfer.effectAllowed = 'move';
    } catch (error) { /* noop */ }
    updateTraySelection();
  }

  function handleDragOver(event) {
    if (!current || !current.dynamics.canVote) return;
    var zone = event.target.closest('[data-dropzone]');
    if (!zone) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    zone.classList.add('is-over');
  }

  function handleDragLeave(event) {
    var zone = event.target.closest('[data-dropzone]');
    if (!zone) return;
    if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
    zone.classList.remove('is-over');
  }

  function handleDrop(event) {
    var zone = event.target.closest('[data-dropzone]');
    if (!zone || !current || !current.dynamics.canVote) return;
    event.preventDefault();
    zone.classList.remove('is-over');
    var targetId = '';
    try { targetId = event.dataTransfer.getData('text/plain'); } catch (error) { targetId = ''; }
    if (!targetId) targetId = selectedTarget || '';
    if (!targetId) return;
    assignTarget(zone.getAttribute('data-dropzone'), targetId);
  }

  function handleDragEnd() {
    if (refs.dynamicsBody) {
      $$('.dropzone.is-over', refs.dynamicsBody).forEach(function (zone) {
        zone.classList.remove('is-over');
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * eventos vindos do servidor
   * ------------------------------------------------------------------ */

  function handleEvent(event) {
    if (!event || !current) return;
    if (event.kind === 'card-liked') {
      animateLike(event);
    } else if (event.kind === 'column-revealed') {
      flashColumn(event.column);
    } else if (event.kind === 'answer-revealed') {
      animateAnswerReveal(event.answerId);
    } else if (event.kind === 'shuffled') {
      playShuffle(event);
    } else if (event.kind === 'member-joined') {
      var joined = findUser(event.userId);
      if (joined && joined.id !== currentUserId) {
        ui.toast(joined.name + ' entrou na sala.', 'success');
      }
    } else if (event.kind === 'dynamics-reset') {
      // o toast de confirmação é local; para os outros, um aviso leve
      if (event.actorId !== currentUserId) ui.toast('Uma nova rodada começou.', 'success');
    }
  }

  function animateLike(event) {
    if (!event.liked) return;
    var card = findCardEl(event.cardId);
    if (!card) return;
    card.classList.remove('bump');
    void card.offsetWidth;
    card.classList.add('bump');
    var button = card.querySelector('.like-btn');
    if (button) {
      button.classList.remove('pop');
      void button.offsetWidth;
      button.classList.add('pop');
    }
    for (var i = 0; i < 4; i += 1) {
      var particle = document.createElement('span');
      particle.className = 'float-like-particle';
      particle.textContent = '👍';
      particle.style.setProperty('--dx', (Math.random() * 52 - 26).toFixed(0) + 'px');
      particle.style.left = (32 + Math.random() * 36).toFixed(0) + '%';
      particle.style.animationDelay = (i * 40) + 'ms';
      card.appendChild(particle);
      (function (node) {
        later(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 1200);
      }(particle));
    }
    later(function () { card.classList.remove('bump'); }, 600);
  }

  function flashColumn(column) {
    var panel = document.getElementById('panel-' + column);
    if (!panel) return;
    panel.classList.remove('is-revealing');
    void panel.offsetWidth;
    panel.classList.add('is-revealing');
    later(function () { panel.classList.remove('is-revealing'); }, 1400);
  }

  function animateAnswerReveal(answerId) {
    var card = findAnswerEl(answerId);
    if (!card) return;
    card.classList.add('just-revealed');
    if (!ui.prefersReducedMotion()) {
      try {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) { /* noop */ }
    }
    later(function () { card.classList.remove('just-revealed'); }, 900);
  }

  /* ----------------------------- shuffle -------------------------------- */

  function readSeenShuffle(code) {
    try {
      return Number(window.sessionStorage.getItem('retro-special:shuffle:' + code)) || 0;
    } catch (error) {
      return 0;
    }
  }

  function writeSeenShuffle(code, at) {
    try {
      window.sessionStorage.setItem('retro-special:shuffle:' + code, String(at));
    } catch (error) { /* noop */ }
  }

  function stopShuffle() {
    shuffleTimers.forEach(clearTimeout);
    shuffleTimers = [];
    if (shuffleGhostTimer) {
      clearInterval(shuffleGhostTimer);
      shuffleGhostTimer = null;
    }
    shufflePlaying = false;
    if (refs.shuffleOverlay) {
      refs.shuffleOverlay.hidden = true;
      refs.shuffleOverlay.classList.remove('is-leaving');
    }
    if (refs.shuffleStage) refs.shuffleStage.innerHTML = '';
    if (refs.shuffleGhosts) refs.shuffleGhosts.innerHTML = '';
    document.body.classList.remove('no-scroll');
  }

  function playShuffle(event) {
    if (!current || !refs.shuffleOverlay) return;
    var at = Number(event && event.at) || Date.now();
    if (at <= seenShuffle) return;
    seenShuffle = at;
    writeSeenShuffle(currentCode, at);
    if (shufflePlaying) return;

    if (ui.prefersReducedMotion()) {
      ui.toast('Respostas embaralhadas! Os palpites estão abertos.', 'success');
      return;
    }

    shufflePlaying = true;
    refs.shuffleStage.innerHTML = '';
    refs.shuffleGhosts.innerHTML = '';
    refs.shuffleOverlay.hidden = false;
    refs.shuffleOverlay.classList.remove('is-leaving');
    document.body.classList.add('no-scroll');

    var users = current.users.slice(0, 14);
    users.forEach(function (user, index) {
      var token = document.createElement('div');
      token.className = 'shuffle-token';
      token.innerHTML = ui.avatarHTML(user.avatar, { size: 50 });
      token.style.left = (14 + Math.random() * 72).toFixed(1) + '%';
      token.style.top = (18 + Math.random() * 64).toFixed(1) + '%';
      refs.shuffleStage.appendChild(token);

      var dx = (Math.random() * 2 - 1) * 240;
      var dy = (Math.random() * 2 - 1) * 120;
      var rotation = (Math.random() * 2 - 1) * 620;
      try {
        token.animate([
          { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 1, filter: 'blur(0px) grayscale(0)' },
          { transform: 'translate(calc(-50% + ' + (dx * 0.4).toFixed(0) + 'px), calc(-50% + ' + (dy * 0.4).toFixed(0) + 'px)) rotate(' + (rotation * 0.4).toFixed(0) + 'deg) scale(1.22)', opacity: 1, filter: 'blur(0px) grayscale(0)', offset: 0.45 },
          { transform: 'translate(calc(-50% + ' + dx.toFixed(0) + 'px), calc(-50% + ' + dy.toFixed(0) + 'px)) rotate(' + rotation.toFixed(0) + 'deg) scale(0.45)', opacity: 0, filter: 'blur(7px) grayscale(1)' }
        ], {
          duration: 2100 + Math.random() * 700,
          delay: index * 45,
          easing: 'cubic-bezier(.25,.7,.2,1)',
          fill: 'forwards'
        });
      } catch (error) {
        token.style.opacity = '0';
      }
    });

    var answers = (current.dynamics.answers || []).slice(0, 5);
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@%&*+=';
    function scramble(length) {
      var value = '';
      for (var i = 0; i < length; i += 1) {
        value += characters.charAt(Math.floor(Math.random() * characters.length));
      }
      return value;
    }

    var ghosts = answers.map(function (answer) {
      var ghost = document.createElement('div');
      ghost.className = 'shuffle-ghost';
      var text = String(answer.text).replace(/\s+/g, ' ').slice(0, 26);
      ghost.textContent = scramble(text.length);
      ghost.setAttribute('data-text', text);
      refs.shuffleGhosts.appendChild(ghost);
      return ghost;
    });

    if (ghosts.length) {
      shuffleGhostTimer = setInterval(function () {
        ghosts.forEach(function (ghost) {
          var text = ghost.getAttribute('data-text') || '';
          ghost.textContent = scramble(text.length);
        });
      }, 65);
    }

    shuffleTimers.push(setTimeout(function () {
      if (!refs.shuffleOverlay) return;
      refs.shuffleOverlay.classList.add('is-leaving');
    }, 2550));

    shuffleTimers.push(setTimeout(function () {
      if (shuffleGhostTimer) {
        clearInterval(shuffleGhostTimer);
        shuffleGhostTimer = null;
      }
      shufflePlaying = false;
      refs.shuffleOverlay.hidden = true;
      refs.shuffleOverlay.classList.remove('is-leaving');
      refs.shuffleStage.innerHTML = '';
      refs.shuffleGhosts.innerHTML = '';
      document.body.classList.remove('no-scroll');
      ui.toast('Respostas embaralhadas! Agora tente adivinhar quem escreveu cada uma.', 'success');
    }, 3080));
  }

  Retro.room = {
    open: open,
    close: close
  };
}());
