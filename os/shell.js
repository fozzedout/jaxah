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
  a.launch = a.launch || 'auto';         // auto | window | sheet
  a.desktop = a.desktop || {};
  a.phone = a.phone || {};
  if (!a.desktop.slot) a.desktop.slot = 'window';
  if (!a.phone.slot) a.phone.slot = 'sheet';
  return a;
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

/* ── Halo: colour is state ────────────────────────────────────────────── */
function setHalo(state) {
  halo.classList.remove('calm', 'attentive', 'alert');
  halo.classList.add(state);
  osEl.setAttribute('data-presence', state);
  var sb = $('sb-theme');
  if (sb) sb.textContent = state === 'alert' ? '●' : '◐';
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
function sizeFor(app) {
  var vw = wins.clientWidth, vh = wins.clientHeight;
  var w, h;
  if (app.size === 'small') { w = 480; h = 560; }
  else if (app.size === 'full') { w = vw - 20; h = vh - 20; }
  else { // "window"
    var dw = app.desktop.width || 920, dh = app.desktop.height || 620;
    w = vw >= 1024 ? dw : Math.min(dw, vw - 40);
    h = Math.min(dh, vh - 140);
  }
  return { w: Math.max(300, Math.min(w, vw - 20)), h: Math.max(220, Math.min(h, vh - 20)) };
}

function focusWin(id) {
  Object.keys(openWins).forEach(function (k) {
    openWins[k].style.zIndex = k === id ? ++zTop : openWins[k].style.zIndex;
    openWins[k].classList.toggle('focused', k === id);
  });
  refreshTasks();
}

function openApp(id) {
  var app = byId[id];
  if (!app) { floor.show('no such app: ' + id); return; }
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
    (external ? '<a class="w-ext" role="button" title="open standalone" href="' + esc(app.url) + '" target="_blank" rel="noopener">↗</a>' : '') +
    '<button class="w-min" title="minimise" aria-label="minimise">–</button>' +
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

  if (app.size !== 'full' && !isPhone()) {
    var s = sizeFor(app);
    var n = cascade++ % 6;
    el.style.width = s.w + 'px';
    el.style.height = s.h + 'px';
    el.style.left = Math.max(10, (wins.clientWidth - s.w) / 2 + (n - 2) * 28) + 'px';
    el.style.top = Math.max(10, (wins.clientHeight - s.h) / 3 + (n - 2) * 24) + 'px';
  }
  el.style.zIndex = ++zTop;

  title.addEventListener('pointerdown', function (ev) {
    if (isPhone() || ev.button !== 0) return;
    if (ev.target.closest('button') || ev.target.closest('a')) return;
    ev.preventDefault();
    var r = el.getBoundingClientRect();
    var dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    title.setPointerCapture && title.setPointerCapture(ev.pointerId);
    var move = function (me) {
      el.style.left = Math.min(wins.clientWidth - 80, Math.max(-r.width + 80, me.clientX - dx)) + 'px';
      el.style.top = Math.min(wins.clientHeight - 46, Math.max(0, me.clientY - dy)) + 'px';
    };
    var up = function () {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', up);
      title.removeEventListener('pointercancel', up);
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
    title.addEventListener('pointercancel', up);
    focusWin(id);
  });
  el.addEventListener('pointerdown', function () { focusWin(id); }, true);
  title.querySelector('.w-close').addEventListener('click', function () { closeApp(id); });
  title.querySelector('.w-min').addEventListener('click', function () {
    if (isPhone()) closeApp(id); // ⌄ closes on phone
    else { el.classList.add('min'); refreshTasks(); }
  });

  wins.appendChild(el);
  openWins[id] = el;
  focusWin(id);
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
  if (location.hash === '#app/' + id) history.replaceState(null, '', location.pathname + location.search);
  // Whisper demo: closing Lexfall is the one proactive line in v1,
  // with its reason visible. Nothing else nags.
  if (id === 'lexfall') {
    setHalo('attentive');
    whisperSay('“New best in Lexfall — replay?”', 'demo · lexfall closed');
    setTimeout(function () { if (!Object.keys(openWins).length) setHalo('calm'); }, 20000);
  }
  if (!Object.keys(openWins).length && halo.classList.contains('attentive') === false) setHalo('calm');
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
}
function closeSummon() { summon.hidden = true; }

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
  floor.ready(APPS);
  if (osEl.hidden) return;
  route();
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
