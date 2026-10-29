/* Retro Special — utilitários de interface */
(function () {
  'use strict';

  window.Retro = window.Retro || {};

  var PHOTO_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
  var BG_RE = /^linear-gradient\([#a-zA-Z0-9(),.%\s-]+\)$/;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safePhoto(value) {
    return typeof value === 'string' && PHOTO_RE.test(value) ? value : null;
  }

  function safeBg(value) {
    return typeof value === 'string' && BG_RE.test(value)
      ? value
      : 'linear-gradient(135deg,#ff7ab6,#7b2cff)';
  }

  /**
   * Gera o HTML de um avatar.
   * opts: { size, className, ring, title }
   */
  function avatarHTML(avatar, opts) {
    opts = opts || {};
    var size = Number(opts.size) || 40;
    var className = opts.className ? ' ' + opts.className : '';
    var style = '--size:' + size + 'px;';
    if (opts.ring) {
      style += '--ring:' + esc(opts.ring) + ';';
      className += ' has-ring';
    }
    var title = opts.title ? ' title="' + esc(opts.title) + '"' : '';
    var photo = avatar && avatar.kind === 'photo' ? safePhoto(avatar.value) : null;
    if (photo) {
      return '<span class="avatar' + className + '" style="' + style + '" aria-hidden="true"' + title + '>' +
        '<img src="' + photo + '" alt="">' +
        '</span>';
    }
    var emoji = avatar && typeof avatar.value === 'string' && avatar.value.trim()
      ? avatar.value.trim().slice(0, 16)
      : '🦊';
    var bg = safeBg(avatar && avatar.bg);
    return '<span class="avatar' + className + '" style="' + style + '--avatar-bg:' + bg + ';" aria-hidden="true"' + title + '>' +
      '<span class="avatar-emoji">' + esc(emoji) + '</span>' +
      '</span>';
  }

  function userAvatar(user, opts) {
    opts = opts || {};
    if (!user) return avatarHTML({ kind: 'emoji', value: '👤' }, opts);
    return avatarHTML(user.avatar, {
      size: opts.size,
      className: opts.className,
      title: opts.title || user.name,
      ring: opts.ring === false ? null : (opts.ring || (user.connected === false ? null : user.color))
    });
  }

  function toast(message, type) {
    var stack = document.getElementById('toast-stack');
    if (!stack) return;
    var node = document.createElement('div');
    node.className = 'toast' + (type ? ' ' + type : '');
    node.textContent = message;
    stack.appendChild(node);
    var timeout = type === 'error' ? 5000 : 3400;
    var removeTimer = setTimeout(function () {
      node.classList.add('leaving');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 250);
    }, timeout);
    return function dismiss() {
      clearTimeout(removeTimer);
      if (node.parentNode) node.parentNode.removeChild(node);
    };
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '-9999px';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------- modal ------------------------------- */

  var modalEls = null;
  var confirmResolver = null;
  var modalInitialized = false;

  function initModal() {
    if (modalInitialized) return;
    modalInitialized = true;
    modalEls = {
      backdrop: document.getElementById('modal-backdrop'),
      modal: document.getElementById('modal'),
      title: document.getElementById('modal-title'),
      body: document.getElementById('modal-body'),
      close: document.getElementById('modal-close')
    };
    if (!modalEls.backdrop) return;

    modalEls.close.addEventListener('click', function () { closeModal(false); });
    modalEls.backdrop.addEventListener('mousedown', function (event) {
      if (event.target === modalEls.backdrop) closeModal(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modalEls.backdrop.hidden) closeModal(false);
    });
  }

  function openModal(title, bodyHTML) {
    initModal();
    if (!modalEls || !modalEls.backdrop) return null;
    modalEls.title.textContent = title || '';
    modalEls.body.innerHTML = bodyHTML || '';
    modalEls.backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(function () {
      var focusable = modalEls.modal.querySelector('textarea, input, button:not(.modal-close)');
      if (focusable) focusable.focus();
    }, 40);
    return modalEls.body;
  }

  function closeModal(result) {
    initModal();
    if (!modalEls || !modalEls.backdrop) return;
    var wasOpen = !modalEls.backdrop.hidden;
    modalEls.backdrop.hidden = true;
    modalEls.body.innerHTML = '';
    document.body.classList.remove('no-scroll');
    if (wasOpen && confirmResolver) {
      var resolve = confirmResolver;
      confirmResolver = null;
      resolve(result === true);
    }
  }

  function confirmDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      confirmResolver = resolve;
      var confirmLabel = options.confirmLabel || 'Confirmar';
      var body = '<p>' + esc(options.message || '') + '</p>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-ghost" type="button" data-confirm-cancel>Cancelar</button>' +
        '<button class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + '" type="button" data-confirm-yes>' + esc(confirmLabel) + '</button>' +
        '</div>';
      var root = openModal(options.title || 'Tem certeza?', body);
      if (!root) {
        confirmResolver = null;
        resolve(false);
        return;
      }
      var yes = root.querySelector('[data-confirm-yes]');
      var cancel = root.querySelector('[data-confirm-cancel]');
      if (yes) yes.addEventListener('click', function () { closeModal(true); });
      if (cancel) cancel.addEventListener('click', function () { closeModal(false); });
    });
  }

  /* ----------------------------- utilidades ---------------------------- */

  function captureFocus(root) {
    var active = document.activeElement;
    if (!active || !root || !root.contains(active)) return null;
    var snapshot = {
      id: active.id,
      tag: active.tagName,
      start: null,
      end: null
    };
    try {
      if (typeof active.selectionStart === 'number') {
        snapshot.start = active.selectionStart;
        snapshot.end = active.selectionEnd;
      }
    } catch (error) { /* campos sem seleção */ }
    return snapshot;
  }

  function restoreFocus(root, snapshot) {
    if (!snapshot || !root) return;
    var target = snapshot.id ? document.getElementById(snapshot.id) : null;
    if (!target || !root.contains(target)) return;
    try {
      target.focus({ preventScroll: true });
      if (snapshot.start != null && typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(snapshot.start, snapshot.end);
      }
    } catch (error) { /* noop */ }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }

  function plural(count, singular, pluralForm) {
    return count === 1 ? singular : (pluralForm || singular + 's');
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {
      return false;
    }
  }

  Retro.ui = {
    $: $,
    $$: $$,
    esc: esc,
    avatarHTML: avatarHTML,
    userAvatar: userAvatar,
    safePhoto: safePhoto,
    safeBg: safeBg,
    toast: toast,
    copyText: copyText,
    initModal: initModal,
    openModal: openModal,
    closeModal: closeModal,
    confirmDialog: confirmDialog,
    captureFocus: captureFocus,
    restoreFocus: restoreFocus,
    debounce: debounce,
    clamp: clamp,
    normalizeCode: normalizeCode,
    plural: plural,
    prefersReducedMotion: prefersReducedMotion
  };
}());
