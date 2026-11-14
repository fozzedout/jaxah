# Airis OS: workspace storage policy, design study

*Status: study, 2026-11-14. Pressure-tests the unbounded-versioning store in `docs/bench-design.md` §3 against real browser storage limits. No implementation code was written. `lib/fs.js` is being built separately, so this document recommends and does not prescribe line-level changes.*

---

## 0. Answer first

**The quota wall is not where the risk is. Eviction is.** Since Safari 17 (Sept 2023), every major engine gives an origin a quota measured as a share of the *disk*: 60% in Chromium and Safari, at least 10 GiB best-effort in Firefox. The worked example below (150 files, 2 KB each, 100 versions per file, plus the agent journal) costs about **96 MB as naively stored** and about **25 MB with the recommended layout**. That is under 0.3% of the nominal quota on a 64 GB iPhone. Unbounded history does not run into the quota for any workspace v1 is going to have.

What *does* lose a workspace:

1. **Safari's 7-day cap on script-writable storage** in an ordinary Safari tab.
2. **Eviction of a best-effort origin under storage pressure** on a nearly full phone. It is whole-origin, all or nothing, and no `QuotaExceededError` ever fires.
3. **Private windows** and **clearing site data**.

None of these cares how much history you keep. Paul's instinct that "browser storage is the major limitation" is right, but the limit is *durability*, not *capacity*.

**Recommended default:**

1. **Keep every version** (no ring buffer).
2. **Compress blobs** with `deflate-raw`.
3. **Stop the agent journal duplicating file content** (store blob references instead).
4. **Squash with run boundaries preserved:** old intra-run steps are thinned, but every run's before/after is kept. A **self-imposed 1 GiB budget** has a 60/80/95% ladder (§4).
5. **Make durability the headline work:** `persist()`, the iOS Home Screen app as the supported iPhone home for workspaces, and export as a real backstop with a "last exported" clock.

Deltas, offload to the Worker and per-file caps are all rejected for v1. The reasons and the trigger for revisiting each are in §3.

---

## 1. Real browser limits (sources accessed 2026-11-14)

### Quotas

| Engine | Per-origin quota | Whole-browser cap | Source |
|---|---|---|---|
| Chrome / Edge (Chromium) | "up to **60% of the total disk size** in both persistent and best-effort modes" | "at most **80%** of the total disk size" | [MDN, Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), last modified 2026-01-05; [web.dev, Storage for the web](https://web.dev/articles/storage-for-the-web) (2024 update) |
| Firefox, best-effort | "the smaller of: **10%** of the total disk size … Or **10 GiB**, the group limit … for all origins that are part of the same site" | — | MDN (above) |
| Firefox, persistent | "up to **50%** of the total disk size, capped at 8 TiB, and … not subject to the group limit" | — | MDN (above) |
| Safari 17+ / iOS 17+ (browser apps, and Home Screen web apps) | "up to **60%** of the total disk space" | **80%** of disk | [WebKit, Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/), 2023-08-10 |
| Safari 17+ in other apps (WKWebView, in-app browsers) | "up to **15%**" | 20% | WebKit (above) |
| Cross-origin frames (Safari) | 10% of the parent origin's quota | — | WebKit (above) |
| Safari before 17 / iOS before 17 | "an initial **1 GiB** quota. Once the origin reaches this limit, Safari asks the user for permission" | — | MDN (above) |

Quotas are computed from *total* disk, not free disk, to reduce fingerprinting (MDN). So a phone with 2 GB free still reports a quota in the tens of GB. **The quota number tells you nothing about whether the next write fits on a full device.**

One widely repeated claim, that iOS writes fail at about 50 MB whatever `estimate()` says, appears in third-party guides only. I found no primary source for it, and it predates the iOS 17 policy. It is not used here, and it is listed as unknown U1.

### What `navigator.storage.estimate()` reports

- **Chromium:** quota is the computed share above. `usage` "can be impacted by internal compression techniques, fixed-size allocation blocks …, tombstone records …, [and] padding" for opaque cross-origin responses ([Chrome for Developers, Estimating available storage space](https://developer.chrome.com/blog/estimating-available-storage-space), undated). Treat `usage` as approximate, not byte-exact.
- **Safari 17+:** "Usage indicates how much space is already used, and the quota is the origin quota". The quota is an upper limit with "no guarantee that a site can store that much", and it "may change with existing usage and visit frequency" (WebKit 2023-08-10).
- **Firefox:** I found no primary source for exactly what Firefox reports as `quota` in best-effort mode (group limit or per-origin). Measured in U2.

### What `persist()` grants

| Engine | Behaviour | Source |
|---|---|---|
| Chromium | No prompt. Auto-granted if the site is "important", judged by engagement, being installed or bookmarked, or holding notification permission. A denial can be retried later. | [web.dev, Persistent storage](https://web.dev/articles/persistent-storage) (undated) |
| Firefox | **Prompts the user.** | MDN; web.dev (above) |
| Safari | No prompt. Granted "based on heuristics like whether the website is opened as a Home Screen Web App". | WebKit 2023-08-10 |

A persistent origin is skipped by LRU and storage-pressure eviction. Its data goes only when the user deletes it (MDN). This is the protection against threat 2 in §0.

### Safari ITP: the 7-day cap

- **What is deleted:** "all cookies created in JavaScript and all other script-writeable storage", meaning IndexedDB, LocalStorage, media keys, SessionStorage, and Service Worker registrations and cache. It happens "after 7 days of no user interaction with the website" ([WebKit Tracking Prevention](https://webkit.org/tracking-prevention/), current page; introduced in [Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), 2020-03-24).
- **What counts as interaction:** "a user click, tap, or keyboard entry on a website. **Scrolling is not considered user interaction.**"
- **What the clock counts:** "seven days *of Safari use*" without interaction (2020 post). Days the browser isn't used don't count. Opening the site without tapping it does not reset the clock.
- **Exemption:** "The first-party domain of **home screen web applications** is exempt … ITP always skips that domain in its website data removal algorithm." Home Screen apps "have their own counter of days of use."
- **Does `persist()` exempt a site?** **No source says so.** The WebKit storage post says persistent origins are excluded from *eviction* and never mentions ITP. The ITP page never mentions persistent storage. A proposal to exempt sites that make no cross-origin requests ([WebKit bug 272189](https://bugs.webkit.org/show_bug.cgi?id=272189), filed 2024-04-04) is still NEW. **Assume `persist()` does not protect a plain Safari tab from the 7-day cap.** Unknown U3.
- An Airis-specific wrinkle: the shell's proxy calls are same-origin, but `net.stream` to a BYO endpoint is cross-origin. Even if bug 272189 shipped, Airis would probably not qualify.

**Consequence for Airis:** on iPhone, a workspace created in a Safari tab can vanish after a week in which Paul used Safari without tapping the site. The Home Screen install that landed in `d268c94` is not a nicety. **It is the only configuration where iOS workspace storage is documented as exempt.** It is widely reported that iOS Home Screen apps get a storage container separate from Safari tabs, so a workspace made in one is invisible in the other. I did not find a primary source for that, and it is listed as U4.

---

## 2. The model, costed

### Measured inputs (this repo, Node 22 `CompressionStream`, which is the same API and codec browsers ship)

Measured on 2026-11-14 over `git ls-files` and the repo's 135-commit history. The scripts are in the study session's scratchpad. They are small and can be rerun.

| Measurement | Result |
|---|---|
| Whole text/code files (43 files, 697 KB): `gzip` / `deflate-raw` | **0.310 / 0.308** of original |
| Text cut into **~2 KB pieces**, each compressed alone (312 pieces) | **0.423 / 0.414**. Small blobs compress worse because there's less context per stream. |
| PNG (22 files) | **0.996**: compressing already-compressed assets buys nothing |
| MP3 (1 file) | 0.776 (small sample; treat as "don't bother") |
| Consecutive versions, files **< 8 KB** (44 pairs): `diff -U0` size / full size | **0.559**. **For small files, an edit really does rewrite about half the file.** |
| Same, deflated diff / full | **0.185**, against **0.317** for deflating the full file. A delta saves only about 42% over plain compression. |
| Consecutive versions, files **8–40 KB** (95 pairs): diff / full, deflated diff / full | 0.236, **0.077** |
| Consecutive versions, files **> 40 KB** (29 pairs) | 0.153, 0.074 |

Caveat: git commits are coarser than agent `fs_edit` steps, so per-step diffs in Bench will be *smaller* than these. That makes the delta case for small files look better than measured here, though not by enough to change §3. That is unknown U5.

**Content-addressed dedup buys about nothing for edited text.** A blob is keyed by the hash of the *whole* file, so any one-character edit makes a new blob. Dedup only fires when a file returns to byte-identical earlier content (undo, revert, a formatter no-op) or when the same file exists in two workspaces. I plan on **0%** savings and treat 5% as the optimistic ceiling. Dedup earns its keep elsewhere: it makes reverts and workspace copies free.

### Worked example: 150 files × 2 KB × 100 versions

Units: 1 KB = 1,000 B, 1 MB = 10⁶ B. "Version" = one successful write = one agent or human step.

- Live tree: 150 × 2,000 B = **300 KB**
- Versions: 150 × 100 = **15,000**
- Raw content: 15,000 × 2,000 B = **30.0 MB**

**Per-row metadata estimates.** These are *my estimates* from the row shapes in bench-design §3. I have not measured them, and engine overhead is unknown U1.

- **`versions` row:** `{ws, path, ver, blob, actor, runId, callId, t, parent}`. That is roughly 20 + 25 + 8 + 64 (hex) + 11 + 26 + 12 + 8 + 8 B of values, plus about 45 B of property names and structured-clone tags, so ≈ 230–250 B. Add the compound primary key `[ws, path, ver]` stored again (≈ 55 B) and one secondary index by `runId` (≈ 80 B). Total ≈ **400 B**.
- **`ops` row:** `{actor, kind, path, from, to, callId, runId, t}` ≈ 200 B, plus a key of ≈ 30 B. Total ≈ **230 B**.
- **Blob key:** 64-char hex string ≈ **64 B** per blob.
- **Journal per step** (from `lib/airis-agent.js:220-226, 316, 333`). `emit()` appends the full assistant message, and `tool_start` carries the full `args`, so an `fs_write` stores the whole file again. `tool_end` carries the full `result`, so an `fs_read` stores the whole file again. A typical step is one `fs_read` (2 KB) + one `fs_edit` (≈ 0.4 KB of old/new) + an assistant turn (≈ 1 KB) + event framing (≈ 0.3 KB) ≈ **3.7 KB**. Reasoning text, if kept, makes this larger.

| Component | As designed now | Recommended layout (§3) |
|---|---|---|
| Blob content | 30.0 MB (0% dedup) | 30.0 × 0.414 = **12.4 MB** (deflate-raw, measured 2 KB ratio) |
| Blob keys | 15,000 × 64 B = 0.96 MB | 32-byte binary keys: 0.48 MB |
| `versions` rows | 15,000 × 400 B = 6.0 MB | trimmed to ≈ 300 B: 4.5 MB |
| `ops` rows | 15,000 × 230 B = 3.45 MB | slimmed to a pointer at the version row (≈ 100 B): 1.5 MB |
| `heads` | 150 × 100 B = 0.015 MB | same |
| **Filesystem subtotal** | **40.4 MB** | **18.9 MB** |
| Agent journal | 15,000 × 3.7 KB = **55.5 MB** | content replaced by blob refs (≈ 1.3 KB/step), closed runs gzipped at ≈ 0.31: **≈ 6.0 MB** |
| **Total** | **≈ 96 MB** (≈ 6.4 KB per step) | **≈ 25 MB** (≈ 1.65 KB per step) |

Two things the arithmetic shows that the design doc didn't anticipate:

1. **The journal, not file history, is the biggest consumer.** As built, it stores each file's content again in tool arguments and results. It costs more than all 15,000 file versions together.
2. **Once blobs are compressed, metadata is about half the store.** Trimming rows and merging `ops` into `versions` matters as much as compression does.

### Against the smallest serious target: iPhone Safari

- **Nominal quota:** a 64 GB iPhone (the base iPhone 11 and iPhone SE 3rd gen shipped at 64 GB and are still in use) gets ≈ 0.6 × 64 GB ≈ **38 GB** per origin under the iOS 17+ policy. 96 MB is **0.25%** of that, and 25 MB is **0.07%**.
- **Pre-iOS-17 device (1 GiB, then a prompt):** 96 MB is 9%, and 25 MB is 2.3%.
- **Real ceiling: free disk.** A full 64 GB phone often has a few GB free. I have no source for typical free space, so I'm not inventing a figure. When the OS reclaims space, a **best-effort** origin is deleted **whole**, regardless of how small it is.

**Verdict:** a 150-file, 100-version workspace **fits with two to three orders of magnitude of headroom** against quota on every engine, including the smallest iPhone. Inside the 1 GiB self-budget in §4 it fits about **40 times** with the recommended layout, or about 11 times as currently designed. The thing that decides whether Paul keeps it is **persistence**, not size.

---

## 3. Candidate policies

"Revert the run" means: for every file a run touched, restore the version that was head when the run started, CAS-checked against the current head (bench-design §3).

| Policy | History fidelity | Complexity in `lib/fs.js` | "Revert the run" guarantee | Verdict |
|---|---|---|---|---|
| **A. Keep everything + export backstop** (current design) | Perfect | Lowest: append-only, no deletion code | Holds forever | **Keep as the base**, with C, G and H applied. Export is the durability backstop, not a capacity tool. |
| **B. Per-file cap / ring buffer** (keep last *N* versions) | Lost by count, not age. Hot files lose history fastest, which is exactly the files the agent works on. | Low | **Breaks silently.** A 60-step run on one file with *N* = 50 deletes that file's pre-run version *during the run*. Revert becomes impossible exactly when it's needed most. | **Reject.** |
| **C. Time-based retention, run-aware** (keep every version for 30 days or the last 20 runs, whichever is more; older history keeps only run boundaries plus one version per file per day) | Intra-run steps are lost after the window. Every run's before and after state is kept forever. | Medium: a squash pass, plus blob GC once squash deletes rows | **Whole-run revert holds forever.** Step-level revert holds inside the window. | **Adopt**, triggered by the §4 ladder, not by a timer. Naive time-based retention, with no run boundaries kept, is rejected because it breaks old run reverts. |
| **D. Checkpoint + delta on the write path** (full snapshot every *k* versions, deltas between) | Perfect | **High:** delta encoder, chain reconstruction, chain repair, CAS against reconstructed content, and diff/search must reconstruct first. A corrupt link loses every later version up to the next checkpoint. | Holds only if chains stay intact, and every revert or diff pays reconstruction cost | **Reject for v1.** Measured: for files under 8 KB a deflated delta is 0.185 of the file against 0.317 for deflating the full file. That is about 42% saved, for a large rise in complexity and fragility. |
| **E. Packfile / GC** (collect unreferenced blobs; in squash, re-encode cold history as deltas) | Same as C for what's kept | Medium for GC alone. High if cold history is delta-packed. | Unaffected: packing only touches history outside the keep window | **GC: adopt with C.** Squash creates orphans, and nothing else does if blob, version, head and op commit in one transaction. **Cold delta packing: defer**, and revisit if bytes per step measured over 20 KB (see "What would change my mind"). It keeps the write path simple, which D does not. |
| **F. Offload cold blobs to the Worker** | Perfect, if the server keeps it | Medium client code, *plus a server*: R2 or KV binding, accounts or capability tokens, quotas, deletion, abuse handling | Revert of cold runs needs the network | **Reject.** It breaks the stated "Worker stores nothing" property (bench-design §1). The cost is identity (whose blobs are these?), holding user code on Paul's infrastructure (privacy and abuse liability), an R2 bill, and making revert depend on uptime. It also solves capacity, which isn't the problem. **The user-owned equivalent is "archive history to a file"**, an export followed by a squash. |
| **G. Compression** (`CompressionStream('deflate-raw')` per blob) | Perfect | Low: async encode on write, decode on read, a one-byte codec tag per blob. Skip when the saving is under 10% (PNG measured 0.996) or the blob is under 256 B. | Unaffected | **Adopt.** Measured 0.414 of original for 2 KB text blobs and 0.308 for whole files. `deflate-raw` rather than `gzip` saves the 18-byte gzip frame, which is about 2% on a 1 KB compressed blob. |
| **H. Journal hygiene** (not in the brief, but the biggest lever found) | Perfect: content is referenced, not copied | Low in `airis-agent.js`/`fs`. The journal must hold `{blob, ver}` refs for `fs_read` results and `fs_write` args. | Unaffected. Journal refs become GC roots, so squash must thin closed-run journals too. | **Adopt.** About 55 → 6 MB in the worked example. |

**Recommendation: A + G + H now, C + E-GC when the ladder first reaches 80%.** Two more cheap changes for `lib/fs.js`, if its owner agrees: store sha256 as a 32-byte `ArrayBuffer` key rather than 64-char hex, and make the `ops` row a slim pointer to the `versions` row rather than a near-duplicate.

**What would change my mind:**

- **Bytes per step over ~20 KB all-in.** That happens if agents write large generated files or images. 1 GiB then holds only ~50k steps. Turn on E's cold delta packing for text, and keep binaries out of per-step versioning, for example by versioning large binaries only at run boundaries.
- **U1 shows engines with a large fixed per-record overhead** (over 1 KB/row). Then batch small versions into per-run records.
- **Paul decides the site gets accounts** (bench-design §10). F becomes a sync and backup feature rather than a capacity hack, and should be designed as that.

---

## 4. Degradation path

### Which number to watch

`usage / quota` alone is useless on phones. 25 MB of 38 GB will read 0% right up until a full disk evicts the whole origin. So the ladder runs against an **effective limit**:

```
L = min(estimate().quota, 1 GiB)
```

Reasons for **1 GiB**:

- It is the pre-17 Safari prompt boundary.
- It keeps a full-history export small enough to build as a Blob in memory on a phone.
- It is about 40 worked-example workspaces, more than v1 needs.

The percentage shown is `estimate().usage / L`, refreshed after each run and every 5 minutes while Bench is open. Chromium's `usage` is approximate (§1), so the thresholds carry slack.

### The ladder

| Level | Tells the user | Refuses | Does automatically |
|---|---|---|---|
| **Always** | Bench footer shows usage, whether storage is **persistent** (`persisted()`), and **"last exported N days ago"**. On iOS in a Safari tab: a standing notice that workspaces here can be deleted after 7 days without a tap, with "use the Home Screen app". | — | `persist()` on first workspace creation. If it is denied, re-request after the next run, since Chromium's heuristics change with engagement. |
| **< 60%** | Nothing extra | Nothing | Nothing |
| **≥ 60%** | Amber dot: "Storage 60%. Export or tidy history." | Nothing | Idle-time work only: GC orphan blobs, compress any blobs written uncompressed, fold `assistant_delta` events of *closed* runs into their final message. None of this loses fidelity. |
| **≥ 80%** | Banner listing the biggest workspaces, with **Export history**, **Archive & squash** and **Delete workspace** | New workspace creation, and imports over 10% of the remaining space | **Run-aware squash (policy C)** for steps older than the keep window. Whole-run revert survives. Nothing inside the window is touched, and nothing is deleted that would break revert of any run. Reported as a trail entry ("squashed 4,210 old steps, freed 9.1 MB"). |
| **≥ 95%** | Blocking card: "Storage nearly full. The agent is paused." | **Starting or continuing agent runs.** A run in progress pauses at its next step boundary through the same path as `ask_human`. Human edits still save, since they are small and the headroom exists for them. | Nothing destructive. Below the keep window, history goes only on the user's explicit click. |

The 5% above 95% is a **reserve**. It exists so the in-flight write, its journal events and the pause event can all land.

### A quota error mid-run never loses a write

- **One transaction per write.** Blob, version, head and op commit in a single IDB `readwrite` transaction. On `QuotaExceededError` the transaction aborts as a whole, so the store is never half-written. Handle it on `transaction.onabort` / `transaction.error`, not only on the request. *Unverified across engines whether the error surfaces on the request or only on the transaction: U6.*
- **The caller keeps the bytes.** `fs.write` resolves to `{ok: false, error: 'quota', path, base}` and never throws away `content`. The shell holds the failed write in a memory-only **pending-writes list** and shows it as a card: **Retry**, **Download this file** (gets the bytes out of the browser right away), **Free space**.
- **The agent is told, then stopped.** The tool result is `{ok:false, error:'quota_exceeded'}` and the run moves to `paused: storage`, with no further model calls. Retrying a model round trip into a full disk is pointless and spends the user's tokens.
- **Journal writes are the second place it bites.** `emit()` in `airis-agent.js` awaits `log.append`, so a quota error there currently rejects out of `runAgent`. The required behaviour: catch it, keep `messages` in memory, pause the run, and offer **Download transcript**. A reload in that state loses only what was never written, and the card said so.
- **Silent eviction cannot be caught, only bounded.** No error fires when a best-effort origin is evicted under storage pressure or by ITP. The only defences are `persist()`, the Home Screen app on iOS, and the export clock. **"Last exported" turns red after 7 days** on any origin where `persisted()` is false.

### Export, the backstop, made affordable

Two modes:

- **Tree** (default): the head versions only, about 300 KB for the worked example. One tap, suggested at the end of every run that changed files.
- **Full history**: the full store, 25 MB or more.

"Archive & squash" means a full-history export followed by a policy-C squash. It is the user-owned version of offloading to a server (F).

---

## 5. Unknowns, and the cheapest experiment for each

| # | Unknown | Why it matters | Cheapest experiment |
|---|---|---|---|
| **U1** | Real bytes on disk per small IDB record and per 2 KB blob in each engine (Chromium's LevelDB/SQLite backend, Firefox SQLite, WebKit SQLite), and whether the engine compresses values itself | My row estimates (400 B, 230 B) could be off severalfold. If Chromium already compresses values, G saves less there. | One page that writes 15,000 synthetic version rows plus 2 KB blobs, compressed and uncompressed, and reads `estimate().usage` before and after. Run it on Chrome, Firefox, Safari macOS and a real iPhone. About 1 hour, reusing the pattern in the existing `idb-test.html`. |
| **U2** | What Firefox and iOS Safari actually return from `estimate()`, and whether the iOS quota is close to 60% of disk | Sets `L` on those engines | The same page logs `estimate()` and `persisted()`. 10 minutes per device. |
| **U3** | Whether `persist()` exempts a Safari tab from the 7-day ITP cap | Decides whether non-installed iPhone use is ever safe | A spare iPhone: open Airis in a Safari tab, create a workspace, call `persist()` and record the result, then use Safari on other sites for 8+ days without tapping Airis. Check whether the workspace survived. About 8 days of elapsed time, minutes of effort. Run a Home Screen control at the same time. |
| **U4** | Whether the iOS Home Screen app and Safari tabs share IndexedDB | If separate, a workspace made in one is invisible in the other. The UI must say so, and export/import is the migration path. | Create a workspace in a Safari tab, open the Home Screen app, and look for it. 2 minutes. |
| **U5** | Real bytes per agent step (versions + journal) in Bench runs, as opposed to my 3.7 KB estimate | **This is the number that decides the whole policy** (§6) | Instrument the first ten real Bench v0 runs to log bytes written per step by table. Free once Bench runs. |
| **U6** | Where `QuotaExceededError` surfaces per engine (request `onerror` or only transaction `onabort`) and whether the transaction aborts cleanly | The no-silent-loss guarantee rests on it | Shrink the quota artificially: Chrome DevTools → Application → Storage → "Simulate custom storage quota". Firefox's `dom.quotaManager.temporaryStorage.fixedLimit` pref (*name from memory, verify*). Fill until failure and log which handler fires. 30 minutes. |
| **U7** | `CompressionStream` latency per 2 KB blob on an older iPhone | Compression is on the write path of every agent step | Time 1,000 compress/decompress cycles on device. 10 minutes. I expect well under a millisecond each, but that is not measured. |
| **U8** | Private-window quotas (Chrome Incognito, Firefox private, Safari Private) | Users in private windows lose everything on close, and may hit a small quota early | Same page as U2, in private mode. Show a "private window: nothing here will be kept" notice regardless. |

---

## 6. The one number

**All-in bytes stored per agent step** (versions + metadata + journal, after compression).

- At the estimated **≈ 1.65 KB/step** (recommended layout), the 1 GiB budget holds about **650,000 steps**. Unbounded history is a non-issue, and retention exists only for tidiness.
- At **≈ 6.4 KB/step** (as currently designed), it holds about 170,000. That is still fine, but journal hygiene (H) is the cheap fix.
- **Above ~20 KB/step**, it holds under ~54,000. Run-aware squash plus cold delta packing (C + E) move from optional to required.

U5 measures it on the first real Bench runs.
