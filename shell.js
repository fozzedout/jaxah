/* Airis OS — shell. One static page owns all OS chrome: Halo, Whisper
   Strip, Summon, taskbar/dock, window manager, routing, and the shared room:
   install records, the app bridge, the action registry and the trail.
   The standalone terminal.js owns the fallback, including shell error recovery.
   Rules come from airis.contract.json (fetched at boot); the catalogue is
   manifest.json; what runs is the install record in localStorage. Apps run in
   opaque-origin sandboxed iframes (contract.sandbox.iframe, never
   allow-same-origin) and reach privileges only through the bridge. */
(function () {
'use strict';

/* ── tiny helpers ─────────────────────────────────────────────────────── */
var $ = function (id) { return document.getElementById(id); };
var osEl = $('os'), floor = window.AirisTerminal,
    grid = $('icon-grid'), wins = $('windows'),
    taskApps = $('task-apps'), dockApps = $('dock-apps'),
    halo = $('halo'), whisper = $('whisper'),
    wWhy = $('whisper-why'), wText = $('whisper-text'),
    summon = $('summon'), summonIn = $('summon-in'), summonOut = $('summon-out');

var isPhone = function () {
  return window.matchMedia('(max-width: 767.98px)').matches;
};
var esc = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};

var APPS = [];          // normalised manifest entries
var byId = {};          // id -> entry
var openWins = {};      // id -> .window element
var zTop = 10, cascade = 0;
var booted = false;

/* Probe env() directly: the CSS-variable bridge has WebKit bugs 274773 / 191872
   and can return stale or zero values. This optional block must never break boot. */
(function () {
  try {
    var lastInsets = {}, resizePending = false, settleTimer = null;
    function measureEnv(prop) {
      var probe;
      try {
        probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(' + prop + ', 0px)';
        (document.documentElement || document.body).appendChild(probe);
        return probe.offsetHeight;
      } catch (e) { return 0; }
      finally { try { if (probe && probe.parentNode) probe.parentNode.removeChild(probe); } catch (e) {} }
    }
    function updateInsets(reason) {
      try {
        var next = { reason: reason };
        ['top', 'right', 'bottom', 'left'].forEach(function (side) {
          try {
            var value = measureEnv('safe-area-inset-' + side);
            next[side] = value;
            document.documentElement.style.setProperty('--sa' + side.charAt(0), value + 'px');
          } catch (e) {}
        });
        lastInsets = next;
      } catch (e) {}
    }
    updateInsets('init');
    [100, 500, 1000].forEach(function (delay) {
      try { setTimeout(function () { try { updateInsets('init-' + delay); } catch (e) {} }, delay); } catch (e) {}
    });
    window.addEventListener('resize', function () {
      try {
        if (resizePending) return;
        resizePending = true;
        requestAnimationFrame(function () {
          try {
            resizePending = false;
            updateInsets('resize'); // window re-clamping is the stage ResizeObserver's job
          } catch (e) { resizePending = false; }
        });
      } catch (e) { resizePending = false; }
    });
    window.addEventListener('orientationchange', function () {
      try {
        setTimeout(function () { try { updateInsets('orientationchange'); } catch (e) {} }, 300);
        if (settleTimer) clearInterval(settleTimer);
        var started = Date.now();
        settleTimer = setInterval(function () {
          try {
            var orientation = window.screen && window.screen.orientation;
            var landscape = orientation && orientation.type ? orientation.type.indexOf('landscape') === 0 : Math.abs(window.orientation) === 90;
            if ((window.innerWidth > window.innerHeight) === landscape || Date.now() - started >= 2000) {
              clearInterval(settleTimer); settleTimer = null;
              updateInsets('orientation-settled');
            }
          } catch (e) { try { clearInterval(settleTimer); settleTimer = null; } catch (ignored) {} }
        }, 100);
      } catch (e) {}
    });
    if (window.navigator.standalone === true) {
      var viewport = document.querySelector('meta[name="viewport"]');
      if (viewport) {
        var original = viewport.getAttribute('content'), scheduled = false;
        try {
          viewport.setAttribute('content', original.replace('viewport-fit=cover', 'viewport-fit=auto'));
          requestAnimationFrame(function () {
            try {
              try { viewport.setAttribute('content', original); }
              finally { requestAnimationFrame(function () { try { updateInsets('standalone-cold-start'); } catch (e) {} }); }
            } catch (e) { try { viewport.setAttribute('content', original); } catch (ignored) {} }
          });
          scheduled = true;
        } finally { if (!scheduled) viewport.setAttribute('content', original); }
      }
    }
  } catch (e) {}
})();

/* The shell enforces a default layout per app, so an app can't forget a
   mode: whatever the manifest omits, normaliseApp() fills in. */
function normaliseApp(a) {
  if (!a || typeof a.id !== 'string' || !a.id || typeof a.url !== 'string' || !a.url) {
    throw new Error('manifest app needs an id and URL');
  }
  a = Object.assign({}, a);
  a.name = a.name || a.title || a.id;
  a.title = a.title || a.name;
  a.icon = a.icon || '▢';
  a.size = a.size || 'window';            // small | window | full
  a.launch = a.launch || 'auto';         // auto | window | sheet | standalone
  a.desktop = a.desktop || {};
  a.phone = a.phone || {};
  if (!a.desktop.slot) a.desktop.slot = 'window';
  if (!a.phone.slot) a.phone.slot = 'sheet';
  if (a.launch !== 'standalone') a.launch = 'auto';
  return a;
}

/* ── Window geometry persistence ────────────────────────────────────────
   Positions AND sizes survive refresh/relaunch. One localStorage entry:
   { open: [ids in focus order], geo: { id: {l,t,w,h,max} } }.
   Geometry is kept when a window closes, so reopening restores it. */
var WIN_STORE = 'airis-os.windows.v1';
var savedWins = { open: [], geo: {} };
/* Focus order (most-recent-last) drives restore z-order; it is tracked
   live in focusWin/closeApp so the foremost window survives refresh. */
var focusOrder = [];
function validGeoRec(g) {
  return !!g && typeof g === 'object' && !Array.isArray(g) &&
    Number.isFinite(+g.l) && Number.isFinite(+g.t) &&
    Number.isFinite(+g.w) && Number.isFinite(+g.h);
}
try {
  var rawWins = localStorage.getItem(WIN_STORE);
  if (rawWins) {
    var parsed = JSON.parse(rawWins);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      var cleanOpen = Array.isArray(parsed.open)
        ? parsed.open.filter(function (id) { return typeof id === 'string'; })
        : [];
      var geoSrc = (parsed.geo && typeof parsed.geo === 'object' && !Array.isArray(parsed.geo))
        ? parsed.geo : {};
      var cleanGeo = {};
      Object.keys(geoSrc).forEach(function (k) {
        if (validGeoRec(geoSrc[k])) {
          cleanGeo[k] = {
            l: +geoSrc[k].l, t: +geoSrc[k].t,
            w: +geoSrc[k].w, h: +geoSrc[k].h,
            max: !!geoSrc[k].max
          };
        }
      });
      savedWins = { open: cleanOpen, geo: cleanGeo };
    }
  }
} catch (e) {}
focusOrder = savedWins.open.slice();
function saveWins() {
  try {
    if (!savedWins.geo || typeof savedWins.geo !== 'object' || Array.isArray(savedWins.geo)) savedWins.geo = {};
    savedWins.open = focusOrder.filter(function (id) { return !!openWins[id]; });
    localStorage.setItem(WIN_STORE, JSON.stringify(savedWins));
  } catch (e) {}
}
function recordWinGeo(id) {
  var el = openWins[id];
  if (!el || isPhone()) return;
  if (!savedWins.geo || typeof savedWins.geo !== 'object' || Array.isArray(savedWins.geo)) savedWins.geo = {};
  savedWins.geo[id] = {
    l: parseFloat(el.style.left) || WINDOW_MARGIN,
    t: parseFloat(el.style.top) || WINDOW_MARGIN,
    w: parseFloat(el.style.width) || el.getBoundingClientRect().width,
    h: parseFloat(el.style.height) || el.getBoundingClientRect().height,
    max: el.classList.contains('max')
  };
  saveWins();
}

/* ── clock ────────────────────────────────────────────────────────────── */
function tickClock() {
  var d = new Date();
  var s = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var a = $('sb-time'), b = $('tb-clock');
  if (a) a.textContent = s;
  if (b) b.textContent = s;
}
setInterval(tickClock, 10000); tickClock();

/* ── theme (persisted, both layouts) ──────────────────────────────────── */
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('airis-os.theme', t); } catch (e) {}
  if (typeof broadcast === 'function') broadcast({ event: 'theme', theme: t });
}
try {
  var savedTheme = localStorage.getItem('airis-os.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
} catch (e) {}
function toggleTheme() {
  act('theme', { value: document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light' }, 'human');
}
$('sb-theme').addEventListener('click', toggleTheme);
$('tb-clock').addEventListener('click', toggleTheme);

/* ── Halo: a single breathing glyph. It carries no state colour — presence
   lives in the three switchable treatments (bob / portrait / orb). This
   stub stays because open/close paths call it. ───────────────────────── */
function setHalo(state) {
  if (halo) halo.className = 'prompt-dot';
  osEl.setAttribute('data-presence', state || 'calm');
}

/* ── Whisper Strip: one line, fades if ignored ────────────────────────── */
var whisperTimer = null;
function whisperSay(text, why) {
  wText.textContent = text;
  wWhy.textContent = why || 'airis';
  whisper.hidden = false;
  whisper.classList.remove('fade');
  clearTimeout(whisperTimer);
  whisperTimer = setTimeout(function () {
    whisper.classList.add('fade');
    setTimeout(function () { whisper.hidden = true; }, 1300);
  }, 8000);
}
$('whisper-x').addEventListener('click', function () {
  clearTimeout(whisperTimer);
  whisper.hidden = true;
});
whisper.addEventListener('click', function (e) {
  if (e.target.id !== 'whisper-x') { clearTimeout(whisperTimer); whisper.hidden = true; }
});

/* The floor owns its input, keyboard door, routing, and failure guards.
   Shell shortcuts only apply while the shell is visible. */
document.addEventListener('keydown', function (e) {
  if (osEl.hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    summon.hidden ? openSummon() : closeSummon();
  }
  if (e.key === 'Escape' && !summon.hidden) closeSummon();
});

/* ── window manager (desktop) / sheet (phone) ─────────────────────────── */
var WINDOW_MARGIN = 10; // Matches .window.max's inset; keeps apps clear of the taskbar/Halo.

function sizeFor(app) {
  var vw = wins.clientWidth, vh = wins.clientHeight;
  var maxW = Math.max(0, vw - WINDOW_MARGIN * 2);
  var maxH = Math.max(0, vh - WINDOW_MARGIN * 2);
  var w, h;
  if (app.size === 'small') { w = 480; h = 560; }
  else if (app.size === 'full') { w = maxW; h = maxH; }
  else { // "window"
    var dw = app.desktop.width || 920, dh = app.desktop.height || 620;
    w = vw >= 1024 ? dw : Math.min(dw, vw - 40);
    h = Math.min(dh, vh - 140);
  }
  return { w: Math.min(maxW, Math.max(300, w)), h: Math.min(maxH, Math.max(220, h)) };
}

function fitWin(el, app) {
  if (isPhone() || app.size === 'full') return;
  // #windows ends at the taskbar's top edge. Fit the whole window, not
  // just its title bar, so the prompt marker below it remains clear.
  var s = sizeFor(app);
  var left = parseFloat(el.style.left) || WINDOW_MARGIN;
  var top = parseFloat(el.style.top) || WINDOW_MARGIN;
  el.style.width = s.w + 'px';
  el.style.height = s.h + 'px';
  el.style.left = Math.max(WINDOW_MARGIN, Math.min(left, wins.clientWidth - s.w - WINDOW_MARGIN)) + 'px';
  el.style.top = Math.max(WINDOW_MARGIN, Math.min(top, wins.clientHeight - s.h - WINDOW_MARGIN)) + 'px';
}

/* Clamp the window's current geometry into the stage without forcing the
   default size — user resizes survive viewport changes. Windows created
   on phone sheets carry no desktop geometry (phone CSS forces fullscreen
   via !important), so the first desktop clamp gives them a real default
   size instead of preserving their tiny intrinsic box. */
function clampWin(el) {
  if (isPhone() || el.classList.contains('max')) return;
  var appForEl = el.dataset && el.dataset.appId ? byId[el.dataset.appId] : null;
  if (appForEl && appForEl.size !== 'full' && !el.style.width && !el.style.height) {
    fitWin(el, appForEl);
    return;
  }
  var w = parseFloat(el.style.width) || el.getBoundingClientRect().width;
  var h = parseFloat(el.style.height) || el.getBoundingClientRect().height;
  var left = parseFloat(el.style.left) || WINDOW_MARGIN;
  var top = parseFloat(el.style.top) || WINDOW_MARGIN;
  el.style.width = Math.min(wins.clientWidth - WINDOW_MARGIN * 2, Math.max(300, w)) + 'px';
  el.style.height = Math.min(wins.clientHeight - WINDOW_MARGIN * 2, Math.max(220, h)) + 'px';
  el.style.left = Math.max(WINDOW_MARGIN, Math.min(left, wins.clientWidth - w - WINDOW_MARGIN)) + 'px';
  el.style.top = Math.max(WINDOW_MARGIN, Math.min(top, wins.clientHeight - h - WINDOW_MARGIN)) + 'px';
}

// Also refit after returning from the hidden terminal, and include minimised
// windows so restoring one after a resize cannot bring back stale geometry.
new ResizeObserver(function () {
  if (!wins.clientWidth || !wins.clientHeight) return;
  Object.keys(openWins).forEach(function (id) { clampWin(openWins[id]); });
}).observe(wins);

function focusWin(id) {
  focusOrder = focusOrder.filter(function (k) { return k !== id && !!openWins[k]; });
  if (openWins[id]) focusOrder.push(id);
  Object.keys(openWins).forEach(function (k) {
    openWins[k].style.zIndex = k === id ? ++zTop : openWins[k].style.zIndex;
    openWins[k].classList.toggle('focused', k === id);
  });
  refreshTasks();
  saveWins(); // focus order is the restore order
  if (openWins[id] && location.hash !== '#app/' + id) history.replaceState(null, '', '#app/' + id);
}

function openApp(id) {
  var app = byId[id];
  if (!app) { floor.show('no such app: ' + id); return; }
  if (app.launch === 'standalone') {
    var opened = window.open('', '_blank');
    if (opened) { opened.opener = null; opened.location.replace(app.url); }
    else location.assign(app.url);
    return 'opened standalone in a new tab';
  }
  if (openWins[id]) {
    openWins[id].classList.remove('min');
    focusWin(id);
    return;
  }
  // Phone: one app at a time — opening one closes the others.
  if (isPhone()) {
    Object.keys(openWins).forEach(closeApp);
  }

  var el = document.createElement('div');
  el.className = 'window' + (app.size === 'full' ? ' max' : '');
  el.dataset.appId = id;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', app.name);

  var title = document.createElement('div');
  title.className = 'w-title';
  var rec = installs.records[id];
  var external = !(rec && typeof rec.code === 'string');
  title.innerHTML =
    '<span>' + esc(app.icon) + '</span>' +
    '<span class="w-name">' + esc(app.name) + '</span>' +
    '<span class="w-btns">' +
    (external ? '<a class="w-ext" title="open standalone" aria-label="open standalone" href="' + esc(app.url) + '" target="_blank" rel="noopener">↗</a>' : '') +
    '<button class="w-min" title="minimise" aria-label="minimise">–</button>' +
    '<button class="w-max" title="maximise" aria-label="maximise">☐</button>' +
    '<button class="w-close" title="close" aria-label="close">×</button>' +
    '</span>';
  el.appendChild(title);

  // Opaque-origin sandbox: scripts run, but the frame gets no origin —
  // no shell DOM, no shell storage, no sibling frames, no top navigation.
  // The install record is what runs: code records as srcdoc, link records by URL.
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', CONTRACT.sandbox.iframe);
  frame.setAttribute('title', app.name);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  if (rec && typeof rec.code === 'string') frame.srcdoc = rec.code;
  else frame.src = app.url;
  el.appendChild(frame);
  frameIds.set(frame, id);

  // Edge/corner resize handles (desktop only; hidden on phone sheets).
  ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (dir) {
    var h = document.createElement('div');
    h.className = 'rz rz-' + dir;
    h.setAttribute('aria-hidden', 'true');
    el.appendChild(h);
    h.addEventListener('pointerdown', function (ev) { startResize(ev, dir, h); });
  });

  function startResize(ev, dir, handle) {
    if (isPhone() || ev.button !== 0 || el.classList.contains('max')) return;
    ev.preventDefault();
    ev.stopPropagation();
    focusWin(id);
    var r = el.getBoundingClientRect();
    var wr = wins.getBoundingClientRect();
    var sx = ev.clientX, sy = ev.clientY;
    var sl = r.left - wr.left, st = r.top - wr.top, sw = r.width, sh = r.height;
    handle.setPointerCapture && handle.setPointerCapture(ev.pointerId);
    var move = function (me) {
      var dx = me.clientX - sx, dy = me.clientY - sy;
      var w = sw, hh = sh;
      if (dir.indexOf('e') !== -1) w = sw + dx;
      if (dir.indexOf('s') !== -1) hh = sh + dy;
      if (dir.indexOf('w') !== -1) w = sw - dx;
      if (dir.indexOf('n') !== -1) hh = sh - dy;
      w = Math.max(300, Math.min(w, wins.clientWidth - WINDOW_MARGIN));
      var maxH = wins.clientHeight - WINDOW_MARGIN;
      // A north resize keeps the bottom fixed, including at the stage's
      // top margin, so the position clamp on release cannot move it.
      if (dir.indexOf('n') !== -1) maxH = Math.min(maxH, st + sh - WINDOW_MARGIN);
      hh = Math.max(220, Math.min(hh, maxH));
      // Anchor the opposite edge: derive the position from the clamped
      // size so dragging past the minimum cannot shift the far edge.
      var l = dir.indexOf('w') !== -1 ? sl + sw - w : sl;
      var t = dir.indexOf('n') !== -1 ? st + sh - hh : st;
      l = Math.max(WINDOW_MARGIN - w + 60, Math.min(l, wins.clientWidth - 60));
      t = Math.max(0, Math.min(t, wins.clientHeight - 60));
      el.style.left = l + 'px';
      el.style.top = t + 'px';
      el.style.width = w + 'px';
      el.style.height = hh + 'px';
    };
    var up = function () {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      fitWinKeepSize(el);
      recordWinGeo(id);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  // Clamp position without forcing the default size (used after resize).
  function fitWinKeepSize(el) {
    var w = parseFloat(el.style.width) || el.getBoundingClientRect().width;
    var h = parseFloat(el.style.height) || el.getBoundingClientRect().height;
    var left = parseFloat(el.style.left) || WINDOW_MARGIN;
    var top = parseFloat(el.style.top) || WINDOW_MARGIN;
    el.style.width = Math.min(wins.clientWidth - WINDOW_MARGIN * 2, Math.max(300, w)) + 'px';
    el.style.height = Math.min(wins.clientHeight - WINDOW_MARGIN * 2, Math.max(220, h)) + 'px';
    el.style.left = Math.max(WINDOW_MARGIN, Math.min(left, wins.clientWidth - w - WINDOW_MARGIN)) + 'px';
    el.style.top = Math.max(WINDOW_MARGIN, Math.min(top, wins.clientHeight - h - WINDOW_MARGIN)) + 'px';
  }

  // Active title-drag handlers, so maximising mid-drag can cancel them.
  // Without this the stale pointermove listener keeps moving the window
  // on hover after the restore/maximise path.
  var dragMove = null, dragUp = null;
  function cancelTitleDrag() {
    if (dragMove) {
      title.removeEventListener('pointermove', dragMove);
      title.removeEventListener('pointerup', dragUp);
      title.removeEventListener('pointercancel', dragUp);
      dragMove = dragUp = null;
    }
  }

  function setMaximised(on) {
    var btn = title.querySelector('.w-max');
    if (on) {
      cancelTitleDrag();
      if (el.classList.contains('max')) return;
      el.dataset.prel = el.style.left + '|' + el.style.top + '|' + el.style.width + '|' + el.style.height;
      el.classList.add('max');
      btn.textContent = '❐';
      btn.title = 'restore';
      btn.setAttribute('aria-label', 'restore');
    } else {
      if (!el.classList.contains('max')) return;
      el.classList.remove('max');
      var p = (el.dataset.prel || '').split('|');
      if (p.length === 4 && p[2]) {
        el.style.left = p[0]; el.style.top = p[1];
        el.style.width = p[2]; el.style.height = p[3];
        fitWinKeepSize(el);
      } else fitWin(el, app);
      btn.textContent = '☐';
      btn.title = 'maximise';
      btn.setAttribute('aria-label', 'maximise');
    }
    recordWinGeo(id);
  }

  if (app.size !== 'full' && !isPhone()) {
    var saved = savedWins.geo[id];
    if (validGeoRec(saved) && saved.w >= 300 && saved.h >= 220) {
      el.style.left = saved.l + 'px';
      el.style.top = saved.t + 'px';
      el.style.width = saved.w + 'px';
      el.style.height = saved.h + 'px';
      if (saved.max) {
        el.dataset.prel = saved.l + 'px|' + saved.t + 'px|' + saved.w + 'px|' + saved.h + 'px';
        el.classList.add('max');
        var mb = title.querySelector('.w-max');
        mb.textContent = '❐'; mb.title = 'restore'; mb.setAttribute('aria-label', 'restore');
      } else fitWinKeepSize(el);
    } else {
      var s = sizeFor(app);
      var n = cascade++ % 6;
      el.style.left = (wins.clientWidth - s.w) / 2 + (n - 2) * 28 + 'px';
      el.style.top = (wins.clientHeight - s.h) / 3 + (n - 2) * 24 + 'px';
      fitWin(el, app);
    }
  }
  el.style.zIndex = ++zTop;

  title.addEventListener('pointerdown', function (ev) {
    if (isPhone() || ev.button !== 0) return;
    if (ev.target.closest('button') || ev.target.closest('a')) return;
    if (el.classList.contains('max')) return; // maximised windows don't drag
    ev.preventDefault();
    var r = el.getBoundingClientRect();
    var dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    title.setPointerCapture && title.setPointerCapture(ev.pointerId);
    var move = function (me) {
      el.style.left = me.clientX - dx + 'px';
      el.style.top = me.clientY - dy + 'px';
      clampWin(el); // position only — the user's size is left alone
    };
    var up = function () {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', up);
      title.removeEventListener('pointercancel', up);
      dragMove = dragUp = null;
      recordWinGeo(id);
    };
    dragMove = move; dragUp = up;
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
    title.addEventListener('pointercancel', up);
    focusWin(id);
  });
  el.addEventListener('pointerdown', function () { focusWin(id); }, true);
  title.querySelector('.w-close').addEventListener('click', function () { act('close', { id: id }, 'human'); });
  title.querySelector('.w-max').addEventListener('click', function () {
    if (isPhone() || app.size === 'full') return;
    setMaximised(!el.classList.contains('max'));
    focusWin(id);
  });
  title.addEventListener('dblclick', function (ev) {
    if (isPhone() || app.size === 'full') return;
    if (ev.target.closest('button') || ev.target.closest('a')) return;
    setMaximised(!el.classList.contains('max'));
  });
  title.querySelector('.w-min').addEventListener('click', function () {
    if (isPhone()) closeApp(id); // ⌄ closes on phone
    else { el.classList.add('min'); refreshTasks(); saveWins(); }
  });

  wins.appendChild(el);
  openWins[id] = el;
  el.addEventListener('pointerenter', perkBob);
  focusWin(id);
  recordWinGeo(id);
  setHalo('calm');
  try { localStorage.setItem('airis-os.last', id); } catch (e) {}
}

function closeApp(id) {
  var el = openWins[id];
  if (!el) return;
  abortStreamsFor(id);
  delete watches[id];
  Object.keys(runLocks).forEach(function (ws) {
    if (runLocks[ws].id === id) { runLocks[ws].fs.releaseRun(ws); delete runLocks[ws]; }
  });
  el.remove();
  delete openWins[id];
  focusOrder = focusOrder.filter(function (k) { return k !== id; });
  refreshTasks();
  saveWins();
  if (location.hash === '#app/' + id) history.replaceState(null, '', location.pathname + location.search);
  // Whisper demo: closing Lexfall is the one proactive line in v1,
  // with its reason visible. Nothing else nags.
  if (id === 'lexfall') {
    whisperSay('“New best in Lexfall — replay?”', 'demo · lexfall closed');
  }
  setHalo('calm');
}

/* ── tiles, taskbar, dock — all rendered from the same manifest ───────── */
function visibleApps() { return APPS.filter(function (a) { return !a.hidden; }); }

function renderGrid() {
  grid.innerHTML = '';
  visibleApps().forEach(function (app) {
    var b = document.createElement('button');
    b.className = 'tile';
    b.setAttribute('role', 'listitem');
    b.innerHTML = '<span class="t-icon">' + esc(app.icon) + '</span>' +
      '<span class="t-name">' + esc(app.name) + '</span>' +
      '<span class="t-cat">' + esc(app.category || '') + '</span>';
    b.title = app.description || app.name;
    b.addEventListener('click', function () { act('open', { id: app.id }, 'human'); });
    grid.appendChild(b);
  });
}

function refreshTasks() {
  taskApps.innerHTML = '';
  Object.keys(openWins).forEach(function (id) {
    var app = byId[id];
    var b = document.createElement('button');
    b.className = 'task-btn open' + (openWins[id].classList.contains('focused') ? ' focused' : '');
    b.textContent = app.icon + ' ' + app.name;
    b.addEventListener('click', function () {
      if (openWins[id].classList.contains('min') || !openWins[id].classList.contains('focused')) {
        openWins[id].classList.remove('min');
        focusWin(id);
      } else {
        openWins[id].classList.add('min');
        refreshTasks();
      }
    });
    taskApps.appendChild(b);
  });
}

function renderDock() {
  dockApps.innerHTML = '';
  var pins = visibleApps().filter(function (a) { return a.pinned; }).slice(0, 4);
  (pins.length ? pins : visibleApps().slice(0, 4)).forEach(function (app) {
    var b = document.createElement('button');
    b.textContent = app.icon;
    b.title = app.name;
    b.setAttribute('aria-label', app.name);
    b.addEventListener('click', function () { act('open', { id: app.id }, 'human'); });
    dockApps.appendChild(b);
  });
}

/* ── Summon: app/command palette. Never auto-opens. ───────────── */
var RULES = [
  { re: /who are you|your name|about yourself/i,
    say: 'This palette is scripted, not live. For a live agent, open Session.' },
  { re: /^(hi|hello|hey)\b/i, say: 'Hello. This palette is scripted \u2014 Session is the live one.' },
  { re: /what can (you|i) (run|do)|help|commands/i,
    say: 'Type an app name, or a command: open <id> \u00b7 close <id> \u00b7 install <id> \u00b7 theme dark \u00b7 trail \u00b7 export \u00b7 terminal.' },
  { re: /theme/i, say: 'Say \u2018theme dark\u2019 or \u2018theme light\u2019.' }
];
function scriptedAnswer(q) {
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(q)) return RULES[i].say;
  }
  return null;
}

function openSummon() {
  summon.hidden = false;
  summonIn.value = '';
  renderSummon('');
  setTimeout(function () { summonIn.focus(); }, 30);
  bobComeClose(true);
  orbSetOpen(true);
}
function closeSummon() {
  summon.hidden = true;
  bobComeClose(false);
  orbSetOpen(false);
}

function renderSummon(q) {
  summonOut.innerHTML = '';
  var query = q.trim().toLowerCase();
  var limit = isPhone() ? 5 : 8;   // 5 large rows on phone, 8 on desktop
  var matches = visibleApps().filter(function (a) {
    return !query || a.name.toLowerCase().indexOf(query) !== -1 ||
      (a.category || '').toLowerCase().indexOf(query) !== -1;
  }).slice(0, limit);
  matches.forEach(function (app, i) {
    var b = document.createElement('button');
    b.className = 'sr' + (i === 0 ? ' sel' : '');
    b.innerHTML = '<span class="k">' + esc(app.icon) + '</span>' +
      '<span>' + esc(app.name) + '<small>' + esc(app.category || '') + '</small></span>';
    b.addEventListener('click', function () { closeSummon(); act('open', { id: app.id }, 'human'); });
    summonOut.appendChild(b);
  });
  // Any registered action is runnable from here, exactly as from a pointer.
  var cmd = parseCommand(q);
  if (cmd && cmd.name !== 'terminal') {
    var c = document.createElement('button');
    c.className = 'sr' + (matches.length ? '' : ' sel');
    c.innerHTML = '<span class="k">⌁</span><span>' + esc(cmd.name + ' ' + summarise(cmd.name, cmd.args)) + '<small>action · logged to the trail</small></span>';
    c.addEventListener('click', function () {
      closeSummon();
      act(cmd.name, cmd.args, 'human').catch(function (err) { whisperSay(err.message, cmd.name); });
    });
    if (matches.length && /\s/.test(q.trim())) summonOut.insertBefore(c, summonOut.firstChild);
    else summonOut.appendChild(c);
  }
  var say = scriptedAnswer(q);
  if (say) {
    var d = document.createElement('div');
    d.className = 'sr';
    d.innerHTML = '<span class="k">🌙</span><span class="say">Airis · “' + esc(say) + '”</span>';
    summonOut.appendChild(d);
  }
  if (query === 'terminal' || 'terminal'.indexOf(query) === 0) {
    var t = document.createElement('button');
    t.className = 'sr';
    t.innerHTML = '<span class="k">&gt;_</span><span>Terminal<small>local floor · help · ls · open</small></span>';
    t.addEventListener('click', function () { closeSummon(); floor.show(); });
    summonOut.appendChild(t);
  }
}
summonIn.addEventListener('input', function () { renderSummon(summonIn.value); });
summonIn.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    var q = summonIn.value.trim();
    if (!q) return;
    if (q.toLowerCase() === 'terminal') { closeSummon(); floor.show(); return; }
    var first = summonOut.querySelector('button.sr');
    if (first) first.click();
    else { var say = scriptedAnswer(q); if (say) renderSummon(q); }
  }
});
summon.addEventListener('pointerdown', function (e) {
  if (e.target === summon) closeSummon();
});
$('tb-summon').addEventListener('click', openSummon);
$('dock-summon').addEventListener('click', openSummon);

/* ── Presence: three switchable treatments, monochrome throughout ───────
   bob      — wandering desktop companion (wide viewport default).
   portrait — small living face in the corner (narrow viewport default).
   orb      — quiet breathing orb (content-max / "give me room" default).
   A small switcher in the shell overrides the default live; the choice
   persists. No state colours anywhere: all three are neutral ink/teal. */
var bobEl = $('presence-bob'), bobHit = $('bob-hit');
var portraitEl = $('presence-portrait'), orbEl = $('presence-orb');
var presenceSwitches = document.querySelectorAll('.presence-switch');
var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
var presencePick = null; // explicit user choice; null = follow context
var roomy = false;
try {
  presencePick = localStorage.getItem('airis-os.presence');
  if (['bob', 'portrait', 'orb'].indexOf(presencePick) === -1) presencePick = null;
  roomy = localStorage.getItem('airis-os.roomy') === '1';
} catch (e) {}
if (roomy) osEl.classList.add('roomy');

function resolvePresence() {
  if (presencePick) return presencePick;
  if (roomy) return 'orb';
  return isPhone() ? 'portrait' : 'bob';
}
function applyPresence() {
  var mode = resolvePresence();
  if (bobEl) bobEl.hidden = mode !== 'bob';
  if (portraitEl) portraitEl.hidden = mode !== 'portrait';
  if (orbEl) orbEl.hidden = mode !== 'orb';
  for (var s = 0; s < presenceSwitches.length; s++) {
    var btns = presenceSwitches[s].querySelectorAll('button[data-p]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-p') === mode ? 'true' : 'false');
    }
    var rooms = presenceSwitches[s].querySelectorAll('.room-toggle');
    for (var r = 0; r < rooms.length; r++) rooms[r].setAttribute('aria-pressed', roomy ? 'true' : 'false');
  }
}
function setPresence(pick) {
  presencePick = pick;
  try {
    if (pick) localStorage.setItem('airis-os.presence', pick);
    else localStorage.removeItem('airis-os.presence');
  } catch (e) {}
  applyPresence();
}
for (var s = 0; s < presenceSwitches.length; s++) {
  presenceSwitches[s].addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('room-toggle')) {
      roomy = !roomy;
      osEl.classList.toggle('roomy', roomy);
      try { localStorage.setItem('airis-os.roomy', roomy ? '1' : '0'); } catch (err) {}
      applyPresence(); // room implies orb until the user picks otherwise
      return;
    }
    var p = b.getAttribute('data-p');
    if (p) setPresence(p);
  });
}
// Context changes only move the default; an explicit pick sticks.
if (window.matchMedia) {
  var mq = window.matchMedia('(max-width: 767.98px)');
  if (mq.addEventListener) mq.addEventListener('change', function () { applyPresence(); });
  else if (mq.addListener) mq.addListener(function () { applyPresence(); });
}

/* Bob perks up when a window gets attention, and comes close for summon. */
var perkTimer = null;
function perkBob() {
  if (!bobEl || bobEl.hidden) return;
  bobEl.classList.add('perk');
  clearTimeout(perkTimer);
  perkTimer = setTimeout(function () { bobEl.classList.remove('perk'); }, 950);
}
function bobWander() {
  if (!bobEl || bobEl.hidden || reducedMotion.matches) return;
  var stage = $('stage');
  if (!stage) return;
  var w = Math.max(80, stage.clientWidth - 90), h = Math.max(80, stage.clientHeight - 110);
  bobEl.classList.add('walking');
  bobEl.style.left = (8 + Math.random() * w) + 'px';
  bobEl.style.top = (8 + Math.random() * h) + 'px';
  setTimeout(function () { bobEl.classList.remove('walking'); }, 3300);
}
setInterval(bobWander, 6000);
setTimeout(bobWander, 2500);
function bobComeClose(on) {
  if (!bobEl) return;
  if (on && !bobEl.hidden && !reducedMotion.matches) {
    bobEl.classList.add('come-close');
    bobEl.style.left = 'calc(50% - 32px)';
    bobEl.style.top = '6vh';
    perkBob();
  } else {
    bobEl.classList.remove('come-close');
    if (on) perkBob();
  }
}
if (bobHit) {
  bobHit.addEventListener('click', function () {
    summon.hidden ? openSummon() : closeSummon();
  });
}

/* Portrait glances: pupils drift toward the pointer or wander idly. */
function portraitGlance(x, y) {
  if (!portraitEl || portraitEl.hidden || reducedMotion.matches) return;
  var r = portraitEl.getBoundingClientRect();
  var dx = Math.max(-3, Math.min(3, ((x - (r.left + r.width / 2)) / window.innerWidth) * 12));
  var dy = Math.max(-2.5, Math.min(2.5, ((y - (r.top + r.height / 2)) / window.innerHeight) * 12));
  portraitEl.style.setProperty('--gx', dx.toFixed(1) + 'px');
  portraitEl.style.setProperty('--gy', dy.toFixed(1) + 'px');
}
setInterval(function () {
  if (!portraitEl || portraitEl.hidden || reducedMotion.matches) return;
  portraitEl.style.setProperty('--gx', (Math.random() * 6 - 3).toFixed(1) + 'px');
  portraitEl.style.setProperty('--gy', (Math.random() * 4 - 2).toFixed(1) + 'px');
}, 4200);
if (portraitEl) {
  portraitEl.addEventListener('click', function () {
    summon.hidden ? openSummon() : closeSummon();
  });
}

/* Orb breathes quietly: dims when idle, leans to the pointer, swells near. */
var orbIdle = null;
function orbSetOpen(on) {
  if (!orbEl) return;
  orbEl.classList.toggle('open', !!on);
}
function orbWake() {
  if (!orbEl) return;
  orbEl.classList.remove('dim');
  clearTimeout(orbIdle);
  orbIdle = setTimeout(function () { orbEl.classList.add('dim'); }, 12000);
}
if (orbEl) {
  orbEl.addEventListener('pointerenter', function () { orbEl.classList.add('near'); orbWake(); });
  orbEl.addEventListener('pointerleave', function () { orbEl.classList.remove('near'); });
  orbEl.addEventListener('click', function () {
    summon.hidden ? openSummon() : closeSummon();
  });
  orbWake();
}
document.addEventListener('pointermove', function (e) {
  if (orbEl && !orbEl.hidden) orbWake();
  if (orbEl && !orbEl.hidden && !reducedMotion.matches) {
    var r = orbEl.getBoundingClientRect();
    var dx = (e.clientX - (r.left + r.width / 2)) / 40;
    var dy = (e.clientY - (r.top + r.height / 2)) / 40;
    dx = Math.max(-4, Math.min(4, dx));
    dy = Math.max(-4, Math.min(4, dy));
    orbEl.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
  }
  portraitGlance(e.clientX, e.clientY);
}, { passive: true });

/* ── routing: #app/<id> deep links (the floor owns #terminal) ────────── */
function route() {
  var h = location.hash;
  var m = h.match(/^#app\/(.+)$/);
  if (m && byId[m[1]]) openApp(m[1]);
}
window.addEventListener('hashchange', route);

/* ══ THE SHARED ROOM ═══════════════════════════════════════════════════
   Everything below is how a human and an agent share this surface:
   - state():   the whole OS as plain JSON (window.airis.state(), terminal
                `state`, the Session agent's airis_state tool)
   - act():     one action registry; pointer, palette, terminal, console
                and agent tool calls all dispatch through it
   - trail:     every action and bridge privilege lands here with its actor,
                visible in the Trail panel and readable as data
   Rules (actions, capabilities, storage keys, record shapes) come from
   airis.contract.json — this code obeys it rather than restating it. */

var CONTRACT = null;     // airis.contract.json, loaded at boot
var CATALOGUE = [];      // validated manifest entries
var catById = {};
var frameIds = new WeakMap();   // iframe element -> app id (bridge identity)

/* ── contract validation (appEntry) ─────────────────────────────────── */
function isLocalUrl(u) {
  return typeof u === 'string' && !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) &&
    u.charAt(0) !== '/' && u.split(/[/?#]/).indexOf('..') === -1;
}
function validateEntry(e) {
  var spec = CONTRACT.appEntry, errs = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['not an object'];
  spec.required.forEach(function (k) { if (e[k] === undefined || e[k] === '') errs.push('missing ' + k); });
  Object.keys(spec.fields).forEach(function (k) {
    var f = spec.fields[k], v = e[k];
    if (v === undefined) return;
    var t = Array.isArray(v) ? 'array' : typeof v;
    if (t !== f.type) { errs.push(k + ' must be ' + f.type); return; }
    if (f.enum && f.enum.indexOf(v) === -1) errs.push(k + ' must be one of ' + f.enum.join('|'));
    if (f.pattern && !new RegExp(f.pattern).test(v)) errs.push(k + ' does not match ' + f.pattern);
    if (f.items && f.items.enum) v.forEach(function (x) { if (f.items.enum.indexOf(x) === -1) errs.push(k + ': unknown ' + x); });
  });
  if (typeof e.url === 'string' && !isLocalUrl(e.url) && !/^https:\/\//.test(e.url)) errs.push('url must be root-relative or https');
  if (e.install === 'code' && (!isLocalUrl(e.url) || !/\.html$/.test(e.url) || e.launch === 'standalone')) errs.push("install:'code' needs a local .html url and launch:'auto'");
  if (/^https:\/\//.test(e.url || '') && e.install === 'code') errs.push('external url cannot be install:code');
  return errs;
}

/* ── trail ──────────────────────────────────────────────────────────── */
var TRAIL_KEY = 'airis.trail.v1';
var trail = [];
try { var tr = JSON.parse(localStorage.getItem(TRAIL_KEY) || '[]'); if (Array.isArray(tr)) trail = tr.filter(function (x) { return x && typeof x.action === 'string'; }); } catch (e) {}
var trailEl = $('trail'), trailList = $('trail-list');
function trailAdd(actor, action, detail) {
  var ev = { t: new Date().toISOString(), actor: String(actor || 'system'), action: String(action), detail: String(detail == null ? '' : detail).slice(0, 240) };
  trail.push(ev);
  var max = (CONTRACT && CONTRACT.trail.max) || 300;
  if (trail.length > max) trail = trail.slice(-max);
  try { localStorage.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch (e) {}
  renderTrailRow(ev, true);
  broadcast({ event: 'trail', entry: ev }, 'actions');
  return ev;
}
function actorClass(a) { return a === 'human' ? 'human' : a.indexOf('agent') === 0 ? 'agent' : a.indexOf('app') === 0 ? 'app' : 'system'; }
function renderTrailRow(ev, live) {
  if (!trailList) return;
  var li = document.createElement('li');
  li.className = 'tr-' + actorClass(ev.actor);
  var d = new Date(ev.t);
  var hm = isNaN(d) ? '' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  li.innerHTML = '<time>' + esc(hm) + '</time><b>' + esc(ev.actor) + '</b><code>' + esc(ev.action) + '</code><span>' + esc(ev.detail) + '</span>';
  trailList.appendChild(li);
  while (trailList.children.length > 200) trailList.removeChild(trailList.firstChild);
  if (live) trailList.scrollTop = trailList.scrollHeight;
  var badge = $('tb-trail');
  if (live && badge && trailEl && trailEl.hidden && ev.actor !== 'human') badge.classList.add('ping');
}
function renderTrail() { if (!trailList) return; trailList.innerHTML = ''; trail.slice(-200).forEach(function (ev) { renderTrailRow(ev, false); }); trailList.scrollTop = trailList.scrollHeight; }
function toggleTrail(force) {
  if (!trailEl) return;
  trailEl.hidden = typeof force === 'boolean' ? !force : !trailEl.hidden;
  var b = $('tb-trail'); if (b) { b.classList.remove('ping'); b.setAttribute('aria-pressed', trailEl.hidden ? 'false' : 'true'); }
  if (!trailEl.hidden) trailList.scrollTop = trailList.scrollHeight;
}

/* ── install records (the store) ────────────────────────────────────── */
var INSTALL_KEY = 'airis.installs.v1';
var installs = { records: {}, removed: [] };
try {
  var ri = JSON.parse(localStorage.getItem(INSTALL_KEY) || 'null');
  if (ri && typeof ri.records === 'object' && !Array.isArray(ri.records)) {
    installs.records = ri.records;
    installs.removed = Array.isArray(ri.removed) ? ri.removed.filter(function (x) { return typeof x === 'string'; }) : [];
  }
} catch (e) {}
function saveInstalls() {
  try { localStorage.setItem(INSTALL_KEY, JSON.stringify(installs)); return true; }
  catch (e) { trailAdd('system', 'storage', 'could not save install records: ' + e.message); return false; }
}
function validRecord(r) {
  if (!r || r.schema !== CONTRACT.installRecord.schema) return ['schema must be ' + CONTRACT.installRecord.schema];
  var errs = validateEntry(r.entry);
  if (r.entry && r.id !== r.entry.id) errs.push('id differs from entry.id');
  if (r.entry && r.entry.install === 'code' && typeof r.code !== 'string') errs.push('code record without code');
  if (r.entry && r.entry.install === 'link' && r.code != null) errs.push('link record must not carry code');
  return errs;
}
function makeRecord(entry, code, source) {
  return { schema: CONTRACT.installRecord.schema, id: entry.id, version: entry.version, source: source,
    installedAt: new Date().toISOString(), entry: JSON.parse(JSON.stringify(entry)), code: entry.install === 'code' ? code : null };
}
function fetchCode(entry) {
  return fetch(entry.url, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(entry.url + ' HTTP ' + r.status);
    return r.text();
  });
}
function installFromCatalogue(id, actor) {
  var entry = catById[id];
  if (!entry) return Promise.reject(new Error('not in the catalogue: ' + id));
  var p = entry.install === 'code' ? fetchCode(entry) : Promise.resolve(null);
  return p.then(function (code) {
    installs.records[id] = makeRecord(entry, code, 'catalogue');
    installs.removed = installs.removed.filter(function (x) { return x !== id; });
    saveInstalls();
    if (actor) trailAdd(actor, 'install', id + ' v' + entry.version + (code ? ' (' + code.length + ' bytes of code stored)' : ' (link)'));
    rebuildApps();
    return { id: id, version: entry.version };
  });
}
function uninstall(id) {
  if (!installs.records[id]) throw new Error('not installed: ' + id);
  closeApp(id);
  delete installs.records[id];
  if (catById[id] && catById[id].preinstalled && installs.removed.indexOf(id) === -1) installs.removed.push(id);
  saveInstalls();
  rebuildApps();
  return { id: id };
}
/* Boot sync: preinstall missing catalogue apps, refresh catalogue records whose
   version moved, never touch imported records. */
function syncCatalogue() {
  var jobs = [];
  CATALOGUE.forEach(function (e) {
    var rec = installs.records[e.id];
    var stale = rec && rec.source === 'catalogue' && (rec.version !== e.version || JSON.stringify(rec.entry) !== JSON.stringify(e));
    var missing = !rec && e.preinstalled && installs.removed.indexOf(e.id) === -1;
    if (!stale && !missing) return;
    if (stale && e.install === 'link' && rec.version === e.version) {
      installs.records[e.id] = makeRecord(e, null, 'catalogue'); return; // metadata-only refresh
    }
    jobs.push(installFromCatalogue(e.id, null).then(function () {
      trailAdd('system', stale ? 'update' : 'install', e.id + ' v' + e.version);
    }, function (err) { trailAdd('system', 'install-failed', e.id + ': ' + err.message); }));
  });
  Object.keys(installs.records).forEach(function (id) {
    var errs = validRecord(installs.records[id]);
    if (errs.length) { trailAdd('system', 'record-invalid', id + ': ' + errs.join('; ') + ' (removed)'); delete installs.records[id]; }
  });
  saveInstalls();
  return Promise.all(jobs);
}
function rebuildApps() {
  APPS = Object.keys(installs.records).map(function (id) {
    var a = normaliseApp(installs.records[id].entry);
    a.source = installs.records[id].source;
    return a;
  });
  // Catalogue order first, then imported extras.
  var order = CATALOGUE.map(function (e) { return e.id; });
  APPS.sort(function (a, b) {
    var ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia === -1 ? 1e6 : ia) - (ib === -1 ? 1e6 : ib);
  });
  byId = {};
  APPS.forEach(function (a) { byId[a.id] = a; });
  Object.keys(openWins).forEach(function (id) { if (!byId[id]) closeApp(id); });
  renderGrid(); renderDock(); refreshTasks();
  if (floor && floor.update) floor.update(APPS);
}
function storeList() {
  var cat = CATALOGUE.map(function (e) {
    var r = installs.records[e.id];
    return { id: e.id, name: e.name, icon: e.icon || '', category: e.category || '', description: e.description || '',
      version: e.version, install: e.install, launch: e.launch || 'auto', capabilities: e.capabilities || [], hidden: !!e.hidden,
      installed: !!r, installedVersion: r ? r.version : null, source: r ? r.source : null };
  });
  var extra = Object.keys(installs.records).filter(function (id) { return !catById[id]; }).map(function (id) {
    var r = installs.records[id], e = r.entry;
    return { id: id, name: e.name, icon: e.icon || '', category: e.category || '', description: e.description || '',
      version: r.version, install: e.install, launch: e.launch || 'auto', capabilities: e.capabilities || [], hidden: !!e.hidden,
      installed: true, installedVersion: r.version, source: r.source, orphan: r.source === 'catalogue' };
  });
  return { catalogue: cat, extra: extra };
}
function exportBundle() {
  var recs = Object.keys(installs.records).map(function (id) { return installs.records[id]; });
  var bundle = { schema: CONTRACT.bundle.schema, exportedAt: new Date().toISOString(), records: recs };
  var text = JSON.stringify(bundle, null, 2);
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = 'airis-apps-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  return { count: recs.length, bytes: text.length, file: a.download };
}
function importBundle(text) {
  var b;
  try { b = JSON.parse(text); } catch (e) { throw new Error('not JSON: ' + e.message); }
  if (!b || b.schema !== CONTRACT.bundle.schema || !Array.isArray(b.records)) throw new Error('not an ' + CONTRACT.bundle.schema + ' bundle');
  var imported = [], unchanged = [], skipped = [], queued = [];
  b.records.forEach(function (r) {
    if (r && r.schema === 'airis.workspace/1') {
      queued.push(r.ws);
      fsLib().then(function (fs) { return fs.importWorkspace(r, {}); }).then(function (res) {
        fsTrail('system', 'fs.import', r.ws, '', res);
      }, function (err) { trailAdd('system', 'fs.import', r.ws + ': → ' + err.message); });
      return;
    }
    var errs = validRecord(r);
    if (errs.length) { skipped.push({ id: r && r.id, reason: errs.join('; ') }); return; }
    var cur = installs.records[r.id];
    // Identical to what is installed: leave it alone (keeps catalogue updates flowing).
    if (cur && cur.version === r.version && cur.code === (r.code == null ? null : r.code) &&
        JSON.stringify(cur.entry) === JSON.stringify(r.entry)) { unchanged.push(r.id); return; }
    var rec = makeRecord(r.entry, r.code, 'import');
    rec.version = r.version || r.entry.version;
    installs.records[r.id] = rec;
    installs.removed = installs.removed.filter(function (x) { return x !== r.id; });
    imported.push(r.id);
  });
  imported.forEach(closeApp);   // a replaced app restarts from its new record
  if (!saveInstalls()) throw new Error('browser storage is full or blocked');
  rebuildApps();
  return { imported: imported, unchanged: unchanged, skipped: skipped, queued: queued };
}

/* ── state: the whole OS as plain data (no secret values, ever) ─────── */
function secretNames(id) {
  var out = [], pre = 'airis.secret.' + id + '.';
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(pre) === 0) out.push(k.slice(pre.length)); } } catch (e) {}
  return out;
}
function state() {
  var focused = null;
  Object.keys(openWins).forEach(function (id) { if (openWins[id].classList.contains('focused')) focused = id; });
  return {
    contract: CONTRACT ? CONTRACT.contract : null,
    theme: document.documentElement.getAttribute('data-theme'),
    layout: isPhone() ? 'phone' : 'desktop',
    view: osEl.hidden ? 'terminal' : 'os',
    apps: APPS.map(function (a) {
      var w = openWins[a.id];
      return { id: a.id, name: a.name, version: a.version, source: a.source, launch: a.launch, hidden: !!a.hidden,
        capabilities: a.capabilities || [], open: !!w, minimised: !!(w && w.classList.contains('min')),
        secrets: secretNames(a.id) };
    }),
    notInstalled: CATALOGUE.filter(function (e) { return !installs.records[e.id]; }).map(function (e) { return e.id; }),
    windows: { open: focusOrder.filter(function (id) { return !!openWins[id]; }), focused: focused },
    actions: Object.keys(CONTRACT.actions.list),
    agentActions: Object.keys(CONTRACT.actions.list).filter(function (k) { return CONTRACT.actions.list[k].agent; }),
    trail: trail.slice(-40)
  };
}

/* ── the action registry ─────────────────────────────────────────────── */
var ACTIONS = {
  open: function (a) { need(a.id); return openApp(a.id) || 'open'; },
  close: function (a) { need(a.id); closeApp(a.id); return 'closed'; },
  focus: function (a) { need(a.id); if (!openWins[a.id]) return openApp(a.id) || 'opened'; openWins[a.id].classList.remove('min'); focusWin(a.id); return 'focused'; },
  theme: function (a) { if (a.value !== 'dark' && a.value !== 'light') throw new Error('value must be dark or light'); setTheme(a.value); return a.value; },
  note: function (a) { return String(a.text || '').slice(0, 240); },
  install: function (a) { return installFromCatalogue(a.id, null); },
  uninstall: function (a) { return uninstall(a.id); },
  grant: function (a) { need(a.id); fsGrant(a.ws, a.id); return 'granted'; },
  revoke: function (a) { need(a.id); fsRevoke(a.ws, a.id); return 'revoked'; },
  'export': function () { return exportBundle(); },
  'import': function (a) { return importBundle(String(a.text || '')); },
  terminal: function () { floor.show(); return 'terminal'; },
  trail: function () { toggleTrail(); return trailEl && !trailEl.hidden ? 'shown' : 'hidden'; }
};
function need(id) { if (!byId[id]) throw new Error('no such installed app: ' + id); }
function summarise(name, args) {
  if (!args) return '';
  if (name === 'import') return (String(args.text || '').length) + ' bytes';
  if (name === 'note') return String(args.text || '');
  return Object.keys(args).map(function (k) { return k + '=' + (typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k])); }).join(' ');
}
/* act(name, args, actor) -> Promise<result>. The one way anything changes. */
function act(name, args, actor) {
  args = args && typeof args === 'object' ? args : {};
  actor = actor || 'console';
  var spec = CONTRACT && CONTRACT.actions.list[name];
  if (!spec || !ACTIONS[name]) { trailAdd(actor, name, 'refused: unknown action'); return Promise.reject(new Error('unknown action: ' + name)); }
  if (actor.indexOf('agent') === 0 && !spec.agent) { trailAdd(actor, name, 'refused: not allowed for agents'); return Promise.reject(new Error(name + ' is not available to agents')); }
  return Promise.resolve().then(function () { return ACTIONS[name](args); }).then(function (res) {
    trailAdd(actor, name, summarise(name, args));
    return res;
  }, function (err) {
    trailAdd(actor, name, summarise(name, args) + ' → error: ' + err.message);
    throw err;
  });
}

/* ── the bridge: app frames ⇄ shell, capability-checked ─────────────── */
var streams = {};   // appId + ':' + re -> AbortController
var watches = Object.create(null), runLocks = Object.create(null), fsPromise, fsWatching = false;
function fsLib() {
  if (!fsPromise) fsPromise = import('./lib/fs.js').then(function (lib) { return lib.openFs(); });
  return fsPromise;
}
function validWorkspace(ws) {
  if (typeof ws !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(ws)) throw new Error('invalid workspace');
  return ws;
}
function fsGrants() {
  var grants;
  try { grants = JSON.parse(localStorage.getItem('airis.fs.grants.v1') || '{}'); } catch (e) { grants = {}; }
  return grants && typeof grants === 'object' && !Array.isArray(grants) ? grants : {};
}
function fsGranted(ws, id) {
  var grants = fsGrants();
  return Array.isArray(grants[ws]) && grants[ws].indexOf(id) !== -1;
}
function fsGrant(ws, id) {
  validWorkspace(ws);
  var grants = fsGrants(), ids = Array.isArray(grants[ws]) ? grants[ws] : [];
  if (ids.indexOf(id) === -1) ids.push(id);
  grants[ws] = ids;
  localStorage.setItem('airis.fs.grants.v1', JSON.stringify(grants));
}
function fsRevoke(ws, id) {
  validWorkspace(ws);
  var grants = fsGrants(), ids = Array.isArray(grants[ws]) ? grants[ws] : [];
  grants[ws] = ids.filter(function (x) { return x !== id; });
  localStorage.setItem('airis.fs.grants.v1', JSON.stringify(grants));
  if (watches[id]) watches[id] = watches[id].filter(function (w) { return w.ws !== ws; });
}
function fsRequire(ws, id) { if (!fsGranted(ws, id)) throw new Error('workspace not granted: ' + ws); }
function fsActor(id, a) { return (a.actor === 'agent' ? 'agent:' : 'app:') + id; }
function fsContext(id, a) {
  var ctx = { actor: fsActor(id, a) };
  if (a.runId !== undefined) ctx.runId = a.runId;
  if (a.callId !== undefined) ctx.callId = a.callId;
  return ctx;
}
function fsTrail(actor, op, ws, path, res) {
  var detail = 'ok';
  if (res && res.ok === false) {
    detail = res.error;
    if (res.error === 'conflict' && res.current != null) detail += ' (current v' + res.current + (res.actor ? ' by ' + res.actor : '') + ')';
  } else if (res && res.deleted) detail = 'deleted';
  else if (res && res.ver != null) detail = 'v' + res.ver;
  else if (res && Array.isArray(res.restored)) detail = 'restored ' + res.restored.length + ' file(s)';
  trailAdd(actor, op, ws + ':' + (path || '') + ' → ' + detail);
  return res;
}
function fsRefusal(id, a, op, fn) {
  return Promise.resolve().then(fn).catch(function (err) {
    trailAdd(op === 'fs.lock' || op === 'fs.unlock' ? 'app:' + id : fsActor(id, a), op, (a.ws || a.as || '') + ':' + (a.path || a.to || a.from || '') + ' → refused: ' + (err.message || String(err)));
    throw err;
  });
}
function fsCall(id, a, op, method, mutation) {
  var call = function () {
    fsRequire(a.ws, id);
    return fsLib().then(function (fs) { return fs[method](a, fsContext(id, a)); }).then(function (res) {
      return mutation ? fsTrail(fsActor(id, a), op, a.ws, res.path || a.path || a.to || '', res) : res;
    });
  };
  return mutation ? fsRefusal(id, a, op, call) : Promise.resolve().then(call);
}
function fsChanges(event) {
  Object.keys(watches).forEach(function (id) {
    var win = openWins[id], fr = win && win.querySelector('iframe');
    if (!fr || !fr.contentWindow || !fsGranted(event.ws, id)) return;
    if (watches[id].some(function (w) {
      return w.ws === event.ws && (!w.path || event.path === w.path || event.path.indexOf(w.path + '/') === 0);
    })) reply(fr.contentWindow, { event: 'fs', ws: event.ws, path: event.path, ver: event.ver, actor: event.actor });
  });
}
function fsImport(fs, id, a) {
  if (a.blob !== undefined) return fs.importWorkspace(a.blob, { as: a.as }).then(function (res) {
    if (res.ok) fsGrant(res.ws, id);
    fsTrail(fsActor(id, a), 'fs.import', res.ws || a.as || '', '', res);
    return [res];
  });
  var bundle = JSON.parse(a.text), records;
  if (bundle && bundle.schema === 'airis.workspace/1') records = [bundle];
  else if (bundle && bundle.schema === 'airis.bundle/1' && Array.isArray(bundle.records)) {
    records = bundle.records.filter(function (r) { return r && r.schema === 'airis.workspace/1'; });
  } else throw new Error('not a workspace or bundle');
  var results = [];
  return records.reduce(function (p, record) {
    return p.then(function () { return fs.importWorkspace(record, { as: a.as }); }).then(function (res) {
      if (res.ok) fsGrant(res.ws, id);
      fsTrail(fsActor(id, a), 'fs.import', res.ws || a.as || record.ws, '', res);
      results.push(res);
    });
  }, Promise.resolve()).then(function () { return results; });
}
function broadcast(msg, cap) {
  msg.airis = 1;
  Object.keys(openWins).forEach(function (id) {
    var app = byId[id], fr = openWins[id].querySelector('iframe');
    if (!fr || !fr.contentWindow || !app) return;
    if (cap && (app.capabilities || []).indexOf(cap) === -1) return;
    try { fr.contentWindow.postMessage(msg, '*'); } catch (e) {}
  });
}
function abortStreamsFor(id) {
  Object.keys(streams).forEach(function (k) { if (k.indexOf(id + ':') === 0) { try { streams[k].abort(); } catch (e) {} delete streams[k]; } });
}
function appIdForSource(src) {
  var ids = Object.keys(openWins);
  for (var i = 0; i < ids.length; i++) {
    var fr = openWins[ids[i]].querySelector('iframe');
    if (fr && fr.contentWindow === src) return frameIds.get(fr) || null;
  }
  return null;
}
function storageKey(id, k) {
  if (typeof k !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(k)) throw new Error('bad key');
  return 'airis.app.' + id + '.' + k;
}
function secretKey(id, k) {
  if (typeof k !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(k)) throw new Error('bad secret name');
  return 'airis.secret.' + id + '.' + k;
}
function netUrl(u) {
  var url = new URL(String(u), location.href);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) urls');
  if (url.username || url.password) throw new Error('no credentials in urls');
  return url;
}
var OPS = {
  'hello': function (id) {
    var a = byId[id];
    return { appId: id, entry: installs.records[id] ? installs.records[id].entry : a, theme: document.documentElement.getAttribute('data-theme'),
      capabilities: a.capabilities || [], contract: CONTRACT.contract };
  },
  'trail.note': function (id, a) { trailAdd('app:' + id, 'note', String(a.text || '')); return true; },
  'storage.get': function (id, a) { var v = localStorage.getItem(storageKey(id, a.key)); return v == null ? null : JSON.parse(v); },
  'storage.set': function (id, a) { localStorage.setItem(storageKey(id, a.key), JSON.stringify(a.value === undefined ? null : a.value)); return true; },
  'storage.remove': function (id, a) { localStorage.removeItem(storageKey(id, a.key)); return true; },
  'storage.keys': function (id) {
    var out = [], pre = 'airis.app.' + id + '.';
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(pre) === 0) out.push(k.slice(pre.length)); }
    return out;
  },
  'secret.has': function (id, a) { return localStorage.getItem(secretKey(id, a.name)) != null; },
  'secret.set': function (id, a) {
    if (typeof a.value !== 'string' || !a.value) throw new Error('empty secret');
    localStorage.setItem(secretKey(id, a.name), a.value);
    trailAdd('app:' + id, 'secret.set', a.name + ' stored in this browser (value not shown)');
    return true;
  },
  'secret.forget': function (id, a) {
    localStorage.removeItem(secretKey(id, a.name));
    trailAdd('app:' + id, 'secret.forget', a.name + ' removed from this browser');
    return true;
  },
  'os.state': function () { return state(); },
  'os.do': function (id, a) { return act(String(a.action || ''), a.args || {}, 'agent:' + id); },
  'store.list': function () { return storeList(); },
  'store.install': function (id, a) { return act('install', { id: a.id }, 'human'); },
  'store.uninstall': function (id, a) { return act('uninstall', { id: a.id }, 'human'); },
  'store.export': function () { return act('export', {}, 'human'); },
  'store.import': function (id, a) { return act('import', { text: a.text }, 'human'); },
  'fs.workspaces': function (id) { return fsLib().then(function (fs) { return fs.listWorkspaces(); }).then(function (list) { return list.filter(function (w) { return fsGranted(w.ws, id); }); }); },
  'fs.create': function (id, a) { return fsRefusal(id, a, 'fs.create', function () { return fsLib().then(function (fs) { return fs.createWorkspace(a); }).then(function (res) { if (res.ok) fsGrant(res.ws, id); return fsTrail(fsActor(id, a), 'fs.create', a.ws, '', res); }); }); },
  'fs.list': function (id, a) { return fsCall(id, a, 'fs.list', 'list'); },
  'fs.read': function (id, a) { return fsCall(id, a, 'fs.read', 'read'); },
  'fs.stat': function (id, a) { return fsCall(id, a, 'fs.stat', 'stat'); },
  'fs.write': function (id, a) { return fsCall(id, a, 'fs.write', 'write', true); },
  'fs.edit': function (id, a) { return fsCall(id, a, 'fs.edit', 'edit', true); },
  'fs.delete': function (id, a) { return fsCall(id, a, 'fs.delete', 'delete', true); },
  'fs.move': function (id, a) { return fsCall(id, a, 'fs.move', 'move', true); },
  'fs.diff': function (id, a) { return fsCall(id, a, 'fs.diff', 'diff'); },
  'fs.history': function (id, a) { return fsCall(id, a, 'fs.history', 'history'); },
  'fs.versions': function (id, a) { return fsCall(id, a, 'fs.versions', 'versions'); },
  'fs.revert': function (id, a) { return fsCall(id, a, 'fs.revert', 'revertRun', true); },
  'fs.lock': function (id, a) {
    return fsRefusal(id, a, 'fs.lock', function () {
      fsRequire(a.ws, id);
      var win = openWins[id];
      return fsLib().then(function (fs) {
        return fs.acquireRun(a.ws, id).then(function (res) {
          if (res.held && (openWins[id] !== win || !win || !fsGranted(a.ws, id))) { fs.releaseRun(a.ws); res.held = false; }
          if (res.held) runLocks[a.ws] = { id: id, fs: fs };
          fsTrail('app:' + id, 'fs.lock', a.ws, '', res);
          return { held: res.held };
        });
      });
    });
  },
  'fs.unlock': function (id, a) {
    return fsRefusal(id, a, 'fs.unlock', function () {
      fsRequire(a.ws, id);
      var held = runLocks[a.ws];
      if (held && held.id === id) { held.fs.releaseRun(a.ws); delete runLocks[a.ws]; }
      fsTrail('app:' + id, 'fs.unlock', a.ws, '', { ok: true });
      return true;
    });
  },
  'fs.watch': function (id, a) {
    fsRequire(a.ws, id);
    var win = openWins[id];
    return fsLib().then(function (fs) {
      if (!fsWatching) { fs.onChange(fsChanges); fsWatching = true; }
      if (!win || openWins[id] !== win || !fsGranted(a.ws, id)) return false;
      if (!watches[id]) watches[id] = [];
      watches[id].push({ ws: a.ws, path: a.path });
      return true;
    });
  },
  'fs.unwatch': function (id, a) {
    fsRequire(a.ws, id);
    return fsLib().then(function () { if (watches[id]) watches[id] = watches[id].filter(function (w) { return w.ws !== a.ws; }); return true; });
  },
  'fs.usage': function () { return fsLib().then(function (fs) { return fs.usage(); }); },
  'fs.export': function (id, a) { fsRequire(a.ws, id); return fsLib().then(function (fs) { return fs.exportBundle(a); }).then(function (res) {
    if (res.ok === false) return res;
    return new Response(res.stream).blob().then(function (blob) {
      return { ok: true, filename: res.filename, type: res.type, exportedAt: res.exportedAt, blob: blob.slice(0, blob.size, 'application/zip') };
    });
  }); },
  'fs.import': function (id, a) { return fsRefusal(id, a, 'fs.import', function () { return fsLib().then(function (fs) { return fsImport(fs, id, a); }); }); }
};
function reply(win, msg) { msg.airis = 1; try { win.postMessage(msg, '*'); } catch (e) {} }
function netStream(id, win, re, a) {
  var url = netUrl(a.url);
  var headers = {}, authHeader = a.auth ? (a.auth.header == null ? 'Authorization' : a.auth.header) : null;
  if (a.auth && (typeof authHeader !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(authHeader))) throw new Error('bad auth header');
  Object.keys(a.headers || {}).forEach(function (k) {
    if (/^authorization$/i.test(k) || (authHeader && k.toLowerCase() === authHeader.toLowerCase())) return; // auth only via the secret store
    headers[k] = String(a.headers[k]);
  });
  if (a.auth && a.auth.secret) {
    var v = localStorage.getItem(secretKey(id, a.auth.secret));
    if (!v) throw new Error('no ' + a.auth.secret + ' stored');
    headers[authHeader] = /^authorization$/i.test(authHeader) ? (a.auth.scheme || 'Bearer') + ' ' + v : (a.auth.scheme ? a.auth.scheme + ' ' : '') + v;
  }
  var ctrl = new AbortController();
  streams[id + ':' + re] = ctrl;
  var method = String(a.method || 'GET').toUpperCase();
  var where = (url.origin === location.origin ? '' : url.origin) + url.pathname;
  return fetch(url.toString(), {
    method: method, headers: headers, body: a.body == null ? undefined : String(a.body),
    signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
  }).then(function (res) {
    var meta = { status: res.status, statusText: res.statusText, contentType: res.headers.get('content-type') || '' };
    if (!res.ok || !res.body) {
      return res.text().then(function (t) { meta.text = t.slice(0, 4000); trailAdd('app:' + id, 'net', method + ' ' + where + ' → ' + res.status); return meta; });
    }
    var reader = res.body.getReader(), dec = new TextDecoder(), bytes = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { var tail = dec.decode(); if (tail) reply(win, { re: re, chunk: tail }); trailAdd('app:' + id, 'net', method + ' ' + where + ' → ' + res.status + ' (' + bytes + ' bytes streamed)'); return meta; }
        bytes += r.value.length;
        var text = dec.decode(r.value, { stream: true });
        if (text) reply(win, { re: re, chunk: text });
        return pump();
      });
    }
    return pump();
  }).catch(function (err) {
    // Covers both a failed fetch and an abort/failure mid-body.
    var msg = err && err.name === 'AbortError' ? 'aborted' : 'network error (' + (err && err.message || err) + ')';
    trailAdd('app:' + id, 'net', method + ' ' + where + ' → ' + msg);
    throw new Error(msg);
  }).finally(function () { delete streams[id + ':' + re]; });
}
window.addEventListener('message', function (e) {
  var m = e.data;
  if (!m || m.airis !== 1 || typeof m.op !== 'string' || !CONTRACT) return;
  var id = appIdForSource(e.source);
  if (!id || !byId[id]) return;             // not one of our frames
  var win = e.source, spec = CONTRACT.bridge.ops[m.op], caps = byId[id].capabilities || [];
  var args = m.args && typeof m.args === 'object' ? m.args : {};
  var p;
  if (!spec) p = Promise.reject(new Error('unknown op ' + m.op));
  else if (spec.cap && caps.indexOf(spec.cap) === -1) {
    trailAdd('app:' + id, m.op, 'refused: needs capability ' + spec.cap);
    p = Promise.reject(new Error(m.op + ' needs capability ' + spec.cap));
  } else if (m.op === 'net.stream') p = Promise.resolve().then(function () { return netStream(id, win, m.id, args); });
  else if (m.op === 'net.abort') { var c = streams[id + ':' + args.re]; if (c) c.abort(); p = Promise.resolve(!!c); }
  else p = Promise.resolve().then(function () { return OPS[m.op](id, args); });
  p.then(function (v) { reply(win, { re: m.id, ok: true, value: v === undefined ? null : v }); },
         function (err) { reply(win, { re: m.id, ok: false, error: String(err && err.message || err) }); });
});

/* One command grammar for the palette, the terminal and the console:
   "<action> [arg]" — the arg fills the action's single contract argument. */
function parseCommand(line) {
  var m = String(line || '').trim().match(/^([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!m || !CONTRACT || !CONTRACT.actions.list[m[1].toLowerCase()]) return null;
  var name = m[1].toLowerCase(), rest = (m[2] || '').trim();
  var keys = Object.keys(CONTRACT.actions.list[name].args || {});
  var args = {};
  if (keys.length && rest) args[keys[0]] = rest;
  return { name: name, args: args };
}

/* ── window.airis: the same room for anyone holding a console ────────── */
window.airis = {
  state: function () { return state(); },
  do: function (name, args) { return act(name, args, 'console'); },
  run: function (line, actor) {
    var c = parseCommand(line);
    if (!c) return Promise.reject(new Error('not a command: ' + line));
    return act(c.name, c.args, actor === 'human' ? 'human' : 'console');
  },
  trail: function () { return trail.slice(); },
  contract: function () { return CONTRACT; },
  actions: function () { return CONTRACT && CONTRACT.actions.list; }
};

/* ── boot ─────────────────────────────────────────────────────────────── */
function boot(manifest) {
  if (booted) return;
  booted = true;
  var entries = manifest && manifest.apps;
  if (!Array.isArray(entries) || !entries.length) {
    floor.fail('The manifest is empty or unreadable. Try ls for standalone app links.');
    return;
  }
  // Invalid entries are skipped and named in the trail, never fatal.
  var seen = {};
  CATALOGUE = entries.filter(function (e) {
    var errs = validateEntry(e);
    if (!errs.length && seen[e.id]) errs = ['duplicate id'];
    if (errs.length) { trailAdd('system', 'manifest-invalid', (e && e.id || '?') + ': ' + errs.join('; ')); return false; }
    seen[e.id] = true;
    return true;
  });
  catById = {};
  CATALOGUE.forEach(function (e) { catById[e.id] = e; });
  renderTrail();
  rebuildApps();   // what is installed already runs immediately
  return syncCatalogue().then(function () {
    rebuildApps();
    if (!APPS.length) { floor.fail('Nothing is installed and the catalogue could not install. Try ls.'); return; }
    applyPresence();
    floor.ready(APPS);
    if (osEl.hidden) return;
    restoreSession();
  });
}
function restoreSession() {
  // Restore the full saved session even when a deep-link hash is present.
  // Opening any window writes #app/<id>, so a plain refresh always carries
  // a hash — skipping the restore on hash would lose every window but one
  // and overwrite storage with that single window. The deep link joins the
  // restore instead and is focused last; on phone the deep link (or the
  // last focused window) is the one that comes back.
  var deepId = null;
  var dm = (location.hash || '').match(/^#app\/(.+)$/);
  if (dm && byId[dm[1]]) {
    if (byId[dm[1]].launch === 'standalone') { route(); return; }
    deepId = dm[1]; // Explicit links may open hidden apps; automatic restore may not.
  }
  var toOpen = savedWins.open.filter(function (id) {
    return byId[id] && !byId[id].hidden && byId[id].launch !== 'standalone';
  });
  if (deepId && toOpen.indexOf(deepId) === -1) {
    if (byId[deepId]) toOpen.push(deepId);
  } else if (deepId) {
    toOpen = toOpen.filter(function (id) { return id !== deepId; });
    toOpen.push(deepId);
  }
  if (isPhone()) toOpen = toOpen.slice(-1);
  toOpen.forEach(function (id) {
    try { openApp(id); } catch (e) {}
  });
  if (!toOpen.length) {
    try {
      var last = localStorage.getItem('airis-os.last');
      if (!location.hash && last && byId[last] && !byId[last].hidden) {
        whisperSay('Welcome back — “' + byId[last].name + '” is where you left off.', 'local memory');
      }
    } catch (e) {}
  }
}

var trailBtn = $('tb-trail'), trailX = $('trail-x');
if (trailBtn) trailBtn.addEventListener('click', function () { act('trail', {}, 'human'); });
if (trailX) trailX.addEventListener('click', function () { act('trail', {}, 'human'); });
var sbTrail = $('sb-trail');
if (sbTrail) sbTrail.addEventListener('click', function () { act('trail', {}, 'human'); });

function getJSON(u) {
  return fetch(u, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(u + ' HTTP ' + r.status);
    return r.json();
  });
}
Promise.all([getJSON('./airis.contract.json'), getJSON('./manifest.json')])
  .then(function (both) { CONTRACT = both[0]; return boot(both[1]); })
  .catch(function (err) {
    // Boot guard: hide OS chrome, reveal the floor with the error in one line.
    floor.fail('Shell boot failed (' + err.message + '). Try ls for standalone app links.');
  });

})();
