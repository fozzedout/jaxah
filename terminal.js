/* Standalone floor: no shell, manifest, storage, or network required.
   Load before shell.js so even its load/parse/init failures are recoverable. */
(function () {
'use strict';

var terminal = document.getElementById('terminal');
var output = document.getElementById('term-out');
var input = document.getElementById('term-in');
var os = document.getElementById('os');
var hint = document.getElementById('term-hint');
var ready = false;
var requested = new URLSearchParams(location.search).get('terminal') === '1' || location.hash === '#terminal';
var timer = null;
var queue = [];
var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Independent launch links remain available when the manifest cannot load.
var apps = [
  ['session', 'Session', '#app/session'],
  ['store', 'Store', '#app/store'],
  ['lexfall', 'Lexfall', 'https://lexfall.com'],
  ['lexfall-local', 'Lexfall (local)', 'lexfall.html'],
  ['persona', 'Persona', 'apps/persona.html'],
  ['todo', 'To Do', 'apps/todo.html'],
  ['desk', 'Desk', 'apps/desk.html'],
  ['house', 'House', 'apps/house.html'],
  ['fuel-calc-uk', 'Fuel Calc', 'fuel-calc-uk.html'],
  ['lsb-coding', 'LSB Lab', 'lsb-coding.html'],
  ['lsb-pwman', 'LSB Password Manager', 'lsb-pwman.html'],
  ['jeb-gallery', 'JEB Gallery', 'art/jeb/index.html'],
  ['rusty', 'Rusty', 'rustys-commands.html'],
  ['reveal', 'Reveal', 'reveal.html'],
  ['trie-test', 'Trie Test', 'trie-test.html'],
  ['idb-test', 'IDB Test', 'idb-test.html'],
  ['breaking-firefox', 'Breaking Firefox', 'breaking-firefox.html'],
  ['lexfall-settings', 'Lexfall Settings', 'settings.html'],
  ['repo', 'Repo', 'repo.html']
];

function scroll() { terminal.scrollTop = terminal.scrollHeight; }

// One queue keeps typed replies in order, even when commands arrive quickly.
function typeNext() {
  if (!queue.length) { timer = null; return; }
  var item = queue[0];
  item.at = reducedMotion.matches ? item.text.length : item.at + 3;
  item.node.textContent = item.text.slice(0, item.at);
  scroll();
  if (item.at >= item.text.length) {
    item.row.removeAttribute('aria-busy');
    queue.shift();
  }
  timer = setTimeout(typeNext, 12);
}

function print(text, cls, app) {
  var row = document.createElement('div');
  row.className = cls || 'reply';
  row.appendChild(document.createTextNode(cls === 'user' ? 'You · ' : 'Airis · '));
  var node = document.createElement(app ? 'a' : 'span');
  if (app) node.href = app[2];
  row.appendChild(node);
  output.appendChild(row);
  if (cls === 'user') node.textContent = text;
  else {
    row.setAttribute('aria-busy', 'true');
    queue.push({ row: row, node: node, text: text, at: 0 });
    if (timer === null) typeNext();
  }
  scroll();
}

function show(reason) {
  requested = true;
  os.hidden = true;
  terminal.hidden = false;
  document.body.classList.add('term');
  if (reason) print(reason, 'err');
  hint.textContent = ready ? 'Scripted, local replies · help · exit or Ctrl+` returns to the OS'
    : 'Scripted, local replies · help · apps open as standalone pages';
  input.focus();
}

function hide() {
  if (!ready) {
    print('The shell is unavailable. I can still reply here; try ls or open persona.');
    return;
  }
  document.body.classList.remove('term');
  requested = false;
  terminal.hidden = true;
  os.hidden = false;
  os.focus();
  if (location.hash === '#terminal') history.replaceState(null, '', location.pathname + location.search);
}

function fail(reason) {
  ready = false;
  show(reason || 'The shell is unavailable. The terminal is still here.');
}

function command(raw) {
  if (!raw.trim()) return;
  print(raw, 'user');
  var parts = raw.trim().split(/\s+/);
  var cmd = parts[0].toLowerCase();
  var arg = parts.slice(1).join(' ');
  // When the shell is up, OS commands go through its action registry (and
  // land in the trail); when it is not, the floor answers on its own.
  var room = ready && window.airis && typeof window.airis.run === 'function' ? window.airis : null;
  if (cmd === 'help') {
    print(room
      ? 'Commands: ls · open <id> · close <id> · install <id> · uninstall <id> · theme dark|light · trail · export · state · log · about · clear · exit. Session is the live agent: open session.'
      : 'Say hello or ask who are you. Commands: ls · open <id> (standalone) · about · theme dark|light · clear · exit.');
  } else if (room && cmd === 'state') {
    print(JSON.stringify(room.state(), null, 1));
  } else if (room && cmd === 'log') {
    room.trail().slice(-15).forEach(function (ev) { print(ev.t.slice(11, 19) + ' ' + ev.actor + ' ' + ev.action + ' ' + ev.detail); });
  } else if (room && ['open', 'close', 'focus', 'install', 'uninstall', 'export', 'trail', 'note'].indexOf(cmd) !== -1) {
    room.run(raw, 'human').then(function (res) {
      print(cmd + (arg ? ' ' + arg : '') + ': ' + (typeof res === 'string' ? res : 'done') + '.');
      if (cmd === 'open' || cmd === 'focus') hide();
    }, function (err) { print(err.message, 'err'); });
  } else if (cmd === 'ls') {
    apps.forEach(function (app) { print(app[0] + ' — ' + app[1], '', app); });
  } else if (cmd === 'open') {
    var app = apps.filter(function (a) { return a[0] === arg; })[0];
    if (app && app[2].charAt(0) === '#') print('That app runs inside the OS only; the shell is unavailable right now.', 'err');
    else if (app) location.assign(app[2]);
    else print('No such app. Try ls.', 'err');
  } else if (cmd === 'theme') {
    if (arg === 'dark' || arg === 'light') {
      if (room) room.run('theme ' + arg, 'human');
      else {
        document.documentElement.setAttribute('data-theme', arg);
        try { localStorage.setItem('airis-os.theme', arg); } catch (e) {}
      }
      print('Theme: ' + arg + '. The terminal keeps its own colours.');
    } else print('Try theme dark or theme light.', 'err');
  } else if (cmd === 'clear') {
    clearTimeout(timer); timer = null; queue = []; output.textContent = '';
  } else if (cmd === 'exit') {
    hide();
  } else if (/^(hi|hello|hey)\b/i.test(raw.trim())) {
    print("Hello. I'm scripted, not live. You can talk to me here even when the shell is unavailable. For a live agent: open session.");
  } else if (cmd === 'about' || /who are you|your name|are you (live|real)/i.test(raw)) {
    print("I'm Airis. I'm scripted, not live. Persona is my full presence; this terminal is my standalone fallback. No backend or live AI.");
  } else {
    print("I'm scripted, not live. I only know a few local replies. Try hello, who are you, or help.");
  }
}

document.getElementById('term-form').addEventListener('submit', function (event) {
  event.preventDefault();
  var raw = input.value;
  input.value = '';
  command(raw);
  if (!terminal.hidden) input.focus();
});

document.addEventListener('keydown', function (event) {
  var active = document.activeElement;
  var typing = active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
  if (event.key === '`' && (event.ctrlKey || event.metaKey || !typing)) {
    event.preventDefault();
    terminal.hidden ? show() : hide();
  }
});
window.addEventListener('hashchange', function () {
  if (location.hash === '#terminal') show();
  else if (ready && /^#app\//.test(location.hash) && !terminal.hidden) hide();
});
window.addEventListener('error', function (event) {
  var target = event.target;
  if (target && target.tagName === 'SCRIPT' && /\/shell\.js(?:[?#]|$)/.test(target.src)) {
    fail('The shell script could not load. I can still reply here.');
  } else if (event.message) {
    fail('Shell error: ' + (event.message || 'unknown error') + '. I can still reply here.');
  }
}, true);
window.addEventListener('unhandledrejection', function () {
  fail('The shell stopped unexpectedly. I can still reply here.');
});

window.AirisTerminal = {
  show: show,
  fail: fail,
  update: function (installed) {
    apps = installed.map(function (a) {
      return [a.id, a.name, a.install === 'code' ? '#app/' + a.id : a.url];
    });
  },
  ready: function (installed) {
    window.AirisTerminal.update(installed);
    ready = true;
    if (requested) show();
    else hide();
  }
};
print("I'm Airis. I'm scripted, not live. Say hello or type help.");
})();
