/* Retro Special — bootstrap e rotas (hash) */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var ui = Retro.ui;
  var identity = Retro.identity;

  var params = new URLSearchParams(window.location.search);
  var demo = window.location.protocol === 'file:' || params.get('demo') === '1';

  Retro.env = {
    demo: demo,
    protocol: window.location.protocol
  };

  var homeView = null;
  var roomView = null;
  var pendingState = null;
  var initialized = false;

  function parseRoute() {
    var hash = window.location.hash || '';
    var match = hash.match(/^#\/?sala\/([A-Za-z0-9]{4,8})/i);
    if (match) return ui.normalizeCode(match[1]);
    var search = new URLSearchParams(window.location.search);
    var queryCode = search.get('sala') || search.get('room');
    if (queryCode) return ui.normalizeCode(queryCode);
    return null;
  }

  function setView(name) {
    homeView.hidden = name !== 'home';
    roomView.hidden = name !== 'room';
    document.body.setAttribute('data-view', name);
  }

  function titleForRoom(code) {
    return 'Sala ' + code + ' — Retro Special';
  }

  function route() {
    if (!initialized) return;
    var code = parseRoute();
    if (code) {
      var current = identity.load();
      if (!current.name) {
        setView('home');
        document.title = 'Retro Special — retrospectiva de sprint';
        Retro.home.render({ inviteCode: code });
        return;
      }
      setView('room');
      document.title = titleForRoom(code);
      var initialState = null;
      if (pendingState && pendingState.code === code) {
        initialState = pendingState.state;
      }
      pendingState = null;
      Retro.room.open(code, initialState);
      return;
    }

    Retro.room.close();
    setView('home');
    Retro.home.render();
    document.title = 'Retro Special — retrospectiva de sprint';
  }

  function goRoom(code, initialState) {
    code = ui.normalizeCode(code);
    if (!code) return;
    pendingState = initialState ? { code: code, state: initialState } : null;
    var target = '#/sala/' + code;
    if (window.location.hash === target) {
      setView('room');
      document.title = titleForRoom(code);
      var initial = pendingState ? pendingState.state : null;
      pendingState = null;
      Retro.room.open(code, initial);
    } else {
      window.location.hash = target;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function goHome(options) {
    Retro.room.close();
    setView('home');
    if (window.location.hash || params.get('sala') || params.get('room')) {
      try {
        var url = new URL(window.location.href);
        url.hash = '';
        url.searchParams.delete('sala');
        url.searchParams.delete('room');
        history.replaceState(null, '', url.pathname + url.search);
      } catch (error) {
        history.replaceState(null, '', window.location.pathname);
      }
    }
    Retro.home.render(options || {});
    document.title = 'Retro Special — retrospectiva de sprint';
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function shareURL(code) {
    var url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('sala');
    url.searchParams.delete('room');
    if (Retro.env.demo) {
      url.searchParams.set('demo', '1');
    } else {
      url.searchParams.delete('demo');
      if (/\/index\.html$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/index\.html$/i, '');
      }
    }
    return url.toString().replace(/#$/, '') + '#/sala/' + code;
  }

  function bind() {
    document.addEventListener('click', function (event) {
      var homeLink = event.target.closest('[data-home-link]');
      if (!homeLink) return;
      event.preventDefault();
      goHome();
    });

    window.addEventListener('hashchange', route);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    homeView = document.getElementById('home-view');
    roomView = document.getElementById('room-view');
    ui.initModal();
    identity.load();
    Retro.home.init();
    bind();
    route();
  }

  Retro.app = {
    goRoom: goRoom,
    goHome: goHome,
    route: route,
    shareURL: shareURL
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
