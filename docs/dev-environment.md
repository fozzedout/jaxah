# Dev environment

Bench is a catalogue app for editing workspace files. Install it from the Store.
Files live in workspace `home`, under `dev/` with one filename segment.

Create a file in Bench, select it, edit its text and save. Saves use
compare-and-swap (CAS): if the saved version has changed since you loaded it,
the save reports a conflict rather than overwriting the newer version.
Resolve the conflict and save against the current version.

Run a saved HTML file with **Run**. The **Test harness** pane opens inside
Bench's own window. **Reload** re-reads the saved file, not unsaved edits.
The sandboxed harness frame has no capabilities: it can use only bridge
`hello` and `trail.note`.

Files are created on demand: the empty state offers New file and Insert hello world (writes dev/hello.html); nothing is seeded.

Workspace files are never apps, tiles, dock entries, palette entries or install
records—not yet. There is no install-from-file path. Only catalogue installs
and imported app bundles create install records.
Bench creates workspace `home` on first open and is granted it; if `home` already exists without a grant to Bench, Bench shows an error and cannot use it (there is no grant UI yet).
