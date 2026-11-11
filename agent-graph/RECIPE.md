# Agent graph

A side panel that draws the shown tab's agents as a spawn tree: the agent you started on the
left, every sub-agent it ran (`hc run`) or reports running inside itself (Claude Code's Agent
tool) one column to the right, their own sub-agents further right. Each card says what the
agent is, how it stands or how it ended, and for how long. It updates by itself while shown and
follows the tab you switch to. A small background recorder keeps a history of every terminal and
reported sub-agent, so agents that already finished, or were removed with `hc rm`, still show in
the tree. Clicking a live card peeks at its terminal; clicking a finished Claude Code, Codex,
Grok, Command Code, Copilot CLI or OpenCode card resumes that exact session in a new tab.

![Agent graph](preview.png)

## What you see

Top to bottom, filling its block (designed for a ~368 px side panel, works up to full width):

- **Bar**, 32 px, `surface` background with a 1 px `border` line under it, 12 px text, 12 px
  side padding, items 8 px apart:
  - left: dim (`dim`) bits, the first plain and the rest written `· text`:
    `5 agents · depth 2`, `centred on the deepest working agent` after Center, `3 not drawn`
    when cards were skipped, `no recorded history yet` when the history file doesn't exist, or
    the read or parse error. No space or tab name: the window already shows those.
  - right: three 14 px icon buttons, 6×4 px padding, 5 px corners, `muted` at rest, `hover`
    background and `foreground` on hover, half opacity and inert when disabled: Center
    (`icons/crosshair.svg`, enabled when something is working), Reset view (`icons/undo.svg`,
    enabled when scrolled away from the top-left), Close (Herdr's
    `mods/workspace-chrome/x.svg`).
- **Canvas** below, `canvas` background, a fixed viewport over the graph (no native scrollbar):
  - **Column headers**, 34 px tall, 12 px top padding, 11 px text, one per column over its
    cards: `Root` or `Depth N` (`foreground` on the active depth, else `muted`), then
    `· k/n done` (`dim`), `· N working` (`working`), `· N failed` (`ansi1`),
    `· N stopped` (`muted`). The active depth (the deepest column with a working agent) gets a
    2 px `accent` underline. A column of only removed-before-recording parents says
    `removed before recording`.
  - **Cards**, 216×76 px, 7 px corners, 1 px border, 10×7 px padding, 3 px row gap, columns
    60 px apart, rows 12 px apart, 20 px canvas padding. `background` fill, `border` border
    (`blocked` when the agent is blocked or errored). Three lines:
    1. title, 12.5 px medium, truncated, after a 14 px program icon (tinted `foreground` if the
       icon is one-color): a live card's program icon, or a recorded agent's logo (Claude Code,
       Codex, Grok, Command Code, ...) from Herdr's agent table. Other recorded cards have none.
    2. the status word, colored by kind: `working` (`working`), `blocked` (`blocked`,
       semibold), `error` (`blocked`, semibold), `done` (`done`), `idle` (`dim`),
       `failed (1)` (`ansi1`), `stopped` (`muted`), `ended` (`dim`), `running` (`muted`).
    3. meta, 11 px `dim`, truncated, joined by ` · `: duration (`42s`, `5m`, `1h 3m`,
       `2d 4h`; one still running says `<1m` for its first minute, then counts up a minute at
       a time), address (`t7`), program, `removed`, `not seen`, then the command when it says
       more than the program.
    - A removed terminal's card is at 55% opacity.
    - A parent the history never saw is a dashed `input`-bordered card showing its address
      and `removed before recording`.
    - A reported sub-agent's card has its agent's icon and the title it reported (else
      `sub-agent`); its meta is its duration (from when the recorder first saw it, else this
      graph), its agent's address, `sub-agent`, then the message it reported, if any.
  - **Links**, 1.5 px, from a parent's right edge to each child's left edge: across, down or up
    with 8 px rounded corners, across. Colored by the child: `working`, `blocked` (blocked or
    error), `ansi1` (failed), `done`, else `input`.
- **Empty**: with no agents, the bar plus 24 px padded `dim` text: `No agents in this tab yet.`
  Blank until the first load has finished, so it never flashes.

## How it behaves

- **Live, and quiet.** While shown, the graph follows agents starting, changing status,
  finishing and being removed, and new history records, with no Refresh. It redraws only when
  something it draws changed: a status or title tick that changes nothing visible does no work.
  Hidden, it does nothing and catches up when shown again.
- **Which agents.** The shown tab of the active space: the live terminals in its panes, those
  labelled `herdr.tab=<its id>`, and all their descendants by `parent`, plus recorded terminals
  whose `where` label is `<space name> / <tab name>`. Switching tabs or spaces switches the
  graph. A live terminal's other OSC 7501 records (hc's `records`, by id: a program reporting on
  several things, as Claude Code does for each running Agent-tool sub-agent) are its children,
  at `<address>#<id>`, while it reports them, and recorded ones after. A run is a root with
  descendants; a lone live agent (it reports a status or is a known agent) is a run of one. The
  graph shows the first run, ordered live-working runs first, then most recent activity.
- **Statuses.** Live data wins over the record. Live: its status word (`working`, `blocked`,
  `idle`, `done`, ...) or `running` for a plain program; `ended` if it was removed while live.
  Finished: `stopped` (killed), `done` (exit 0), `failed (N)`, else `ended`; a finished reported
  sub-agent is always `ended`, since its program doesn't say how it ended.
- **k/n done** counts finished terminals, `done` agents, and `idle` agents that either have
  children or were seen `working` before (remembered in `localStorage`, last 2000 ids).
- **Scroll** pans the viewport (Shift+wheel pans sideways), clamped to the graph's edges, and
  stays smooth on big graphs: panning moves already-built cards and rebuilds them only near the
  edge of what was built. Center puts the active depth's top working card in the middle; Reset
  goes back to the top-left.
- **Card budget.** Cards are built for the viewport plus a margin (one column, two rows), at
  most 28: those in view first, then nearest the centre; the root and the active depth's card
  are always kept. A link to a skipped parent becomes a 24 px stub.
- **Click** a live card: `terminal.peek` (a reported sub-agent's card peeks its agent's
  terminal, since it has none of its own). Click a finished resumable card: `resume.py` finds
  its session and `tab.new {name, folder, argv}` runs `claude --resume <id>`,
  `codex resume <id>`, `cmd --resume <id>`, `grok --resume <id>`, `copilot --resume <id>` or
  `opencode --session <id>` in its folder. When the exact session can't be found, the agent's own
  picker opens and a toast says so (Grok and OpenCode have no picker flag: a toast explains).
  Other cards don't respond, a finished sub-agent's included: it has no session of its own.
  Hovering a clickable card turns its border `accent`.
- **Escape** (while focused), Close, or the `close` mod command hides the layout node the graph
  sits in: the recipe's `panel`, or the block's own `props.hide` when a layout gives the graph its
  own node (e.g. its own column).
  Any other mod command (`agent-graph.<anything>`) rereads the history and redraws.
- **Opening.** Setting shared `"agent-graph.shown"` to a new value (e.g. `Date.now()`) focuses
  the graph and brings it up to date; the opener also selects and shows its block. Escape only
  works while the graph holds the keyboard: it takes it when opened this way, and loses it to a
  click elsewhere (`mod.json` isn't `focusable`, so `pane.go` doesn't reach it).
- **The opener (author's setup).** The graph is a third choice in the right side panel, beside
  Files and Changes; one shows at a time. The tab bar has an **Agent graph** chip (graph icon,
  right of `+`, before Files) styled like Files and Changes: `selected` background and
  `foreground` text while the panel shows the graph, else `chrome`/`muted`. Clicking it, or
  `cmd-shift-g`, opens the panel on the graph, focused; with the panel already on Files or
  Changes it switches to the graph. Clicking it, or `cmd-shift-g`, while the graph shows closes
  the panel. The panel's choice is remembered per space, graph included: switching spaces
  restores what that space last had open. The command palette (`cmd-shift-p`) lists
  **Agent graph: open** while the graph is closed and **Agent graph: close** while it shows.
- **Resuming** opens a tab named after the card's title. Errors from `resume.py` or `python3`
  show as a `Cannot resume session` toast; an inexact match opens the agent's picker and says
  `Session not found`.

## Built from

- **Layout.** A block `{ "id": "graph", "content": { "mod": "agent-graph" } }`. In the build
  this came from it is a child of a stack `panel-body` (beside Herdr's `files` and `changes`)
  inside a hidden column `panel` (368 px, min 280, max 900) on the right of a clone of `main`.
  The mod renders nothing while node `graph` is off screen (it or an ancestor hidden, or a
  stack showing another child); with no node `graph` in the layout (a pane, a check run) it
  always draws. `mod.json`: `{ "place": "none", "title": "Agent graph" }`.
- **Opener.** Nothing in `mods/agent-graph/` opens the panel: an `agent-graph.<command>` only
  reaches shown copies, and the graph isn't shown while its panel is hidden. The minimal open,
  from any always-shown mod, sets the focus token and reveals the stack child:
  `setShared("agent-graph.shown", Date.now()); run("layout.select", { stack: "panel-body", child: "graph" }); run("layout.show", { id: "panel" });`
  The author's setup (behaviour under How it behaves):
  1. **Layout** `main-graph`: `herdr-app do layout.clone '{"name":"main","as":"main-graph"}'`,
     then add `{ "id": "graph", "type": "block", "content": { "mod": "agent-graph" } }` as the
     last child of the `panel-body` stack and set the tab-bar block's (`"id": "tabs"`)
     `content.mod` to `"tabs-graph"`. The panel keeps the shipped `panel` column (hidden, 368 px,
     min 280, max 900), so Close/Escape need no `props.hide`.
  2. **Tab bar** `tabs-graph`: `herdr-app do mod.clone '{"name":"tabs","as":"tabs-graph"}'` (the
     clone rewrites its own `mods/tabs/` icon paths), then:
     - import `setShared` and `nextCommand` from `"herdr"`;
     - `init(_props, cx)` starts
       `cx.spawn(async () => { for (;;) { const c = await nextCommand(); if (c === "toggleGraph") this.toggleGraph(); } });`
     - add the method the key calls (the chip keeps using `panelButton`):
       ```js
       toggleGraph() {
         const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
         if (!panel || !find(root, "graph")) return;
         if (!panel.hidden && body?.active === "graph") { run("layout.hide", { id: "panel" }); return; }
         setShared("agent-graph.shown", Date.now());
         run("layout.select", { stack: "panel-body", child: "graph" });
         run("layout.show", { id: "panel" });
       }
       ```
     - in `render`, make the graph a panel choice so the per-space memory keeps it:
       `const hasGraph = Boolean(find(root, "graph")); this.syncPanel(space, panel, body, hasGraph ? [...enabled, "graph"] : enabled);`
     - give `panelButton(id, label, icon, before)` a `before` hook, called just before its
       `layout.select`, and add, after the `+` button and before Files:
       `.when(hasGraph, el => el.child(panelButton("graph", "Agent graph", "mods/agent-graph/icons/graph.svg", () => setShared("agent-graph.shown", Date.now()))))`
  3. **Key**: this folder's `keys.json`,
     `"layout:main-graph": { "cmd-shift-g": "tabs-graph.toggleGraph" }`. Scoped to the layout
     that has the node, so the key stays free elsewhere. One `keys.json` value is a single
     command, so the chained open lives in the always-shown tab bar's `nextCommand`;
     `layout.toggle:panel` alone can reveal the wrong stack child and never focuses the graph.
  4. **Palette entries** (optional). Herdr's palette (`frame/palette`) is rewritten on every
     start and can't be extended, so the author runs a copy:
     - copy `frame/palette/` to `mods/command-palette/` (its icon path becomes
       `mods/command-palette/command.svg`); give its `NAMED` rows an optional sixth element, an
       action function, kept by the row filter (`action || known.has(name)`) and the row map, and
       on Enter run `e.action()` instead of `run(name, args)` when it has one;
     - add `["agent-graph.open", {}, "App", "Agent graph: open", "show panel spawn tree agents", <the minimal open above>]`
       and `["agent-graph.close", {}, "App", "Agent graph: close", "hide panel spawn tree agents", () => run("layout.hide", { id: "panel" })]`,
       filtered so only one shows: open while `graph` exists and isn't the shown stack child of
       a visible `panel`, close while it is;
     - open the copy from a clone of `workspace-status` (`status-bar`, the layout's `status`
       block): its click and a `nextCommand` loop call
       `openOverlay({ mod: "command-palette", kind: "dialog", width: 640, height: 440 })`, with
       `"global": { "cmd-shift-p": "status-bar.palette" }` in `keys.json`.
- **Props:** `history` (optional): the history file to read; default
  `~/.local/share/herdr-agent-graph/history.json`. An absolute path is used as given, a
  relative one from the mod's folder. Point it at `fixtures/*.json` to try the view without
  the recorder. `hide` (optional): the layout node Close/Escape hide; default `panel`. Set it when
  the layout puts the graph somewhere else, e.g. a dedicated column:
  `{ "mod": "agent-graph", "props": { "hide": "graph-panel" } }`.
- **`main.js`**: the view. `herdr`: `terminals`, `spaces`, `panes`, `theme`, `run`, `props`,
  `home`, `appHome`, `readTextFile`, `watchFolder`, `knownAgents`, `nextCommand`, `shared`,
  `exec`, `notify`, `layout`. `knownAgents()` (once, at start) gives recorded cards their
  agent's icon by table key or icon name, after mapping hc's agent words that differ
  (`claude-code` to `claude`, `grok-build` to `grok`, `cmd` to `command-code`); a pass is then
  forced, since logos aren't among the inputs the coordinator compares. Commands: `layout.hide`, `terminal.peek`, `tab.new`. Cards and links live in a
  retained child view (`cx.new(Slab)`), rebuilt with `set_props` only when what it draws
  changed; a pan only moves its wrapper. A shown render compares a string key of the tab and
  its terminals (never titles) with the one the graph was built from; each terminal's `records`
  join it as reported sub-agents, with the time each was first seen kept in memory. A minute
  timer redraws only the child (`cx.notify(slab)`), and only when a drawn duration would read
  differently.
- **`live.js`**: the one coordinator every update goes through: the first load, render-noticed
  changes, the history watcher (`watchFolder` on the history's folder, matched by file name so
  the recorder's temp files don't count; retried every 5 s, rereading while shown), showing,
  switching, key commands. One pass at a time over one snapshot of its inputs; a newer pass
  wins; an equal result publishes nothing; a pass stuck over 10 s is retired.
- **`model.js`**: pure functions: history parse, reported sub-agents as terminal-shaped
  children (`reported`), merging records with live terminals by id
  (`<address>@<created_ms>`), parent resolution, ghosts, cycle cutting, run ordering, card
  facts, and the layout (column = depth, children under their parent in spawn order so links
  never cross).
- **`recorder.py`** (Python 3, standard library): follows `hc events --json`, re-reads
  `hc ls --all --json` every 15 s, and writes `history.json` atomically as described in
  `FORMAT.md` (14 days; non-current records capped at 1500; always under 900 KB). Reported
  sub-agents come from the `records` of `status` events and snapshots (`hc ls` has none), one
  record each from the first time it sees one until its terminal stops reporting it. An unreadable
  or wrong-version history is kept aside as `history.json.bad-<time>` rather than overwritten.
  `install.sh` installs it as a
  macOS launchd agent (`dev.herdr.agent-graph-recorder`, `/usr/bin/python3 -I`, logs to
  `~/.local/share/herdr-agent-graph/recorder.log`); `uninstall.sh` removes it and keeps the
  history.
- **`resume.py`**: given the history and a record id, finds that run's session by folder and
  start time in `~/.claude/projects`, `~/.codex/sessions`, `~/.commandcode/projects`,
  `~/.grok/sessions`, `~/.copilot/session-state/*/workspace.yaml`, or OpenCode's
  `~/.local/share/opencode/opencode.db` (`session` table), and prints `{argv, cwd, session}` or
  `{error}`. Read-only (the OpenCode db is opened `mode=ro`; a live SQLite read may take a shared
  lock).
- **Tests:** `python3 -m unittest recorder_test resume_test`, `node live_test.mjs` (the
  coordinator against fake host data, a fake clock and controlled reads) and `node model_test.mjs`
  (reported sub-agents and how they join the graph, live and recorded), all run from the mod's
  folder. **Fixtures:** `fixtures/*.json` are sample histories (a `/fusion` run, a removed
  parent, reused addresses, idle agents, a 28-card overflow, reported sub-agents).
- **Art:** `icons/crosshair.svg`, `icons/undo.svg` (the bar's buttons) and `icons/graph.svg`
  (the opener's chip: one node on the left branching to two on the right), 24×24 stroke icons,
  tinted.
- **`keys.json`** (beside `mods/`): the opener's `cmd-shift-g`, to merge into the person's.

## Watch out

- **What it reaches:** runs programs (`python3` for `resume.py`; the recorder runs `hc`), reads
  files outside its folder (the history under `~/.local/share/herdr-agent-graph/`, and
  agents' session stores under `~/.claude`, `~/.codex`, `~/.commandcode`, `~/.grok`, `~/.copilot`
  and OpenCode's `~/.local/share/opencode/opencode.db` when resuming). No network.
- `install.sh` is macOS-only (launchd). On Linux run `python3 -I recorder.py` under a systemd
  user service or similar. Without the recorder the graph still shows live terminals.
- The mod hides the node id `panel` (Close, Escape). If your layout puts the graph elsewhere, set
  the block's `props.hide` to that node (or change `hideNode()` in `main.js`).
- It needs an opener: nothing in `mods/agent-graph/` opens the panel. Add one to a mod or a
  palette entry — see the tab-bar opener in Built from. A `keys.json` key alone can't set shared
  state and show a node at once, so the chained open belongs in an always-shown mod's
  `nextCommand`, and any key should be scoped to the layout that has the node (`layout:<name>`).
  The shipped `keys.json` targets `tabs-graph` in `main-graph`: without those two, its key does
  nothing; with other names, change it to match.
- Giving the graph its own column instead of a stack child (with `props.hide`) works, but then
  it opens as a second panel beside Files/Changes rather than in their place; the author chose
  the stack.
- The folder name is load-bearing: `main.js` runs `${appHome()}/mods/agent-graph/resume.py`, and
  the opener's chip uses `mods/agent-graph/icons/graph.svg`. Renamed (a name clash), change both.
- Updating `recorder.py` doesn't reach the running recorder: restart it with
  `launchctl kickstart -k gui/$(id -u)/dev.herdr.agent-graph-recorder` (or rerun `install.sh`).
  A history it can't read is set aside as `history.json.bad-<time>`; if even that fails the
  recorder refuses to start, so check `recorder.log` when the history stops growing.
- `python3 -I -m unittest ...` fails to import the modules (`-I` drops the current folder from
  the path); run the tests without `-I`, from the mod's folder.
- A fresh mod copy is cold and can stall the window for seconds; keep one long-lived copy in the
  layout (a hidden stack child) rather than opening it as an overlay each time.
- Herdr calls `render()` on every live-data change, title ticks included, and there is no
  terminal subscription: render is the only signal. Keep render to a key comparison and do the
  work off the render path (`cx.spawn`); render must not call `cx.notify` or `set_props`.
- The app interrupts a frame that builds too many native elements: keep the 28-card budget, and
  never rebuild cards on a pan (a wheel event per frame in an interpreter is what made scrolling
  lag).
- `on_size_change` must ignore same-size reports, or it renders in a loop.
- A zero-height div with a border paints nothing: draw straight links as a filled bar.
- Addresses are reused after `hc rm`: key everything by `<address>@<created_ms>`.
- Recorded runs match their tab by name, and a tab nobody named is called by its position
  (`1`, `2`), so closing or moving tabs can attach old records to another tab. Live terminals
  match by tab id and aren't affected.
- Resuming picks the earliest session that started in the record's folder after it was created
  and before the next run of the same agent there; two sessions with the same start resume to
  the picker.
- A reported sub-agent's times are the recorder's: Claude Code clears the record as soon as the
  sub-agent finishes, and records carry no start time, so the recorder starts and ends it when it
  sees the record appear and go. Without the recorder, a sub-agent shows only while it is
  reported, timed from when this copy of the graph first saw it.
- A terminal's records say nothing about which sub-agent started which, so all of them show one
  column right of the terminal; a sub-agent's own sub-agent is a level deeper only when it runs
  in a terminal of its own (`hc run`).

## Done when

- `herdr-app check mods/agent-graph` passes, `python3 -m unittest recorder_test resume_test`
  passes (34 tests), `node live_test.mjs` passes (18 tests), and `node model_test.mjs` passes
  (11 tests).
- With `props: { history: "<abs path>/fixtures/review.json" }` in a space named `example-app`
  on a tab named `review`, the graph shows a `/fusion` run: `abc301-orch` (Claude Code on
  opus-5.5, `working`) as Root; in Depth 1 `abc301-critic` (Codex, `done`), `abc301-impl`
  (Command Code, `done`) and `abc301-review` (Grok, `blocked` with a `blocked` border), each
  with its agent's logo; in Depth 2 four test runs (`done`, `failed (1)` under the
  implementer; `stopped`, `done` and removed under the reviewer).
- With `props: { history: "<abs path>/fixtures/subagents.json" }` in a space named
  `example-app` on a tab named `explore`, the graph shows `abc420-plan` (Claude Code, `done`) as
  Root; in Depth 1 its reported sub-agents `Find the parser` and `Review the plan` (`ended`,
  `t90 · sub-agent`) and the `hc run` helper `abc420-fix` (`done`), in that order; in Depth 2
  the helper's sub-agent `Run the test suite` (`ended`). The sub-agent cards don't respond to
  a click.
- After `install.sh`, `~/.local/share/herdr-agent-graph/history.json` appears and grows when you
  run `hc run -- sleep 1`.
- Starting a sub-agent with `hc run` from a tab's shell adds a card one column right of its
  parent, linked to it, within a second and without any click; killing it turns the card
  `stopped`. Clicking a live card peeks at the terminal.
- While a Claude Code agent runs an Agent-tool sub-agent, a card titled with the sub-agent's
  description appears one column right of the agent, linked to it, within a second; when the
  sub-agent finishes, the card stays as `ended` (and goes without the recorder). Clicking it
  while it runs peeks at the agent's terminal.
- With two tabs each running a sub-agent, each tab's graph shows only its own, switching tabs
  switches the graph, and a change in the other tab leaves the shown graph alone.
- After a Claude Code sub-agent exits, clicking its card opens a new tab running
  `claude --resume <its session>` in its folder; the same works for Codex, Command Code, Grok,
  Copilot CLI and OpenCode.
- Scroll pans smoothly on a big graph; Center and Reset move the view; Escape hides the panel.
- In `main-graph`, `cmd-shift-g` (or the Agent graph chip) opens the side panel on the graph with
  the chip highlighted and Escape working at once; with Files showing, it switches the same panel
  to the graph; pressing it again closes the panel. No second column appears.
- Opening the graph in one space and Files in another, then switching between them, restores
  each space's choice.
- The palette shows `Agent graph: open` while it's closed and `Agent graph: close` while it shows.
