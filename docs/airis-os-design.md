# Airis OS — Design Document

> Status (2026-11-14): Airis OS **is the whole site**, served by one
> Cloudflare Worker (`wrangler.jsonc`, `worker.js`) with the repo root as
> static assets. **The rules live in `/airis.contract.json`** — manifest
> schema, app conventions, sandbox, CSP, bridge, actions, install records,
> Worker routes, tests. Where this document disagrees with the contract, the
> contract wins; this file keeps the design reasoning and history.
>
> Principle: agent-friendly, not AI-first. The OS is a shared room — a human
> and an agent act on the same surface through one action registry, every
> action lands in one visible trail with its actor, and the whole state is
> plain JSON (`window.airis.state()`). Session (`apps/session.html`) is a
> blank, bring-your-own-key live agent. Its provider presets are data
> (`manifest.json` → session `settings.presets`) and each says how it is
> reached: **proxy** or **direct** (`contract → sessionPreset`). OpenCode Go
> is proxy: the Worker's `/api/go` route is a same-origin passthrough because
> opencode.ai answers a CORS preflight with HTTP 404 and no
> `access-control-*` headers (measured 2026-11-14, both
> `/zen/go/v1` and `/inference/go/openai/v1`), so no browser can call it.
> The strip shows `opencode.ai` read-only, never `/api/go` as if it were the
> provider's URL. OpenRouter is direct: its preflight answers HTTP 204 with
> `access-control-allow-origin: *`, so the browser calls
> `https://openrouter.ai/api/v1` itself and the base URL is editable. Apps install as records in localStorage (code included), export
> as one JSON bundle and import back — no accounts, no server storage.
>
> Sections 1–6 below describe the v1 shell; paths that said `/os/` now live
> at the root (`/os/*` 301-redirects).

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
  opaque origins and cannot access shell DOM or storage. Privileges go
  through the postMessage bridge defined in the contract. Local app URLs are relative to `/`. Lexfall opens standalone
  in its own browser tab at `https://lexfall.com` because the site sends
  `frame-ancestors 'none'`, which forbids embedding.

The sandbox bounds each app to its own rectangle. The shell CSP limits
scripts, assets, media, and connections to the static site. Its frame policy
still allows Lexfall, but the manifest launches it standalone rather than in
an external frame. The shell adds no auth or backend.

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
Desktop windows stay within the stage's 10px margins on cascade, drag, and
resize, keeping them above the taskbar and clear of its Halo. Window heights
shrink below the usual 220px minimum when the stage is too short to fit it.
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

`lsb-pwman.html` is listed as a standalone app; the OS does not modify it.

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
