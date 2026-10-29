/*
 * Retro Special — núcleo de estado da sala.
 *
 * Este módulo roda tanto no Node (servidor) quanto no navegador (modo demo).
 * Ele não conhece HTTP, sockets, DOM ou timers: apenas estado + regras.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RetroEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var MAX_USERS = 30;
  var MAX_CARDS = 100;
  var ROWS = { acertos: true, melhorias: true };

  var USER_COLORS = [
    '#b6ff5c', '#5ce1ff', '#ff7ab6', '#ffc857', '#b78cff', '#64f0b2',
    '#ff9a5c', '#8ab4ff', '#ff6b6b', '#7ef9d3', '#e0c3ff', '#fff07a'
  ];

  var AVATAR_BACKGROUNDS = [
    'linear-gradient(135deg,#ff7ab6,#7b2cff)',
    'linear-gradient(135deg,#5ce1ff,#2563eb)',
    'linear-gradient(135deg,#b6ff5c,#0a9f6e)',
    'linear-gradient(135deg,#ffc857,#ff5c2b)',
    'linear-gradient(135deg,#b78cff,#5b2bff)',
    'linear-gradient(135deg,#64f0b2,#0e7490)',
    'linear-gradient(135deg,#ff9a5c,#ff2d75)',
    'linear-gradient(135deg,#8ab4ff,#4338ca)'
  ];

  var DEFAULT_EMOJIS = ['🦊', '🐼', '🐸', '👾', '🦄', '🐙', '🦁', '🐯', '🐨', '🐵', '🐧', '🦖', '🐳', '🦉', '🐝', '🦩'];

  /* ------------------------------------------------------------------ *
   * utilidades
   * ------------------------------------------------------------------ */

  var idCounter = 0;

  function uid(prefix) {
    idCounter += 1;
    return (
      (prefix || 'x') + '_' +
      Date.now().toString(36) +
      idCounter.toString(36) +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function randomCode(length) {
    var size = length || 6;
    var out = '';
    for (var i = 0; i < size; i += 1) {
      out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return out;
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(value);
  }

  function cleanName(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function cleanBlock(value, max) {
    return String(value == null ? '' : value)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }

  function cleanAvatar(value, colorIndex) {
    var bg = AVATAR_BACKGROUNDS[colorIndex % AVATAR_BACKGROUNDS.length];
    if (value && value.kind === 'photo' && typeof value.value === 'string') {
      var photo = value.value.replace(/\s+/g, '');
      if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) && photo.length <= 900000) {
        return { kind: 'photo', value: photo };
      }
    }
    if (value && value.kind === 'emoji' && typeof value.value === 'string') {
      var emoji = value.value.trim();
      if (emoji.length > 0 && emoji.length <= 16) {
        return { kind: 'emoji', value: emoji, bg: bg };
      }
    }
    return { kind: 'emoji', value: '🦊', bg: bg };
  }

  function makeUser(identity, colorIndex) {
    colorIndex = colorIndex || 0;
    return {
      id: validId(identity && identity.id) ? identity.id : uid('u'),
      name: cleanName(identity && identity.name) || 'Convidado',
      avatar: cleanAvatar(identity && identity.avatar, colorIndex),
      color: USER_COLORS[colorIndex % USER_COLORS.length],
      connected: identity && identity.connected === false ? false : true,
      joinedAt: Date.now()
    };
  }

  function findUser(room, userId) {
    for (var i = 0; i < room.users.length; i += 1) {
      if (room.users[i].id === userId) return room.users[i];
    }
    return null;
  }

  function findAnswer(dynamics, answerId) {
    for (var i = 0; i < dynamics.answers.length; i += 1) {
      if (dynamics.answers[i].id === answerId) return dynamics.answers[i];
    }
    return null;
  }

  function findCard(column, cardId) {
    for (var i = 0; i < column.cards.length; i += 1) {
      if (column.cards[i].id === cardId) return column.cards[i];
    }
    return null;
  }

  function touch(room) {
    room.version += 1;
    room.updatedAt = Date.now();
  }

  function freshDynamics(round) {
    return {
      phase: 'setup', // setup | collecting | voting | closed | done
      round: round || 1,
      question: '',
      questionVisible: false,
      participantIds: [],
      answers: [],
      order: [],
      assignments: {},
      revealed: [],
      shuffleAt: 0,
      startedAt: 0,
      closedAt: 0
    };
  }

  function shuffleList(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function connectedParticipants(room) {
    var d = room.dynamics;
    if (!d.participantIds.length) return [];
    var ids = {};
    d.participantIds.forEach(function (id) { ids[id] = true; });
    return room.users.filter(function (user) {
      return user.connected && ids[user.id];
    });
  }

  function answeredUserIds(dynamics) {
    return dynamics.answers.map(function (answer) { return answer.userId; });
  }

  /* ------------------------------------------------------------------ *
   * criação / entrada
   * ------------------------------------------------------------------ */

  function createRoom(identity, code) {
    var user = makeUser(identity, 0);
    var room = {
      code: normalizeCode(code) || randomCode(6),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      organizerId: user.id,
      colorSeq: 1,
      users: [user],
      columns: {
        acertos: { key: 'acertos', revealed: false, cards: [] },
        melhorias: { key: 'melhorias', revealed: false, cards: [] }
      },
      dynamics: freshDynamics(1)
    };
    return room;
  }

  function joinRoom(room, identity) {
    if (!room) return { ok: false, error: 'Sala não encontrada.' };
    var name = cleanName(identity && identity.name);
    if (!name) return { ok: false, error: 'Informe seu nome para entrar.' };

    var existing = findUser(room, identity && identity.id);
    if (existing) {
      existing.name = name;
      existing.avatar = cleanAvatar(identity && identity.avatar, USER_COLORS.indexOf(existing.color));
      existing.connected = true;
      touch(room);
      return { ok: true, user: existing, isNew: false };
    }

    if (room.users.length >= MAX_USERS) {
      return { ok: false, error: 'Esta sala já está cheia (limite de ' + MAX_USERS + ' pessoas).' };
    }

    var user = makeUser(identity, room.colorSeq);
    room.colorSeq += 1;
    room.users.push(user);

    // Quem chega durante a coleta de respostas pode participar da rodada.
    if (room.dynamics.phase === 'collecting') {
      room.dynamics.participantIds.push(user.id);
    }

    touch(room);
    return { ok: true, user: user, isNew: true };
  }

  function setConnected(room, userId, connected) {
    var user = findUser(room, userId);
    if (!user || user.connected === connected) return false;
    user.connected = connected;
    touch(room);
    return true;
  }

  function roomIsAlive(room) {
    return !!room && room.users.some(function (user) { return user.connected; });
  }

  /* ------------------------------------------------------------------ *
   * ações
   * ------------------------------------------------------------------ */

  function isOrganizer(room, userId) {
    return room.organizerId === userId;
  }

  function requireOrganizer(room, userId) {
    if (!isOrganizer(room, userId)) {
      return { ok: false, error: 'Só o organizador da sala pode fazer isso.' };
    }
    return null;
  }

  function requireMember(room, userId) {
    if (!findUser(room, userId)) {
      return { ok: false, error: 'Você não está nesta sala.' };
    }
    return null;
  }

  function getColumn(room, key) {
    if (!ROWS[key]) return null;
    return room.columns[key];
  }

  function applyAction(room, userId, type, payload) {
    if (!room) return { ok: false, error: 'Sala não encontrada.' };
    payload = payload || {};
    var notMember = requireMember(room, userId);
    if (notMember) return notMember;

    var column;
    var card;
    var d;
    var user;

    switch (type) {
      /* ----------------------------- cards ----------------------------- */
      case 'card:add': {
        column = getColumn(room, payload.column);
        if (!column) return { ok: false, error: 'Bloco inválido.' };
        var text = cleanBlock(payload.text, 600);
        if (!text) return { ok: false, error: 'Escreva alguma coisa antes de adicionar.' };
        if (column.cards.length >= MAX_CARDS) {
          return { ok: false, error: 'Este bloco atingiu o limite de cards.' };
        }
        card = {
          id: uid('card'),
          authorId: userId,
          text: text,
          createdAt: Date.now(),
          likes: [],
          actionPlan: { text: '', assignees: [], updatedAt: 0 }
        };
        column.cards.push(card);
        touch(room);
        return { ok: true, event: { kind: 'card-added', column: payload.column, cardId: card.id } };
      }

      case 'card:remove': {
        column = getColumn(room, payload.column);
        if (!column) return { ok: false, error: 'Bloco inválido.' };
        card = findCard(column, payload.cardId);
        if (!card) return { ok: false, error: 'Card não encontrado.' };
        if (card.authorId !== userId && !isOrganizer(room, userId)) {
          return { ok: false, error: 'Você só pode remover os seus cards.' };
        }
        column.cards = column.cards.filter(function (item) { return item.id !== card.id; });
        touch(room);
        return { ok: true, event: { kind: 'card-removed', column: payload.column, cardId: card.id } };
      }

      case 'column:reveal': {
        var orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        column = getColumn(room, payload.column);
        if (!column) return { ok: false, error: 'Bloco inválido.' };
        if (column.revealed) return { ok: false, error: 'Este bloco já foi revelado.' };
        column.revealed = true;
        touch(room);
        return { ok: true, event: { kind: 'column-revealed', column: payload.column } };
      }

      case 'card:like': {
        column = getColumn(room, payload.column);
        if (!column) return { ok: false, error: 'Bloco inválido.' };
        if (!column.revealed) return { ok: false, error: 'O organizador ainda não revelou este bloco.' };
        card = findCard(column, payload.cardId);
        if (!card) return { ok: false, error: 'Card não encontrado.' };
        var index = card.likes.indexOf(userId);
        var liked = index === -1;
        if (liked) card.likes.push(userId);
        else card.likes.splice(index, 1);
        touch(room);
        return {
          ok: true,
          event: { kind: 'card-liked', column: payload.column, cardId: card.id, liked: liked }
        };
      }

      case 'card:actionPlan': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        column = room.columns.melhorias;
        card = findCard(column, payload.cardId);
        if (!card) return { ok: false, error: 'Card não encontrado.' };
        if (!column.revealed) {
          return { ok: false, error: 'Revele os cards de Melhorias antes de criar o plano de ação.' };
        }
        var planText = cleanBlock(payload.text, 500);
        var assignees = Array.isArray(payload.assignees) ? payload.assignees : [];
        assignees = assignees.filter(function (id, i) {
          return validId(id) && findUser(room, id) && assignees.indexOf(id) === i;
        });
        card.actionPlan = { text: planText, assignees: assignees, updatedAt: Date.now() };
        touch(room);
        return { ok: true, event: { kind: 'action-plan', column: 'melhorias', cardId: card.id } };
      }

      /* --------------------------- dinâmica ---------------------------- */
      case 'dynamics:setQuestion': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (d.phase !== 'setup') {
          return { ok: false, error: 'A pergunta só pode ser alterada antes de liberar as respostas.' };
        }
        var question = cleanBlock(payload.text, 300);
        if (!question) return { ok: false, error: 'Escreva a pergunta da dinâmica.' };
        d.question = question;
        touch(room);
        return { ok: true, event: { kind: 'question-set' } };
      }

      case 'dynamics:toggleQuestion': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (!d.question) return { ok: false, error: 'Cadastre uma pergunta primeiro.' };
        d.questionVisible = payload.visible == null ? !d.questionVisible : !!payload.visible;
        touch(room);
        return { ok: true, event: { kind: 'question-visibility', visible: d.questionVisible } };
      }

      case 'dynamics:startCollecting': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (d.phase !== 'setup') return { ok: false, error: 'As respostas já foram liberadas.' };
        if (!d.question) return { ok: false, error: 'Cadastre uma pergunta antes de liberar.' };
        d.phase = 'collecting';
        d.questionVisible = true;
        d.participantIds = room.users.map(function (item) { return item.id; });
        d.answers = [];
        d.order = [];
        d.assignments = {};
        d.revealed = [];
        d.startedAt = Date.now();
        touch(room);
        return { ok: true, event: { kind: 'collecting-started' } };
      }

      case 'dynamics:answer': {
        d = room.dynamics;
        if (d.phase !== 'collecting') return { ok: false, error: 'As respostas não estão abertas.' };
        if (d.participantIds.indexOf(userId) === -1) {
          return { ok: false, error: 'Você entrou depois do início desta dinâmica.' };
        }
        if (!d.questionVisible && !isOrganizer(room, userId)) {
          return { ok: false, error: 'O organizador ocultou a pergunta.' };
        }
        var answerText = cleanBlock(payload.text, 500);
        if (!answerText) return { ok: false, error: 'Escreva a sua resposta.' };
        var myAnswer = null;
        d.answers.forEach(function (answer) {
          if (answer.userId === userId) myAnswer = answer;
        });
        if (myAnswer) {
          myAnswer.text = answerText;
          myAnswer.updatedAt = Date.now();
        } else {
          d.answers.push({
            id: uid('ans'),
            userId: userId,
            text: answerText,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }
        touch(room);
        return { ok: true, event: { kind: 'answer-submitted', userId: userId } };
      }

      case 'dynamics:shuffle': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (d.phase !== 'collecting') return { ok: false, error: 'As respostas não estão abertas.' };
        if (d.answers.length < 2) {
          return { ok: false, error: 'São necessárias pelo menos 2 respostas para embaralhar.' };
        }
        var connected = connectedParticipants(room);
        var answered = answeredUserIds(d);
        var pending = connected.filter(function (item) { return answered.indexOf(item.id) === -1; });
        if (pending.length) {
          return { ok: false, error: 'Ainda faltam respostas de ' + pending.map(function (u) { return u.name; }).join(', ') + '.' };
        }
        d.order = shuffleList(d.answers.map(function (answer) { return answer.id; }));
        d.assignments = {};
        d.revealed = [];
        d.phase = 'voting';
        d.shuffleAt = Date.now();
        touch(room);
        return { ok: true, event: { kind: 'shuffled', at: d.shuffleAt } };
      }

      case 'dynamics:assign': {
        d = room.dynamics;
        if (d.phase !== 'voting') return { ok: false, error: 'A votação não está aberta.' };
        if (d.participantIds.indexOf(userId) === -1) {
          return { ok: false, error: 'Você entrou depois do início desta dinâmica.' };
        }
        var answerId = String(payload.answerId || '');
        var targetId = String(payload.targetUserId || '');
        if (d.order.indexOf(answerId) === -1) return { ok: false, error: 'Resposta inválida.' };
        if (targetId === userId) return { ok: false, error: 'Você não precisa adivinhar a sua própria resposta.' };
        var targetIsAuthor = d.answers.some(function (answer) { return answer.userId === targetId; });
        if (!targetIsAuthor) return { ok: false, error: 'Pessoa inválida para esta rodada.' };

        if (!d.assignments[userId]) d.assignments[userId] = {};
        var myMap = d.assignments[userId];
        Object.keys(myMap).forEach(function (key) {
          if (myMap[key] === targetId) delete myMap[key];
        });
        myMap[answerId] = targetId;
        touch(room);
        return {
          ok: true,
          event: { kind: 'vote-cast', voterId: userId, answerId: answerId, targetUserId: targetId }
        };
      }

      case 'dynamics:unassign': {
        d = room.dynamics;
        if (d.phase !== 'voting') return { ok: false, error: 'A votação não está aberta.' };
        var removeTarget = String(payload.targetUserId || '');
        var map = d.assignments[userId];
        if (!map) return { ok: true, event: { kind: 'vote-removed', voterId: userId, targetUserId: removeTarget } };
        var removed = false;
        Object.keys(map).forEach(function (key) {
          if (map[key] === removeTarget) {
            delete map[key];
            removed = true;
          }
        });
        if (removed) touch(room);
        return {
          ok: true,
          event: { kind: 'vote-removed', voterId: userId, targetUserId: removeTarget }
        };
      }

      case 'dynamics:endVoting': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (d.phase !== 'voting') return { ok: false, error: 'A votação não está aberta.' };
        var status = votingStatus(room);
        if (!status.complete) {
          return { ok: false, error: 'Ainda faltam palpites de ' + status.pending.map(function (u) { return u.name; }).join(', ') + '.' };
        }
        d.phase = 'closed';
        d.closedAt = Date.now();
        touch(room);
        return { ok: true, event: { kind: 'voting-ended' } };
      }

      case 'dynamics:revealNext': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        d = room.dynamics;
        if (d.phase !== 'closed') return { ok: false, error: 'A votação ainda não foi encerrada.' };
        if (d.revealed.length >= d.order.length) {
          return { ok: false, error: 'Todas as respostas já foram reveladas.' };
        }
        var nextId = d.order[d.revealed.length];
        var nextAnswer = findAnswer(d, nextId);
        d.revealed.push(nextId);
        var done = d.revealed.length >= d.order.length;
        if (done) d.phase = 'done';
        touch(room);
        return {
          ok: true,
          event: {
            kind: 'answer-revealed',
            answerId: nextId,
            authorId: nextAnswer ? nextAnswer.userId : null,
            done: done
          }
        };
      }

      case 'dynamics:reset': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        var round = room.dynamics.round + 1;
        room.dynamics = freshDynamics(round);
        touch(room);
        return { ok: true, event: { kind: 'dynamics-reset' } };
      }

      /* ----------------------------- sala ------------------------------ */
      case 'room:kick': {
        orgError = requireOrganizer(room, userId);
        if (orgError) return orgError;
        var kickId = String(payload.userId || '');
        if (kickId === userId) return { ok: false, error: 'Você não pode remover a si mesmo.' };
        user = findUser(room, kickId);
        if (!user) return { ok: false, error: 'Pessoa não encontrada.' };
        d = room.dynamics;
        if (d.phase === 'voting' || d.phase === 'closed') {
          return { ok: false, error: 'Não é possível remover pessoas durante a votação ou revelação.' };
        }
        room.users = room.users.filter(function (item) { return item.id !== kickId; });
        Object.keys(room.columns).forEach(function (key) {
          room.columns[key].cards = room.columns[key].cards
            .filter(function (item) { return item.authorId !== kickId; })
            .map(function (item) {
              // joinhas e planos de ação da pessoa removida não devem sobrar
              item.likes = (item.likes || []).filter(function (id) { return id !== kickId; });
              if (item.actionPlan) {
                item.actionPlan.assignees = (item.actionPlan.assignees || []).filter(function (id) { return id !== kickId; });
              }
              return item;
            });
        });
        d.participantIds = d.participantIds.filter(function (id) { return id !== kickId; });
        d.answers = d.answers.filter(function (answer) { return answer.userId !== kickId; });
        d.order = d.order.filter(function (answerId) {
          return d.answers.some(function (answer) { return answer.id === answerId; });
        });
        d.revealed = d.revealed.filter(function (answerId) {
          return d.order.indexOf(answerId) !== -1;
        });
        d.assignments = d.assignments || {};
        delete d.assignments[kickId];
        Object.keys(d.assignments).forEach(function (voter) {
          Object.keys(d.assignments[voter]).forEach(function (answerId) {
            if (d.assignments[voter][answerId] === kickId) delete d.assignments[voter][answerId];
          });
        });
        touch(room);
        return { ok: true, event: { kind: 'member-kicked', userId: kickId } };
      }

      case 'room:presence': {
        // usado apenas para testes / modo demo; o servidor controla presença.
        user = findUser(room, userId);
        if (user && user.connected !== !!payload.connected) {
          setConnected(room, userId, !!payload.connected);
        }
        return { ok: true, event: null };
      }

      default:
        return { ok: false, error: 'Ação desconhecida.' };
    }
  }

  /* ------------------------------------------------------------------ *
   * derivados
   * ------------------------------------------------------------------ */

  function completeVoter(room, voterId) {
    var d = room.dynamics;
    var authorIds = d.answers.map(function (answer) { return answer.userId; });
    var targets = authorIds.filter(function (id) { return id !== voterId; });
    var mine = d.assignments[voterId] || {};
    var values = Object.keys(mine).map(function (key) { return mine[key]; });
    return targets.every(function (targetId) { return values.indexOf(targetId) !== -1; });
  }

  function votingStatus(room) {
    var d = room.dynamics;
    var connected = connectedParticipants(room);
    var pending = connected.filter(function (user) { return !completeVoter(room, user.id); });
    return {
      connected: connected.length,
      pending: pending,
      complete: connected.length > 0 && pending.length === 0
    };
  }

  function computeScores(room) {
    var d = room.dynamics;
    var revealed = {};
    d.revealed.forEach(function (id) { revealed[id] = true; });
    var participantIds = d.participantIds.slice();
    return room.users
      .filter(function (user) { return participantIds.indexOf(user.id) !== -1; })
      .map(function (user) {
        var points = 0;
        var correctAnswerIds = [];
        d.answers.forEach(function (answer) {
          if (!revealed[answer.id]) return;
          var mine = d.assignments[user.id] || {};
          if (mine[answer.id] === answer.userId) {
            points += 1;
            correctAnswerIds.push(answer.id);
          }
        });
        return {
          id: user.id,
          userId: user.id,
          name: user.name,
          avatar: user.avatar,
          color: user.color,
          connected: user.connected,
          points: points,
          correctAnswerIds: correctAnswerIds
        };
      })
      .sort(function (a, b) {
        if (b.points !== a.points) return b.points - a.points;
        return a.name.localeCompare(b.name, 'pt-BR');
      });
  }

  function publicUser(room, user) {
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      color: user.color,
      connected: user.connected,
      isOrganizer: room.organizerId === user.id,
      joinedAt: user.joinedAt
    };
  }

  function columnState(room, key, viewerId) {
    var column = room.columns[key];
    var isOrg = room.organizerId === viewerId;
    return {
      key: key,
      revealed: column.revealed,
      count: column.cards.length,
      cards: column.cards.map(function (card) {
        return {
          id: card.id,
          text: card.text,
          createdAt: card.createdAt,
          likeCount: card.likes.length,
          likedByMe: card.likes.indexOf(viewerId) !== -1,
          canRead: column.revealed || card.authorId === viewerId,
          canRemove: card.authorId === viewerId || isOrg,
          actionPlan: {
            text: card.actionPlan.text,
            assignees: card.actionPlan.assignees.filter(function (id) { return !!findUser(room, id); }),
            updatedAt: card.actionPlan.updatedAt
          },
          canEditPlan: isOrg && column.revealed
        };
      })
    };
  }

  function dynamicsState(room, viewerId) {
    var d = room.dynamics;
    var isOrg = room.organizerId === viewerId;
    var viewerIsParticipant = d.participantIds.indexOf(viewerId) !== -1;
    var phase = d.phase;
    var active = phase !== 'setup';
    var connected = connectedParticipants(room);
    var answeredIds = answeredUserIds(d);
    var connectedAnswered = connected.filter(function (user) {
      return answeredIds.indexOf(user.id) !== -1;
    });
    var authorIds = d.answers.map(function (answer) { return answer.userId; });
    var revealedMap = {};
    d.revealed.forEach(function (id) { revealedMap[id] = true; });
    var myAnswer = null;
    d.answers.forEach(function (answer) {
      if (answer.userId === viewerId) myAnswer = answer;
    });

    var answers = [];
    if (phase === 'collecting') {
      if (myAnswer) {
        answers.push({
          id: myAnswer.id,
          text: myAnswer.text,
          mine: true,
          revealed: false, // o autor só é liberado no fim; aqui é o próprio card
          author: publicUser(room, findUser(room, viewerId)),
          correctVoterIds: []
        });
      }
    } else if (phase === 'voting' || phase === 'closed' || phase === 'done') {
      answers = d.order.map(function (answerId) {
        var answer = findAnswer(d, answerId);
        if (!answer) return null;
        var isRevealed = !!revealedMap[answer.id];
        var author = findUser(room, answer.userId);
        var correctVoterIds = [];
        if (isRevealed) {
          room.users.forEach(function (user) {
            var mine = d.assignments[user.id] || {};
            if (mine[answer.id] === answer.userId) correctVoterIds.push(user.id);
          });
        }
        return {
          id: answer.id,
          text: answer.text,
          mine: answer.userId === viewerId,
          revealed: isRevealed,
          author: isRevealed && author ? publicUser(room, author) : null,
          correctVoterIds: correctVoterIds,
          votes: countVotesForAnswer(d, answer.id)
        };
      }).filter(Boolean);
    }

    var status = votingStatus(room);
    var connectedVoters = connected;
    var pendingVoting = status.pending.map(function (user) {
      return { id: user.id, name: user.name };
    });

    var myAssignments = d.assignments[viewerId] || {};
    var myTargets = authorIds.filter(function (id) { return id !== viewerId; });
    var assignedTargets = Object.keys(myAssignments).map(function (key) { return myAssignments[key]; });
    var myAssignedCount = myTargets.filter(function (id) { return assignedTargets.indexOf(id) !== -1; }).length;

    var scores = null;
    if (phase === 'closed' || phase === 'done') {
      scores = computeScores(room);
      // informa a posição de cada resposta revelada no placar
      var revealedCount = d.revealed.length;
      scores.forEach(function (score) {
        score.revealedCount = revealedCount;
      });
    }

    var questionAvailable = !!d.question;
    var canSeeQuestion = questionAvailable && (d.questionVisible || isOrg);
    var questionHiddenForMe = questionAvailable && !d.questionVisible && !isOrg;

    var canShuffle = phase === 'collecting' &&
      d.answers.length >= 2 &&
      connected.length > 0 &&
      connected.every(function (user) { return answeredIds.indexOf(user.id) !== -1; });

    return {
      phase: phase,
      round: d.round,
      question: canSeeQuestion ? d.question : null,
      questionVisible: d.questionVisible,
      questionAvailable: questionAvailable,
      questionHiddenForMe: questionHiddenForMe,
      isOrganizer: isOrg,
      viewerIsParticipant: viewerIsParticipant,
      isSpectator: active && !viewerIsParticipant && phase !== 'setup',
      participantCount: d.participantIds.length,
      participants: room.users.map(function (user) {
        return {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          color: user.color,
          connected: user.connected,
          isOrganizer: room.organizerId === user.id,
          isParticipant: d.participantIds.indexOf(user.id) !== -1,
          hasAnswered: answeredIds.indexOf(user.id) !== -1
        };
      }),
      authorIds: authorIds,
      answerProgress: {
        answered: connectedAnswered.length,
        connected: connected.length,
        totalAnswers: d.answers.length,
        totalParticipants: d.participantIds.length
      },
      canShuffle: canShuffle,
      myAnswer: myAnswer ? { id: myAnswer.id, text: myAnswer.text } : null,
      canAnswer: phase === 'collecting' && viewerIsParticipant && (d.questionVisible || isOrg),
      answers: answers,
      order: d.order.slice(),
      revealed: d.revealed.slice(),
      revealedCount: d.revealed.length,
      totalAnswers: d.order.length,
      assignments: (phase === 'voting' || phase === 'closed' || phase === 'done') ? d.assignments : {},
      myAssignments: myAssignments,
      canVote: phase === 'voting' && viewerIsParticipant,
      myVoting: {
        assigned: myAssignedCount,
        total: myTargets.length,
        complete: myAssignedCount === myTargets.length
      },
      voting: {
        connected: connectedVoters.length,
        completeCount: connectedVoters.length - pendingVoting.length,
        pending: pendingVoting,
        complete: status.complete
      },
      canEndVoting: isOrg && phase === 'voting' && status.complete,
      canRevealNext: isOrg && phase === 'closed' && d.revealed.length < d.order.length,
      canReset: isOrg,
      shuffleAt: d.shuffleAt,
      startedAt: d.startedAt,
      closedAt: d.closedAt,
      scores: scores,
      scoreboardVisible: phase === 'closed' || phase === 'done'
    };
  }

  function countVotesForAnswer(dynamics, answerId) {
    var count = 0;
    Object.keys(dynamics.assignments).forEach(function (voterId) {
      var map = dynamics.assignments[voterId] || {};
      if (map[answerId]) count += 1;
    });
    return count;
  }

  function getState(room, viewerId) {
    if (!room) return null;
    var viewer = findUser(room, viewerId);
    var isOrg = room.organizerId === viewerId;
    return {
      code: room.code,
      version: room.version,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      viewerId: viewerId,
      organizerId: room.organizerId,
      isOrganizer: isOrg,
      isMember: !!viewer,
      users: room.users.map(function (user) { return publicUser(room, user); }),
      acertos: columnState(room, 'acertos', viewerId),
      melhorias: columnState(room, 'melhorias', viewerId),
      dynamics: dynamicsState(room, viewerId)
    };
  }

  return {
    createRoom: createRoom,
    joinRoom: joinRoom,
    applyAction: applyAction,
    getState: getState,
    setConnected: setConnected,
    roomIsAlive: roomIsAlive,
    findUser: findUser,
    randomCode: randomCode,
    normalizeCode: normalizeCode,
    connectedParticipants: connectedParticipants,
    votingStatus: votingStatus,
    _internals: {
      MAX_USERS: MAX_USERS,
      MAX_CARDS: MAX_CARDS,
      USER_COLORS: USER_COLORS,
      AVATAR_BACKGROUNDS: AVATAR_BACKGROUNDS,
      DEFAULT_EMOJIS: DEFAULT_EMOJIS
    }
  };
});
