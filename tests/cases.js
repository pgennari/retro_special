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

    test('cards ficam ocultos para os outros até a revelação', function () {
      var room = engine.createRoom(person('user_ana', 'Ana'));
      engine.joinRoom(room, person('user_bia', 'Bia'));
      var add = engine.applyAction(room, 'user_ana', 'card:add', { column: 'acertos', text: 'Deploy sem sustos' });
      assert.ok(add.ok);

      var biaView = engine.getState(room, 'user_bia');
      assert.equal(biaView.acertos.cards.length, 1);
      assert.equal(biaView.acertos.cards[0].canRead, false);
      assert.equal(biaView.acertos.cards[0].authorId, undefined);
      assert.equal(biaView.acertos.revealed, false);

      var anaView = engine.getState(room, 'user_ana');
      assert.equal(anaView.acertos.cards[0].canRead, true);

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

    return results;
  }

  return { run: run };
});
