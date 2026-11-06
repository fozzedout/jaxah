/* Airis OS v1 — shell. One static page owns all OS chrome: Halo, Whisper
   Strip, Summon, taskbar/dock, window manager, routing.
   The standalone terminal.js owns the fallback, including shell error recovery.
   Reads os/manifest.json. Ships zero app code. Apps run in opaque-origin
   sandboxed iframes (sandbox="allow-scripts", never allow-same-origin). */
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
  return a;
}

/* ── Window geometry persistence ────────────────────────────────────────
   Positions AND sizes survive refresh/relaunch. One localStorage entry:
   { open: [ids in focus order], geo: { id: {l,t,w,h,max} } }.
   Geometry is kept when a window closes, so reopening restores it. */
var WIN_STORE = 'airis-os.windows.v1';
var savedWins = { open: [], geo: {} };
try {
  var rawWins = localStorage.getItem(WIN_STORE);
  if (rawWins) {
    var parsed = JSON.parse(rawWins);
    if (parsed && parsed.geo) savedWins = parsed;
    if (!Array.isArray(savedWins.open)) savedWins.open = [];
  }
} catch (e) {}
function saveWins() {
  try {
    savedWins.open = Object.keys(openWins);
    localStorage.setItem(WIN_STORE, JSON.stringify(savedWins));
  } catch (e) {}
}
function recordWinGeo(id) {
  var el = openWins[id];
  if (!el || isPhone()) return;
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
}
try {
  var savedTheme = localStorage.getItem('airis-os.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);
} catch (e) {}
function toggleTheme() {
  setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
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
   default size — user resizes survive viewport changes. */
function clampWin(el) {
  if (isPhone() || el.classList.contains('max')) return;
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
  Object.keys(openWins).forEach(function (k) {
    openWins[k].style.zIndex = k === id ? ++zTop : openWins[k].style.zIndex;
    openWins[k].classList.toggle('focused', k === id);
  });
  refreshTasks();
  saveWins(); // focus order is the restore order
}

function openApp(id) {
  var app = byId[id];
  if (!app) { floor.show('no such app: ' + id); return; }
  if (app.launch === 'standalone') {
    location.assign(app.url);
    return;
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
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', app.name);

  var title = document.createElement('div');
  title.className = 'w-title';
  var external = /^https?:\/\//.test(app.url);
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
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', app.name);
  frame.src = app.url;
  el.appendChild(frame);

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
      var l = sl, t = st, w = sw, hh = sh;
      if (dir.indexOf('e') !== -1) w = sw + dx;
      if (dir.indexOf('s') !== -1) hh = sh + dy;
      if (dir.indexOf('w') !== -1) { w = sw - dx; l = sl + dx; }
      if (dir.indexOf('n') !== -1) { hh = sh - dy; t = st + dy; }
      w = Math.max(300, Math.min(w, wins.clientWidth - WINDOW_MARGIN));
      hh = Math.max(220, Math.min(hh, wins.clientHeight - WINDOW_MARGIN));
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

  function setMaximised(on) {
    var btn = title.querySelector('.w-max');
    if (on) {
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
    if (saved && saved.w >= 300 && saved.h >= 220) {
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
      recordWinGeo(id);
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
    title.addEventListener('pointercancel', up);
    focusWin(id);
  });
  el.addEventListener('pointerdown', function () { focusWin(id); }, true);
  title.querySelector('.w-close').addEventListener('click', function () { closeApp(id); });
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
  if (location.hash !== '#app/' + id) history.replaceState(null, '', '#app/' + id);
}

function closeApp(id) {
  var el = openWins[id];
  if (!el) return;
  el.remove();
  delete openWins[id];
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
    b.addEventListener('click', function () { openApp(app.id); });
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
    b.addEventListener('click', function () { openApp(app.id); });
    dockApps.appendChild(b);
  });
}

/* ── Summon: app/command palette. Never auto-opens. ───────────── */
var RULES = [
  { re: /who are you|your name|about yourself/i,
    say: 'I\u2019m scripted, not live \u2014 a resident persona, not a live AI.' },
  { re: /^(hi|hello|hey)\b/i, say: 'Hello. I\u2019m scripted, not live.' },
  { re: /what can (you|i) (run|do)|help|commands/i,
    say: 'Type an app name to launch it, \u2018terminal\u2019 for the floor, or \u2018theme dark\u2019.' },
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
    b.addEventListener('click', function () { closeSummon(); openApp(app.id); });
    summonOut.appendChild(b);
  });
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
    var m = q.toLowerCase().match(/^theme\s+(dark|light)$/);
    if (m) { setTheme(m[1]); closeSummon(); return; }
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

/* ── boot ─────────────────────────────────────────────────────────────── */
function boot(manifest) {
  if (booted) return;
  booted = true;
  var entries = manifest && manifest.apps;
  if (!Array.isArray(entries) || !entries.length) {
    floor.fail('The manifest is empty or unreadable. Try ls for standalone app links.');
    return;
  }
  APPS = entries.map(normaliseApp);
  APPS.forEach(function (a) { byId[a.id] = a; });
  renderGrid();
  renderDock();
  refreshTasks();
  applyPresence();
  floor.ready(APPS);
  if (osEl.hidden) return;
  route();
  // Restore window positions AND sizes after refresh/relaunch. A deep link
  // wins over the restore; on phone only the last window comes back.
  if (!location.hash || !location.hash.match(/^#app\//)) {
    var toOpen = savedWins.open.filter(function (id) {
      return byId[id] && !byId[id].hidden && byId[id].launch !== 'standalone';
    });
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
    return;
  }
  try {
    var last = localStorage.getItem('airis-os.last');
    if (!location.hash && last && byId[last] && !byId[last].hidden) {
      whisperSay('Welcome back — “' + byId[last].name + '” is where you left off.', 'local memory');
    }
  } catch (e) {}
}

fetch('./manifest.json', { cache: 'no-store' })
  .then(function (r) {
    if (!r.ok) throw new Error('manifest HTTP ' + r.status);
    return r.json();
  })
  .then(function (m) { boot(m); })
  .catch(function (err) {
    // Boot guard: hide OS chrome, reveal the floor with the error in one line.
    floor.fail('Shell boot failed (' + err.message + '). Try ls for standalone app links.');
  });

})();
