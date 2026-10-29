/* Retro Special — tela inicial: identidade, criar sala, entrar com código */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var ui = Retro.ui;
  var identity = Retro.identity;

  var els = {};
  var initialized = false;
  var pendingCode = null;

  function cache() {
    els.stepIdentity = document.getElementById('step-identity');
    els.stepLobby = document.getElementById('step-lobby');
    els.nameInput = document.getElementById('name-input');
    els.avatarPreview = document.getElementById('avatar-preview');
    els.avatarPreviewInner = document.getElementById('avatar-preview-inner');
    els.avatarOptions = document.getElementById('avatar-options');
    els.uploadPhotoBtn = document.getElementById('upload-photo-btn');
    els.photoInput = document.getElementById('photo-input');
    els.identityContinue = document.getElementById('identity-continue');
    els.continueLabel = document.getElementById('continue-label');
    els.identityWindowNote = document.getElementById('identity-window-note');
    els.changeIdentity = document.getElementById('change-identity');
    els.newPerson = document.getElementById('new-person');
    els.createRoomBtn = document.getElementById('create-room-btn');
    els.joinForm = document.getElementById('join-form');
    els.joinSubmit = document.getElementById('join-submit');
    els.roomCodeInput = document.getElementById('room-code-input');
    els.joinError = document.getElementById('join-error');
    els.lobbyWho = document.getElementById('lobby-who');
    els.inviteBanner = document.getElementById('invite-banner');
    els.inviteCode = document.getElementById('invite-code');
    els.lobbyInvite = document.getElementById('lobby-invite');
    els.lobbyInviteCode = document.getElementById('lobby-invite-code');
    els.demoChip = document.getElementById('demo-chip');
    els.demoNote = document.getElementById('demo-note');
  }

  function setStep(step) {
    els.stepIdentity.hidden = step !== 'identity';
    els.stepLobby.hidden = step !== 'lobby';
  }

  function renderAvatar(identityValue) {
    var value = identityValue || identity.load();
    els.avatarPreviewInner.innerHTML = ui.avatarHTML(value.avatar, { size: 92 });
    if (els.nameInput && document.activeElement !== els.nameInput) {
      els.nameInput.value = value.name || '';
    }
    renderAvatarOptions(value);
  }

  function renderAvatarOptions(value) {
    var selectedEmoji = value.avatar && value.avatar.kind === 'emoji' ? value.avatar.value : null;
    els.avatarOptions.innerHTML = identity.listEmojis().map(function (item) {
      var selected = selectedEmoji === item.emoji;
      return '<button class="avatar-option' + (selected ? ' is-selected' : '') + '" type="button" role="option" ' +
        'aria-selected="' + (selected ? 'true' : 'false') + '" data-emoji-index="' + item.index + '" ' +
        'title="Escolher ' + ui.esc(item.emoji) + '">' +
        ui.avatarHTML(item.avatar, { size: 31 }) +
        '</button>';
    }).join('');
  }

  function renderLobby(value) {
    els.lobbyWho.innerHTML =
      ui.avatarHTML(value.avatar, { size: 30 }) +
      '<span class="person-name">Oi, <b>' + ui.esc(value.name || 'pessoa') + '</b>!</span>';

    els.inviteBanner.hidden = !pendingCode;
    els.lobbyInvite.hidden = !pendingCode;
    if (pendingCode) {
      els.inviteCode.textContent = pendingCode;
      els.lobbyInviteCode.textContent = pendingCode;
      els.lobbyInvite.hidden = false;
    }
    els.demoChip.hidden = !Retro.env.demo;
    els.demoNote.hidden = !Retro.env.demo;
  }

  function showIdentityStep(focus) {
    var value = identity.load();
    renderAvatar(value);
    setStep('identity');
    els.identityWindowNote.hidden = !(!identity.isActive() && identity.hasSavedProfile());
    els.inviteBanner.hidden = !pendingCode;
    if (pendingCode) els.inviteCode.textContent = pendingCode;
    if (focus) {
      setTimeout(function () { els.nameInput.focus(); }, 40);
    }
  }

  function showLobbyStep() {
    var value = identity.load();
    setStep('lobby');
    renderLobby(value);
    els.joinError.hidden = true;
    els.roomCodeInput.value = pendingCode || els.roomCodeInput.value || '';
  }

  function continueFromIdentity() {
    var name = els.nameInput.value.replace(/\s+/g, ' ').trim();
    if (!name) {
      els.nameInput.focus();
      els.nameInput.style.borderColor = 'rgba(255,107,107,.7)';
      ui.toast('Como podemos te chamar? Escreva seu nome.', 'error');
      setTimeout(function () { els.nameInput.style.borderColor = ''; }, 1600);
      return;
    }
    identity.setName(name);
    els.nameInput.value = name;
    if (pendingCode) {
      Retro.app.goRoom(pendingCode);
      return;
    }
    showLobbyStep();
  }

  function withBusy(button, label, task) {
    var original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    return Promise.resolve()
      .then(task)
      .finally(function () {
        button.disabled = false;
        button.textContent = original;
      });
  }

  function createRoom() {
    if (els.createRoomBtn.disabled) return;
    var value = identity.load();
    if (!value.name) {
      showIdentityStep(true);
      ui.toast('Primeiro, se apresente.', 'error');
      return;
    }
    withBusy(els.createRoomBtn, 'Criando sala…', function () {
      return Retro.api.createRoom(identity.identityForServer()).then(function (result) {
        Retro.app.goRoom(result.code, result.state);
      }).catch(function (error) {
        ui.toast(error.message || 'Não consegui criar a sala.', 'error');
      });
    });
  }

  function joinRoom(event) {
    if (event) event.preventDefault();
    var code = ui.normalizeCode(els.roomCodeInput.value);
    els.joinError.hidden = true;
    if (code.length < 4) {
      els.joinError.hidden = false;
      els.joinError.textContent = 'Digite o código da sala (ex.: ABC123).';
      els.roomCodeInput.focus();
      return;
    }
    var value = identity.load();
    if (!value.name) {
      showIdentityStep(true);
      ui.toast('Primeiro, se apresente.', 'error');
      return;
    }
    if (els.joinSubmit.disabled) return;
    withBusy(els.joinSubmit, 'Entrando…', function () {
      return Retro.api.joinRoom(code, identity.identityForServer()).then(function (result) {
        Retro.app.goRoom(code, result.state);
      }).catch(function (error) {
        els.joinError.hidden = false;
        els.joinError.textContent = error.message || 'Não consegui entrar nessa sala.';
      });
    });
  }

  function handlePhoto(file) {
    identity.readPhoto(file).then(function (avatar) {
      identity.setAvatar(avatar);
      renderAvatar();
      ui.toast('Foto atualizada!', 'success');
    }).catch(function (error) {
      ui.toast(error.message || 'Não consegui usar essa foto.', 'error');
    });
  }

  function bind() {
    els.nameInput.addEventListener('input', function () {
      identity.setName(els.nameInput.value);
      els.nameInput.style.borderColor = '';
      if (!els.stepLobby.hidden) renderLobby(identity.load());
    });

    els.nameInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        continueFromIdentity();
      }
    });

    els.avatarOptions.addEventListener('click', function (event) {
      var option = event.target.closest('[data-emoji-index]');
      if (!option) return;
      identity.setEmoji(Number(option.getAttribute('data-emoji-index')));
      renderAvatar();
    });

    els.avatarPreview.addEventListener('click', function () {
      els.photoInput.click();
    });

    els.uploadPhotoBtn.addEventListener('click', function () {
      els.photoInput.click();
    });

    els.photoInput.addEventListener('change', function () {
      var file = els.photoInput.files && els.photoInput.files[0];
      els.photoInput.value = '';
      if (file) handlePhoto(file);
    });

    els.identityContinue.addEventListener('click', continueFromIdentity);

    els.changeIdentity.addEventListener('click', function () {
      showIdentityStep(true);
    });

    els.newPerson.addEventListener('click', function () {
      identity.startNewPerson();
      showIdentityStep(true);
      ui.toast('Esta janela agora é outra pessoa. As outras janelas não mudam.', 'success');
    });

    els.createRoomBtn.addEventListener('click', createRoom);
    els.joinForm.addEventListener('submit', joinRoom);

    els.roomCodeInput.addEventListener('input', function () {
      var normalized = ui.normalizeCode(els.roomCodeInput.value);
      if (els.roomCodeInput.value !== normalized) els.roomCodeInput.value = normalized;
      els.joinError.hidden = true;
    });

    els.roomCodeInput.addEventListener('paste', function () {
      setTimeout(function () {
        els.roomCodeInput.value = ui.normalizeCode(els.roomCodeInput.value);
      }, 0);
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    cache();
    bind();
    var value = identity.load();
    renderAvatar(value);
    els.nameInput.value = value.name || '';
  }

  function render(options) {
    options = options || {};
    init();
    var value = identity.load();
    pendingCode = options.inviteCode ? ui.normalizeCode(options.inviteCode) : null;

    renderAvatar(value);
    if (options.prefillCode) {
      els.roomCodeInput.value = ui.normalizeCode(options.prefillCode);
    }
    els.joinError.hidden = true;
    els.inviteBanner.hidden = !pendingCode;
    els.lobbyInvite.hidden = !pendingCode;
    if (pendingCode) {
      els.inviteCode.textContent = pendingCode;
      els.lobbyInviteCode.textContent = pendingCode;
    }

    if (value.name && identity.isActive()) {
      showLobbyStep();
    } else {
      showIdentityStep(false);
    }

    els.demoChip.hidden = !Retro.env.demo;
    els.demoNote.hidden = !Retro.env.demo;

    if (options.error) ui.toast(options.error, 'error');
  }

  Retro.home = {
    init: init,
    render: render,
    getPendingCode: function () { return pendingCode; }
  };
}());
