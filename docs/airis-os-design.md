# Airis OS — Design Document

> Status: design experiment, not a build spec. Goal: explore what an
> ever-present AI companion's desktop should *feel* like on Paul's public
> static site. No auth, no backend, static files only (Cloudflare Pages).

## 1. Concept: Airis is the room, not an app

**Opinion: Airis is never a window you open — she is a layer you live in.**
Every other OS puts the assistant in a box (a chat tab, a sidebar, a popup).
Airis OS inverts that: apps are the boxes; Airis is the desk they sit on.
She is ambient, peripheral, and summonable — never modal, never blocking.

Concretely, her presence has three fixed elements on every screen:

1. **The Halo (ambient presence).** A small live orb in a screen corner
   (bottom-right desktop, top-edge phone). It breathes — a slow pulsing
   gradient, no text. Colour is state, not decoration: soft teal = idle,
   warm amber = "I noticed something" (e.g. you finished a game of Lexfall),
   red flicker = shell error / terminal fallback available. No badges, no
   notification counts; she doesn't nag.
2. **The Whisper Strip (resident suggestion, not chat).** A single-line,
   low-contrast caption docked above the taskbar / below the status bar that
   offers at most one contextual line: `Airis · "New best in Lexfall — replay?"`.
   It fades after ~8s if ignored. It never scrolls, never stacks, never
   demands a reply. Dismissing it is free and it learns nothing (no backend).
3. **The Summon (⌘K / tap-Halo).** The only "full" Airis surface: a centred
   command-palette overlay. Type to launch apps (`lex…`), run shell commands
   (`help`, `about`, `theme dark`), or ask scripted questions she answers
   locally from a tiny rule set (`who are you`, `what can I run`). She is
   explicitly **not** a live AI here — the doc calls her a *resident persona*:
   scripted, on-device, honest about it. The experiment is about *placement
   and manners*, not intelligence.

Design rules for her manners: she never auto-opens; she never covers an app's
work area without being summoned; she speaks in one line unless asked for
more; every proactive line has a visible "why" (the triggering event).

## 2. Architecture: shell / manifest / app

Three layers, each replaceable without touching the others:

```
┌ shell (index.html + airis-shell.js/css) ─ OS chrome only ─────────┐
│  Halo · Whisper Strip · Summon · taskbar/dock · window manager     │
│  reads ──► apps.json (manifest)                                    │
│  hosts ──► <iframe sandbox> per app                                │
└────────────────────────────────────────────────────────────────────┘
```

- **Shell.** One static page. Owns all OS chrome, focus/z-order, theming,
  routing (`#app/<id>` deep links), and the terminal fallback ( §3 ). Ships
  zero app code. Only global JS on the page.
- **Manifest (`apps.json`).** The entire "install database": array of
  `{ id, title, icon, url, category, description }`. Adding/removing an app
  is editing this file — the shell renders whatever it lists. A broken entry
  (404, bad icon) degrades to a generic tile, never breaks boot.
- **Apps.** The existing standalone pages, unmodified, loaded one per
  `<iframe sandbox="allow-scripts" ...>`. Deliberately **no**
  `allow-same-origin`: the frame gets an opaque origin, so app JS cannot reach
  the shell DOM, read `localStorage` of the shell, or walk other frames —
  and the shell cannot reach into app internals either. Communication, if
  ever needed, is only via `postMessage` with an allowlist (v1: none defined;
  shell needs nothing from apps for this experiment).

**Security reasoning (static site, no backend):** the threat is a weird app
page (now or later) escaping into the shell or into another app. Sandboxed
opaque-origin iframes plus "no `allow-same-origin`, no `allow-top-navigation`"
remove the whole class: worst case, a hostile page can only misbehave inside
its own rectangle. Add a restrictive CSP on the shell (`frame-src 'self'`)
and `X-Frame-Options`-independent isolation falls out for free. Manifest
entries are same-origin relative URLs only — no third-party frames in v1.

## 3. Terminal fallback: the floor everything stands on

**What it is.** A plain, dependency-free terminal layer (`<div>` + ~50 lines
of inline/vanilla JS, no Tailwind CDN needed): fixed black-green console with
`airis> ` prompt, commands `help · ls · open <id> · about`. It can list and
link every app straight from a baked-in list or `apps.json`, so it works even
when the window manager, fonts, or CDN fail.

**When it shows.** (a) Boot guard: if `apps.json` fails to load/parse, or the
shell JS throws during init, the shell hides OS chrome and reveals the
terminal with the error in one line. (b) No-JS / no-CDN: a `<noscript>`-style
static block renders the same app list as plain links. It is a *degraded
truth*, not an error page — the site stays usable.

**How a user reaches it on purpose.** Three equivalent doors: Summon command
`terminal`; key `Ctrl+`` (backtick) anywhere; URL `?terminal=1` / `#terminal`.
`exit` or `Ctrl+`` again returns to the OS. The fallback never "phones home"
— the name is literal: local terminal, local commands, no Airis intelligence
implied. First-run hint lives in the Summon placeholder: `Type 'terminal' anytime.`

## 4. Desktop vs phone: same page, two bodies

One HTML file, CSS-driven identity switch at **`768px`** (Tailwind `md:`),
with a secondary widening at `1024px` (windows gain default sizes). No
separate builds, no UA sniffing; resize the browser and the OS morphs live.

| | Desktop (≥768px) | Phone (<768px) |
|---|---|---|
| Metaphor | Desktop OS: overlapping draggable windows + taskbar | Phone home screen: app grid, one app at a time |
| App view | Windows: drag by titlebar, focus-to-front, minimise to taskbar, close. 2–3 visible is normal | Full-screen sheet: app fills viewport, swipe-down / ⌄ closes, no overlap |
| Bar | Bottom taskbar: Start/Halo, pinned apps, clock, Summon hint | Top status bar (time, Halo) + bottom dock (4 pinned + Summon button) |
| Summon | `⌘K / Ctrl+K`, centred palette, 8 results | Tap Halo / dock button, bottom-sheet palette, 5 results, large rows |
| Halo | Bottom-right corner orb | Top-edge centre pill (thumb-safe, out of dock's way) |

**What adapts:** window management (exists only on desktop), bar position,
Summon shape, icon density (desktop 96px grid, phone 72px, 4-across).
**What stays:** Halo + Whisper Strip + Summon *semantics* (same commands,
same scripted persona lines), manifest, iframe sandboxing, terminal access.
State (open app, theme) persists in `localStorage` keyed identically on both.

Touch rules: nothing hover-only (all window controls are real buttons ≥44px);
drag is desktop-pointer-only, never required on phone. Reduced-motion
(`prefers-reduced-motion`) freezes Halo breathing and window animation.

## 5. Candidate app inventory (existing pages → Airis OS entries)

| Manifest id | Source page | Title / category | Notes |
|---|---|---|---|
| `lexfall` | `lexfall.html` | Lexfall · Games | Flagship; drives the Whisper Strip demo ("new best") |
| `lexfall-settings` | `settings.html` | Lexfall Settings · System | Candidate for folding into a Settings app, not a tile |
| `fuel-calc` | `fuel-calc-uk.html` | Fuel Calculator · Utilities | Clean single-file fit |
| `lsb-coding` | `lsb-coding.html` | LSB Lab · Tools | Merge `lsb-coding.css/js`, `lsb-png.js` stay as-is alongside |
| `lsb-pwman` | `lsb-pwman.html` | Password Manager · Tools | Flag: local-only story must be explicit in tile blurb |
| `trie-test` | `trie-test.html` | Trie Test · Dev | Two existing links (`en-words` / `words.txt`) → one tile, dataset as in-app option |
| `idb-test` | `idb-test.html` | IndexedDB Test · Dev | Dev-folder candidate; maybe hidden by default |
| `rusty` | `rustys-commands.html` | Rusty's Commands · Fun | Niche single-purpose page, fine as tile |
| `jeb-gallery` | `art/jeb/index.html` | JEB Gallery · Art | Only subfolder app; needs relative-asset check in iframe |
| `reveal` | `reveal.html` | Secure Reveal · Tools | Needs blurb clarifying static-only limits |
| `breaking-firefox` | `breaking-firefox.html` | Breaking Firefox · Dev | Joke/demo page; include or hide behind `hidden: true` flag |

Non-apps (stay out of manifest): `en-words*`, `words*` data files, `pink.png`,
`lsb-*.js/css` includes. Proposed manifest field `hidden: true` covers dev
pages without deleting them.

## 6. Open questions for Paul

1. Airis honesty: scripted-local persona with a visible "I'm not live" line,
   or silent and let visitors assume? This sets the tone of the whole demo.
2. Which apps are pinned vs buried — is Lexfall the hero, or a neutral grid?
3. Should dev/test pages (`trie-test`, `idb-test`, `breaking-firefox`) ship
   visible, `hidden`, or split into a second "Dev" manifest?
4. Window manager ambition: real dragging/resizing, or fake it with
   cascade/tile presets for v1?
5. Theming: one Airis look, or light/dark/system toggle as a shell setting?
6. Deep links: do `#app/<id>` URLs matter for sharing individual apps?
7. Sound/motion budget: silent + reduced-motion-first, or is a little Halo
   chime part of the character?
8. `settings.html` today is Lexfall-only — grow it into OS Settings, or keep
   per-app settings inside apps?
