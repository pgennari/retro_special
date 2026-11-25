/* Casos de teste do motor — usados pelo navegador e pelo Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetroEngineTests = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function run(engine, assert) {
    var results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: name, ok: true });
      } catch (error) {
        results.push({ name: name, ok: false, error: error && error.message ? error.message : String(error) });
      }
    }

    function person(id, name) {
      return {
        id: id,
        name: name,
        avatar: { kind: 'emoji', value: '🦊' }
      };
    }

    test('cria sala com organizador e blocos vazios', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      assert.equal(room.users.length, 1);
      assert.equal(room.organizerId, 'user_ana');
      assert.equal(room.columns.acertos.revealed, false);
      assert.equal(room.columns.melhorias.cards.length, 0);
      assert.equal(room.dynamics.phase, 'setup');
    });

    test('entra na sala, atualiza presença e dá cor única', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      var joined = engine.joinRoom(room, person('user_bia', 'Bia'));
      assert.ok(joined.ok);
      assert.equal(room.users.length, 2);
      assert.notEqual(room.users[0].color, room.users[1].color);
      var state = engine.getState(room, 'user_bia');
      assert.equal(state.users.length, 2);
      assert.equal(state.isOrganizer, false);
    });

    test('reentrar com o mesmo id reconecta sem criar outro participante', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      var first = engine.joinRoom(room, person('user_bia', 'Bia'));
      assert.equal(first.isNew, true);

      engine.setConnected(room, 'user_bia', false);
      var again = engine.joinRoom(room, person('user_bia', 'Bia'));
      assert.equal(again.ok, true);
      assert.equal(again.isNew, false);
      assert.equal(again.user.id, first.user.id);
      assert.equal(again.user.connected, true);
      assert.equal(room.users.length, 2);
    });

    test('cards ficam ocultos para os outros até a revelação', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_ana', 'card:add', { column: 'acertos', text: 'Deploy sem sustos' });
      assert.ok(add.ok);
      room.columns.acertos.cards[0].actionPlan = {
        text: 'Plano secreto', assignees: ['user_bia'], updatedAt: 1
      };

      var biaView = engine.getState(room, 'user_bia');
      assert.equal(biaView.acertos.cards.length, 1);
      assert.equal(biaView.acertos.cards[0].canRead, false);
      assert.equal(biaView.acertos.cards[0].authorId, undefined);
      assert.equal(biaView.acertos.cards[0].text, '', 'o texto não pode vazar no estado');
      assert.equal(biaView.acertos.cards[0].actionPlan.text, '');
      assert.equal(biaView.acertos.cards[0].actionPlan.assignees.length, 0);
      assert.equal(biaView.acertos.revealed, false);

      var anaView = engine.getState(room, 'user_ana');
      assert.equal(anaView.acertos.cards[0].canRead, true);
      assert.equal(anaView.acertos.cards[0].actionPlan.text, 'Plano secreto');

      var denied = engine.applyAction(room, 'user_bia', 'column:reveal', { column: 'acertos' });
      assert.ok(!denied.ok);
      var deniedLike = engine.applyAction(room, 'user_bia', 'card:like', { column: 'acertos', cardId: add.event.cardId });
      assert.ok(!deniedLike.ok);

      var reveal = engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'acertos' });
      assert.ok(reveal.ok);
      var after = engine.getState(room, 'user_bia');
      assert.equal(after.acertos.revealed, true);
      assert.equal(after.acertos.cards[0].canRead, true);
      assert.ok(engine.applyAction(room, 'user_bia', 'card:like', { column: 'acertos', cardId: add.event.cardId }).ok);
      var liked = engine.getState(room, 'user_bia');
      assert.equal(liked.acertos.cards[0].likeCount, 1);
      assert.equal(liked.acertos.cards[0].likedByMe, true);
    });

    test('revelar um bloco bloqueia novos cards', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      ['acertos', 'melhorias'].forEach(function (key) {
        var add = engine.applyAction(room, 'user_ana', 'card:add', { column: key, text: 'Antes da revelação' });
        assert.ok(add.ok);
        assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: key }).ok);

        var blocked = engine.applyAction(room, 'user_ana', 'card:add', { column: key, text: 'Depois da revelação' });
        assert.ok(!blocked.ok);
        assert.equal(engine.getState(room, 'user_ana')[key].cards.length, 1);
      });
    });

    test('após a revelação somente o organizador pode remover cards', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_bia', 'card:add', { column: 'acertos', text: 'Card da Bia' });
      assert.ok(add.ok);
      assert.equal(engine.getState(room, 'user_bia').acertos.cards[0].canRemove, true);

      assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'acertos' }).ok);

      var denied = engine.applyAction(room, 'user_bia', 'card:remove', {
        column: 'acertos', cardId: add.event.cardId
      });
      assert.ok(!denied.ok);
      assert.equal(engine.getState(room, 'user_bia').acertos.cards[0].canRemove, false);
      assert.equal(engine.getState(room, 'user_ana').acertos.cards[0].canRemove, true);

      assert.ok(engine.applyAction(room, 'user_ana', 'card:remove', {
        column: 'acertos', cardId: add.event.cardId
      }).ok);
      assert.equal(engine.getState(room, 'user_bia').acertos.cards.length, 0);
    });

    test('organizador promove e rebaixa moderadores conectados', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.joinRoom(room, person('user_caio', 'Caio'));

      assert.equal(engine.getState(room, 'user_bia').isModerator, false);
      assert.equal(engine.getState(room, 'user_bia').canModerate, false);
      assert.equal(engine.getState(room, 'user_bia').users[1].isModerator, false);

      var denied = engine.applyAction(room, 'user_bia', 'room:setModerator', {
        userId: 'user_caio', moderator: true
      });
      assert.ok(!denied.ok, 'participante não pode promover ninguém');

      engine.setConnected(room, 'user_bia', false);
      var offline = engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_bia', moderator: true
      });
      assert.ok(!offline.ok, 'não pode promover quem está offline');

      engine.setConnected(room, 'user_bia', true);
      var promote = engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_bia', moderator: true
      });
      assert.ok(promote.ok);
      assert.equal(promote.event.kind, 'moderator-changed');
      assert.equal(engine.getState(room, 'user_bia').isModerator, true);
      assert.equal(engine.getState(room, 'user_bia').canModerate, true);
      assert.equal(engine.getState(room, 'user_caio').canModerate, false);
      assert.equal(engine.getState(room, 'user_ana').users[1].isModerator, true);

      assert.ok(!engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_ana', moderator: true
      }).ok, 'organizador não pode alterar seu próprio papel');

      var demote = engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_bia', moderator: false
      });
      assert.ok(demote.ok);
      assert.equal(engine.getState(room, 'user_bia').canModerate, false);
    });

    test('moderador mescla cards de acertos após a revelação', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.joinRoom(room, person('user_caio', 'Caio'));
      assert.ok(engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_bia', moderator: true
      }).ok);

      var first = engine.applyAction(room, 'user_ana', 'card:add', {
        column: 'acertos', text: 'Deploy sem sustos'
      });
      var second = engine.applyAction(room, 'user_bia', 'card:add', {
        column: 'acertos', text: 'Deploy tranquilo'
      });

      assert.ok(!engine.applyAction(room, 'user_bia', 'column:reveal', { column: 'acertos' }).ok,
        'moderador não conduz a revelação');

      var locked = engine.applyAction(room, 'user_bia', 'card:merge', {
        column: 'acertos', cardId: first.event.cardId, sourceIds: [second.event.cardId]
      });
      assert.ok(!locked.ok, 'não pode mesclar antes da revelação');
      assert.equal(engine.getState(room, 'user_bia').acertos.canMerge, false);

      assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'acertos' }).ok);
      assert.equal(engine.getState(room, 'user_bia').acertos.canMerge, true);
      assert.equal(engine.getState(room, 'user_caio').acertos.canMerge, false);
      assert.equal(engine.getState(room, 'user_bia').acertos.cards[0].canRemove, false);
      assert.ok(!engine.applyAction(room, 'user_bia', 'card:remove', {
        column: 'acertos', cardId: first.event.cardId
      }).ok, 'moderador não ganha permissão de remoção');

      assert.ok(engine.applyAction(room, 'user_caio', 'card:like', {
        column: 'acertos', cardId: first.event.cardId
      }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'card:like', {
        column: 'acertos', cardId: second.event.cardId
      }).ok);

      var merged = engine.applyAction(room, 'user_bia', 'card:merge', {
        column: 'acertos', cardId: first.event.cardId, sourceIds: [second.event.cardId]
      });
      assert.ok(merged.ok);
      assert.equal(merged.event.kind, 'cards-merged');
      assert.equal(merged.event.cardId, first.event.cardId);

      var view = engine.getState(room, 'user_caio');
      assert.equal(view.acertos.cards.length, 1);
      assert.equal(view.acertos.cards[0].id, first.event.cardId);
      assert.ok(view.acertos.cards[0].text.indexOf('Deploy sem sustos') !== -1);
      assert.ok(view.acertos.cards[0].text.indexOf('Deploy tranquilo') !== -1);
      assert.equal(view.acertos.cards[0].likeCount, 2);
      assert.equal(view.acertos.cards[0].likedByMe, true);
    });

    test('mesclar melhorias combina plano de ação e responsáveis', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.joinRoom(room, person('user_caio', 'Caio'));
      assert.ok(engine.applyAction(room, 'user_ana', 'room:setModerator', {
        userId: 'user_bia', moderator: true
      }).ok);

      var first = engine.applyAction(room, 'user_ana', 'card:add', {
        column: 'melhorias', text: 'Melhorar testes'
      });
      var second = engine.applyAction(room, 'user_bia', 'card:add', {
        column: 'melhorias', text: 'Aumentar cobertura'
      });
      assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'melhorias' }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'card:actionPlan', {
        cardId: first.event.cardId, text: 'Separar 30 min de testes', assignees: ['user_bia']
      }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'card:actionPlan', {
        cardId: second.event.cardId, text: 'Cobrir fluxos críticos', assignees: ['user_caio']
      }).ok);

      var denied = engine.applyAction(room, 'user_caio', 'card:merge', {
        column: 'melhorias', cardId: first.event.cardId, sourceIds: [second.event.cardId]
      });
      assert.ok(!denied.ok, 'participante não pode mesclar');

      assert.ok(engine.applyAction(room, 'user_bia', 'card:merge', {
        column: 'melhorias', cardId: first.event.cardId, sourceIds: [second.event.cardId]
      }).ok);

      var card = engine.getState(room, 'user_ana').melhorias.cards[0];
      assert.equal(engine.getState(room, 'user_ana').melhorias.cards.length, 1);
      assert.ok(card.text.indexOf('Melhorar testes') !== -1);
      assert.ok(card.text.indexOf('Aumentar cobertura') !== -1);
      assert.ok(card.actionPlan.text.indexOf('Separar 30 min de testes') !== -1);
      assert.ok(card.actionPlan.text.indexOf('Cobrir fluxos críticos') !== -1);
      assert.deepEqual(card.actionPlan.assignees, ['user_bia', 'user_caio']);
    });

    test('plano de ação exige revelação e valida responsáveis', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_ana', 'card:add', { column: 'melhorias', text: 'Melhorar testes' });
      var blocked = engine.applyAction(room, 'user_ana', 'card:actionPlan', {
        cardId: add.event.cardId, text: 'Pair programming', assignees: ['user_bia']
      });
      assert.ok(!blocked.ok);
      engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'melhorias' });
      var ok = engine.applyAction(room, 'user_ana', 'card:actionPlan', {
        cardId: add.event.cardId, text: 'Pair programming', assignees: ['user_bia', 'inexistente']
      });
      assert.ok(ok.ok);
      var state = engine.getState(room, 'user_ana');
      assert.equal(state.melhorias.cards[0].actionPlan.text, 'Pair programming');
      assert.deepEqual(state.melhorias.cards[0].actionPlan.assignees, ['user_bia']);
    });

    test('organizador pode chamar a turma para a dinâmica', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));

      var denied = engine.applyAction(room, 'user_bia', 'dynamics:call', {});
      assert.ok(!denied.ok);

      var call = engine.applyAction(room, 'user_ana', 'dynamics:call', {});
      assert.ok(call.ok);
      assert.equal(call.event.kind, 'dynamics-call');
      assert.ok(call.event.callId);

      var biaView = engine.getState(room, 'user_bia');
      assert.ok(biaView.dynamics.call);
      assert.equal(biaView.dynamics.call.by, 'user_ana');
      assert.equal(biaView.dynamics.call.id, call.event.callId);
    });

    test('organizador pode pedir atenção aos palpites pendentes', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));

      assert.ok(!engine.applyAction(room, 'user_ana', 'dynamics:attention', {}).ok);

      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Pergunta?' }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {}).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:answer', { text: 'Resposta 1' }).ok);
      assert.ok(engine.applyAction(room, 'user_bia', 'dynamics:answer', { text: 'Resposta 2' }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:shuffle', {}).ok);

      assert.ok(!engine.applyAction(room, 'user_bia', 'dynamics:attention', {}).ok);
      var attention = engine.applyAction(room, 'user_ana', 'dynamics:attention', {});
      assert.ok(attention.ok);
      assert.equal(attention.event.kind, 'dynamics-attention');
      assert.ok(attention.event.attentionId);

      var state = engine.getState(room, 'user_bia');
      assert.equal(state.dynamics.phase, 'voting');
      assert.equal(state.dynamics.voting.pending.length, 2);
      assert.ok(state.dynamics.attention);
      assert.equal(state.dynamics.attention.by, 'user_ana');

      var again = engine.applyAction(room, 'user_ana', 'dynamics:attention', {});
      assert.ok(again.ok);
      assert.notEqual(again.event.attentionId, attention.event.attentionId);
    });

    test('dinâmica completa: pergunta, respostas ocultas, embaralhamento, votos e placar', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.joinRoom(room, person('user_caio', 'Caio'));

      var noQuestion = engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {});
      assert.ok(!noQuestion.ok);

      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Qual foi o maior desafio?' }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {}).ok);

      var collecting = engine.getState(room, 'user_bia');
      assert.equal(collecting.dynamics.phase, 'collecting');
      assert.equal(collecting.dynamics.question, 'Qual foi o maior desafio?');
      assert.equal(collecting.dynamics.canAnswer, true);
      assert.equal(collecting.dynamics.canShuffle, false);

      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:answer', { text: 'A integração' }).ok);
      assert.ok(engine.applyAction(room, 'user_bia', 'dynamics:answer', { text: 'O prazo' }).ok);
      assert.ok(engine.applyAction(room, 'user_caio', 'dynamics:answer', { text: 'Os bugs' }).ok);

      var visible = engine.getState(room, 'user_bia');
      assert.equal(visible.dynamics.answers.length, 1);
      assert.equal(visible.dynamics.answers[0].mine, true);
      assert.equal(visible.dynamics.answers[0].text, 'O prazo');
      assert.equal(visible.dynamics.canShuffle, true);
      assert.equal(visible.dynamics.answerProgress.answered, 3);

      var shuffled = engine.applyAction(room, 'user_ana', 'dynamics:shuffle', {});
      assert.ok(shuffled.ok);
      var voting = engine.getState(room, 'user_bia');
      assert.equal(voting.dynamics.phase, 'voting');
      assert.equal(voting.dynamics.answers.length, 3);
      voting.dynamics.answers.forEach(function (answer) {
        assert.equal(answer.revealed, false);
        assert.equal(answer.author, null);
      });
      assert.equal(voting.dynamics.canVote, true);
      assert.equal(voting.dynamics.voting.connected, 3);

      // Bia associa todas as pessoas que responderam (menos ela) às respostas
      var order = voting.dynamics.answers.map(function (answer) { return answer.id; });
      var targets = ['user_ana', 'user_caio'];
      assert.ok(engine.applyAction(room, 'user_bia', 'dynamics:assign', { answerId: order[0], targetUserId: targets[0] }).ok);
      assert.ok(engine.applyAction(room, 'user_bia', 'dynamics:assign', { answerId: order[1], targetUserId: targets[1] }).ok);
      var reassign = engine.applyAction(room, 'user_bia', 'dynamics:assign', { answerId: order[0], targetUserId: targets[1] });
      assert.ok(reassign.ok);
      var biaAfterMove = engine.getState(room, 'user_bia');
      assert.equal(Object.keys(biaAfterMove.dynamics.myAssignments).length, 1);
      // devolve a segunda pessoa para a segunda resposta
      assert.ok(engine.applyAction(room, 'user_bia', 'dynamics:assign', { answerId: order[1], targetUserId: targets[0] }).ok);

      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:assign', { answerId: order[0], targetUserId: 'user_caio' }).ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:assign', { answerId: order[1], targetUserId: 'user_bia' }).ok);
      assert.ok(engine.applyAction(room, 'user_caio', 'dynamics:assign', { answerId: order[0], targetUserId: 'user_ana' }).ok);
      assert.ok(engine.applyAction(room, 'user_caio', 'dynamics:assign', { answerId: order[1], targetUserId: 'user_bia' }).ok);

      var allVoted = engine.getState(room, 'user_ana');
      assert.equal(allVoted.dynamics.voting.complete, true);
      assert.equal(allVoted.dynamics.canEndVoting, true);

      assert.ok(engine.applyAction(room, 'user_ana', 'dynamics:endVoting', {}).ok);
      var closed = engine.getState(room, 'user_bia');
      assert.equal(closed.dynamics.phase, 'closed');
      assert.equal(closed.dynamics.scoreboardVisible, true);
      closed.dynamics.answers.forEach(function (answer) { assert.equal(answer.author, null); });

      var reveal1 = engine.applyAction(room, 'user_ana', 'dynamics:revealNext', {});
      assert.ok(reveal1.ok);
      var afterOne = engine.getState(room, 'user_bia');
      var revealedAnswer = afterOne.dynamics.answers.filter(function (a) { return a.revealed; })[0];
      assert.ok(revealedAnswer.author);
      assert.ok(afterOne.dynamics.scores);
      var sum = afterOne.dynamics.scores.reduce(function (acc, s) { return acc + s.points; }, 0);
      assert.ok(sum >= 0);
      assert.equal(afterOne.dynamics.phase, 'closed');

      engine.applyAction(room, 'user_ana', 'dynamics:revealNext', {});
      var last = engine.applyAction(room, 'user_ana', 'dynamics:revealNext', {});
      assert.ok(last.ok);
      var done = engine.getState(room, 'user_bia');
      assert.equal(done.dynamics.phase, 'done');
      assert.equal(done.dynamics.revealedCount, 3);
      done.dynamics.answers.forEach(function (answer) { assert.ok(answer.author); });
      assert.equal(done.dynamics.totalAnswers, 3);
    });

    test('placar soma 1 ponto por acerto do autor', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Pergunta' });
      engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {});
      engine.applyAction(room, 'user_ana', 'dynamics:answer', { text: 'Resposta da Ana' });
      engine.applyAction(room, 'user_bia', 'dynamics:answer', { text: 'Resposta da Bia' });
      engine.applyAction(room, 'user_ana', 'dynamics:shuffle', {});
      var order = engine.getState(room, 'user_ana').dynamics.answers;
      // Ana descobre a resposta da Bia (autor certo)
      var biaAnswer = order.filter(function (a) { return a.text === 'Resposta da Bia'; })[0];
      engine.applyAction(room, 'user_ana', 'dynamics:assign', { answerId: biaAnswer.id, targetUserId: 'user_bia' });
      // Bia erra a resposta da Ana (associa a si mesma? não permitido) — associa a Ana = certo
      var anaAnswer = order.filter(function (a) { return a.text === 'Resposta da Ana'; })[0];
      engine.applyAction(room, 'user_bia', 'dynamics:assign', { answerId: anaAnswer.id, targetUserId: 'user_ana' });
      engine.applyAction(room, 'user_ana', 'dynamics:endVoting', {});
      engine.applyAction(room, 'user_ana', 'dynamics:revealNext', {});
      engine.applyAction(room, 'user_ana', 'dynamics:revealNext', {});
      var state = engine.getState(room, 'user_ana');
      var anaScore = state.dynamics.scores.filter(function (s) { return s.userId === 'user_ana'; })[0];
      var biaScore = state.dynamics.scores.filter(function (s) { return s.userId === 'user_bia'; })[0];
      assert.equal(anaScore.points, 1);
      assert.equal(biaScore.points, 1);
    });

    test('pergunta oculta bloqueia resposta de participantes', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Pergunta' });
      engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {});
      engine.applyAction(room, 'user_ana', 'dynamics:toggleQuestion', { visible: false });
      var state = engine.getState(room, 'user_bia');
      assert.equal(state.dynamics.question, null);
      assert.equal(state.dynamics.canAnswer, false);
      var blocked = engine.applyAction(room, 'user_bia', 'dynamics:answer', { text: 'Tentativa' });
      assert.ok(!blocked.ok);
      var orgView = engine.getState(room, 'user_ana');
      assert.equal(orgView.dynamics.question, 'Pergunta');
    });

    test('quem entra depois da votação é espectador', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Pergunta' });
      engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {});
      engine.applyAction(room, 'user_ana', 'dynamics:answer', { text: 'A' });
      engine.applyAction(room, 'user_bia', 'dynamics:answer', { text: 'B' });
      engine.applyAction(room, 'user_ana', 'dynamics:shuffle', {});
      engine.joinRoom(room, person('user_caio', 'Caio'));
      var late = engine.getState(room, 'user_caio');
      assert.equal(late.dynamics.isSpectator, true);
      assert.equal(late.dynamics.canVote, false);
      var blocked = engine.applyAction(room, 'user_caio', 'dynamics:assign', {
        answerId: late.dynamics.answers[0].id, targetUserId: 'user_ana'
      });
      assert.ok(!blocked.ok);
    });

    test('organizador remove participante antes do embaralhamento', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      engine.joinRoom(room, person('user_caio', 'Caio'));
      engine.applyAction(room, 'user_ana', 'dynamics:setQuestion', { text: 'Pergunta' });
      engine.applyAction(room, 'user_ana', 'dynamics:startCollecting', {});
      engine.applyAction(room, 'user_caio', 'dynamics:answer', { text: 'Resposta' });
      var kick = engine.applyAction(room, 'user_ana', 'room:kick', { userId: 'user_caio' });
      assert.ok(kick.ok);
      var state = engine.getState(room, 'user_ana');
      assert.equal(state.users.length, 2);
      assert.equal(state.dynamics.answers.length, 0);
      assert.equal(state.dynamics.participants.length, 2);
    });

    test('remover participante limpa joinhas e responsáveis', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_ana', 'card:add', { column: 'melhorias', text: 'Card da Ana' });
      engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'melhorias' });
      engine.applyAction(room, 'user_bia', 'card:like', { column: 'melhorias', cardId: add.event.cardId });
      engine.applyAction(room, 'user_ana', 'card:actionPlan', {
        cardId: add.event.cardId, text: 'Plano', assignees: ['user_bia']
      });

      var before = engine.getState(room, 'user_ana').melhorias.cards[0];
      assert.equal(before.likeCount, 1);
      assert.deepEqual(before.actionPlan.assignees, ['user_bia']);

      assert.ok(engine.applyAction(room, 'user_ana', 'room:kick', { userId: 'user_bia' }).ok);
      var after = engine.getState(room, 'user_ana').melhorias.cards[0];
      assert.equal(after.likeCount, 0);
      assert.deepEqual(after.actionPlan.assignees, []);
    });

    test('ações de organizador são protegidas', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      ['column:reveal', 'dynamics:shuffle', 'dynamics:endVoting', 'dynamics:revealNext', 'dynamics:reset'].forEach(function (type) {
        var result = engine.applyAction(room, 'user_bia', type, { column: 'acertos' });
        assert.ok(!result.ok, type + ' deveria falhar');
      });
    });

    test('administração remove o organizador e transfere a organização', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      assert.equal(room.organizerId, 'user_ana');

      var result = engine.adminRemoveUser(room, 'user_ana');
      assert.ok(result.ok);
      assert.equal(room.users.length, 1);
      assert.equal(room.organizerId, 'user_bia');
      assert.equal(engine.findUser(room, 'user_ana'), null);
      assert.equal(engine.getAdminState(room).users[0].name, 'Bia');
    });

    test('administração adiciona e edita cards sem revelar o bloco', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));

      var add = engine.adminAddCard(room, 'acertos', { text: 'Card da administração', authorId: 'user_bia' });
      assert.ok(add.ok);

      var adminView = engine.getAdminState(room);
      assert.equal(adminView.acertos.count, 1);
      assert.equal(adminView.acertos.cards[0].text, 'Card da administração');
      assert.equal(adminView.acertos.cards[0].authorName, 'Bia');
      assert.equal(adminView.acertos.revealed, false);

      var otherView = engine.getState(room, 'user_ana');
      assert.equal(otherView.acertos.cards[0].canRead, false);
      assert.equal(otherView.acertos.cards[0].authorId, undefined);

      var edited = engine.adminEditCard(room, 'acertos', add.cardId, 'Card revisado pela administração');
      assert.ok(edited.ok);
      assert.equal(engine.getAdminState(room).acertos.cards[0].text, 'Card revisado pela administração');

      var removed = engine.adminDeleteCard(room, 'acertos', add.cardId);
      assert.ok(removed.ok);
      assert.equal(engine.getAdminState(room).acertos.count, 0);
    });

    test('card criado pela administração pode ficar anônimo', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      var add = engine.adminAddCard(room, 'melhorias', { text: 'Sem autor' });
      assert.ok(add.ok);
      var card = engine.getAdminState(room).melhorias.cards[0];
      assert.equal(card.authorId, '');
      assert.equal(card.authorName, '');
    });

    test('organizador define o título da sala e todos o veem no estado', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));

      var denied = engine.applyAction(room, 'user_bia', 'room:setTitle', { title: 'Sala da Bia' });
      assert.ok(!denied.ok, 'participante não pode mudar o título');

      var set = engine.applyAction(room, 'user_ana', 'room:setTitle', { title: '  Retro   da sprint 42  ' });
      assert.ok(set.ok);
      assert.equal(set.event.kind, 'room-title-changed');
      assert.equal(engine.getState(room, 'user_ana').title, 'Retro da sprint 42');
      assert.equal(engine.getState(room, 'user_bia').title, 'Retro da sprint 42');
      assert.equal(engine.getAdminState(room).title, 'Retro da sprint 42');

      assert.ok(engine.applyAction(room, 'user_ana', 'room:setTitle', { title: '' }).ok);
      assert.equal(engine.getState(room, 'user_bia').title, '');
    });

    test('organizador oculta os blocos novamente sem apagar joinhas', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_ana', 'card:add', {
        column: 'acertos', text: 'Deploy sem sustos'
      });
      assert.ok(add.ok);
      assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'acertos' }).ok);
      assert.ok(engine.applyAction(room, 'user_bia', 'card:like', {
        column: 'acertos', cardId: add.event.cardId
      }).ok);

      assert.ok(!engine.applyAction(room, 'user_bia', 'column:hide', { column: 'acertos' }).ok);

      var hidden = engine.applyAction(room, 'user_ana', 'column:hide', { column: 'acertos' });
      assert.ok(hidden.ok);
      assert.equal(hidden.event.kind, 'column-hidden');
      var view = engine.getState(room, 'user_bia');
      assert.equal(view.acertos.revealed, false);
      assert.equal(view.acertos.canMerge, false);
      assert.equal(view.acertos.cards[0].canRead, false);
      assert.equal(view.acertos.cards[0].text, '');
      assert.equal(view.acertos.cards[0].likeCount, 1);
      assert.ok(!engine.applyAction(room, 'user_bia', 'card:like', {
        column: 'acertos', cardId: add.event.cardId
      }).ok);

      assert.ok(engine.applyAction(room, 'user_ana', 'column:reveal', { column: 'acertos' }).ok);
      assert.equal(engine.getState(room, 'user_bia').acertos.cards[0].text, 'Deploy sem sustos');
    });

    test('participante edita nome e avatar dentro da sala', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var avatar = { kind: 'emoji', value: '🐼', bg: 'linear-gradient(135deg,#5ce1ff,#2563eb)' };

      var updated = engine.applyAction(room, 'user_bia', 'room:updateProfile', {
        name: '  Bia   Souza ', avatar: avatar, userId: 'user_ana'
      });
      assert.ok(updated.ok);
      assert.equal(updated.event.kind, 'profile-updated');
      var state = engine.getState(room, 'user_bia');
      assert.equal(state.users[1].name, 'Bia Souza');
      assert.equal(state.users[1].avatar.value, '🐼');
      assert.equal(state.users[0].name, 'Ana', 'o payload não pode alterar outra pessoa');
      assert.equal(engine.getState(room, 'user_ana').users[1].name, 'Bia Souza');

      var invalid = engine.applyAction(room, 'user_bia', 'room:updateProfile', { name: '   ' });
      assert.ok(!invalid.ok);
    });

    return results;
  }

  return { run: run };
});
