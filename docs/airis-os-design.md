# Airis OS — Design Document

> Status: static playground implemented under `/os/`. Goal: explore what an
> ever-present AI companion's desktop should feel like on Paul's public
> site. No auth, no backend, static files only (Cloudflare Pages).

## 1. Presence hierarchy: persona, terminal floor, prompt marker

**Persona is Airis's full presence. The terminal floor is her standalone
fallback. The orb is only a prompt marker, never her body.**

1. **Persona (full presence).** `/os/apps/persona.html` is the deliberate,
   named surface for meeting Airis. Its scripted answer is exactly
   `I'm scripted, not live.` The Ask and Speak controls play a matching
   canned recording from `/os/assets/airis-scripted.mp3`; Stop interrupts
   it. The recording was generated offline with eSpeak NG (`en-gb+f3`),
   then encoded as MP3. No speech service or browser speech synthesis runs
   alongside it. She is a resident persona, explicitly not a live AI.
2. **Terminal floor (standalone fallback).** A direct text input and Airis's
   typed replies share one pane. A small breathing dot marks the input
   prompt. This is a usable local conversation and command surface even
   when the shell script is missing, invalid, or throws, or the manifest
   cannot load. Its replies are a tiny scripted rule set, not live AI.
3. **Orb / Halo (prompt marker only).** An eight-pixel breathing dot sits
   inside the taskbar or dock's Summon button. It identifies an invitation
   to type; it does not represent Airis's body or float above apps. Colour
   can reflect local state (teal calm, amber attentive). The terminal has
   its own independent prompt dot. Reduced-motion settings stop breathing.

The **Whisper Strip** is a quiet, single-line contextual caption with a
visible reason. It fades after about eight seconds, never scrolls or stacks,
and stays behind app windows. The **Summon** (`⌘K` / `Ctrl+K`, or the prompt
button) is an app and command palette. It can launch apps, change the theme,
and enter the terminal; it is not Airis's full presence.

Nothing opens proactively over an app's work area. Persona and Summon open
on request. The current Lexfall whisper is explicitly labelled as a demo
triggered by closing the app, not a claim that the shell read a game score.

## 2. Architecture: independent floor / shell / manifest / app

```
index.html — terminal visible by default; OS chrome hidden until ready
├ terminal.css + terminal.js — independent input, replies, app links, guards
└ shell.css + shell.js — OS chrome, window manager, routing
  ├ manifest.json — app inventory
  └ sandboxed iframe per app — Persona, To Do, existing standalone pages
```

- **Floor.** `terminal.js` loads before `shell.js`, binds its own form and
  keyboard door, and installs failure guards. It does not call shell
  functions or fetch the manifest. Its CSS is separate from shell styling.
  It owns `window.AirisTerminal`; the shell only signals `ready(apps)`,
  `show(reason)`, or `fail(reason)` through that small interface.
- **Shell.** Owns OS chrome, focus, theming, desktop dragging, taskbar/dock,
  app routing (`#app/<id>`), and sandbox creation. It reveals the OS only
  after the manifest and initial rendering succeed. It ships no app code.
- **Manifest (`manifest.json`).** The install database includes
  `{ id, name, title, icon, url, category, description }` plus size,
  desktop/phone layout, pinning, and visibility hints. Empty, invalid, or
  unavailable manifests leave the terminal usable. Hidden dev apps remain
  discoverable through the terminal's app list.
- **Apps.** Standalone pages loaded in
  `<iframe sandbox="allow-scripts">`. Without `allow-same-origin`, apps have
  opaque origins and cannot access shell DOM or storage. No message bridge
  is defined. Local app URLs are relative to `/os/`; Lexfall is the explicit
  external exception at `https://lexfall.com`, also allowed by the shell CSP.

The sandbox bounds each app to its own rectangle. The shell CSP limits
scripts, assets, media, and connections to the static site, with Lexfall
allowed as an external frame. The shell adds no auth or backend.

## 3. Terminal fallback: the floor everything stands on

**What it is.** A dependency-free local terminal with direct text entry,
scripted Airis replies typed in the same pane, and a small breathing prompt
dot. It supports `hello`, `who are you`, `help`, `ls`, `open <id>`, `about`,
`theme dark|light`, `clear`, and `exit`. Reply text is inserted as text, not
interpreted as HTML. Reduced motion shows each reply without typing animation.

**What survives.** The terminal markup is visible before shell startup.
Its independent runtime handles a failed script load, parse error, early or
later uncaught shell error, and unhandled rejection. The shell reports
manifest/initial-render failures directly to it. If `shell.js` cannot run,
the terminal still accepts input and replies. A baked-in app list means
`ls` still supplies real links and `open <id>` navigates directly to the
standalone page without the shell or hash router. A successful shell boot
updates that list from the manifest; unavailable storage is harmless.

**How to reach it.** Summon command `terminal`, a bare backtick when not
editing text, Control or Command plus backtick when typing, `?terminal=1`,
or `#terminal`.
`exit` or the shortcut returns to a successfully booted shell; if the shell
has failed, Airis explains that the terminal is still available and stays
put. The form also has a Send button for touch use. With JavaScript disabled,
a separate static app-link list remains available; interactive replies
require the independent terminal runtime.

## 4. Desktop vs phone: one page, stable layers

CSS switches at **768px**, with roomier desktop defaults at **1024px**.
No separate builds or user-agent sniffing.

| | Desktop (≥768px) | Phone (<768px) |
|---|---|---|
| Metaphor | Overlapping draggable app windows | Home grid, one full-height app sheet at a time |
| App area | Stage ends above the taskbar; full-size windows stay in this area | App sheet covers the home status bar and dock; close reveals them |
| Prompt marker | Small dot inside taskbar Summon button | Small dot inside dock Summon button, behind an open app |
| Summon | `⌘K` / `Ctrl+K`, centred palette, 8 app results | Dock button or shortcut, bottom-sheet palette, 5 app results |
| Terminal | Independent full-pane text input and replies | Same terminal, touch Send control |

The windows container has one fixed stacking context above home-screen
chrome (including the dock, markers, and Whisper Strip). Individual window
focus changes only the order inside that container. Summon is above it in
its own fixed layer, so repeated window focus cannot cover the palette.
Desktop taskbar controls remain outside the app work area. Phone sheets
fill their area even after resizing from desktop, and the dock cannot
intercept taps in an app. Sandboxed app code cannot alter these layers.

Theme and last-app hints use best-effort `localStorage`. Reduced motion
stops prompt breathing and Whisper transitions. Persona, terminal replies,
manifest, and iframe isolation keep the same meaning in both layouts.

## 5. Candidate app inventory (existing pages → Airis OS entries)

| Manifest id | Source page | Title / category | Notes |
|---|---|---|---|
| `lexfall` | `lexfall.html` | Lexfall · Games | Flagship; drives the Whisper Strip demo ("new best") |
| `lexfall-settings` | `settings.html` | Lexfall Settings · System | Candidate for folding into a Settings app, not a tile |
| `fuel-calc` | `fuel-calc-uk.html` | Fuel Calculator · Utilities | Clean single-file fit |
| `lsb-coding` | `lsb-coding.html` | LSB Lab · Tools | Merge `lsb-coding.css/js`, `lsb-png.js` stay as-is alongside |
| `trie-test` | `trie-test.html` | Trie Test · Dev | Two existing links (`en-words` / `words.txt`) → one tile, dataset as in-app option |
| `idb-test` | `idb-test.html` | IndexedDB Test · Dev | Dev-folder candidate; maybe hidden by default |
| `rusty` | `rustys-commands.html` | Rusty's Commands · Fun | Niche single-purpose page, fine as tile |
| `jeb-gallery` | `art/jeb/index.html` | JEB Gallery · Art | Only subfolder app; needs relative-asset check in iframe |
| `reveal` | `reveal.html` | Secure Reveal · Tools | Needs blurb clarifying static-only limits |
| `breaking-firefox` | `breaking-firefox.html` | Breaking Firefox · Dev | Joke/demo page; include or hide behind `hidden: true` flag |

`lsb-pwman` is not shipped: the root `lsb-pwman.html` is Paul's uncommitted
work in progress. It is omitted from the manifest, terminal links, and no-JS
list until a supported app is ready. The OS does not copy or modify it.

Non-apps (stay out of manifest): `en-words*`, `words*` data files, `pink.png`,
`lsb-*.js/css` includes. Proposed manifest field `hidden: true` covers dev
pages without deleting them.

## 6. Open questions for Paul

1. Future persona behaviours beyond the fixed, visibly scripted line and
   matching canned recording? Live AI would require a separate design.
2. Which apps are pinned vs buried — is Lexfall the hero, or a neutral grid?
3. Should dev/test pages (`trie-test`, `idb-test`, `breaking-firefox`) ship
   visible, `hidden`, or split into a second "Dev" manifest?
4. Window manager ambition: real dragging/resizing, or fake it with
   cascade/tile presets for v1?
5. Theming: one Airis look, or light/dark/system toggle as a shell setting?
6. Deep links: do `#app/<id>` URLs matter for sharing individual apps?
7. Sound/motion budget beyond the explicit Persona playback? The prompt
   marker is silent and reduced motion stops its breathing.
8. `settings.html` today is Lexfall-only — grow it into OS Settings, or keep
   per-app settings inside apps?
