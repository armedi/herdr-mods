// One long-lived graph copy lives in the side panel’s panel-body stack beside Files and Changes.
// Keeping it alive keeps Herdr’s JIT warm; fresh copies are cold and stall the window for seconds.
//
// Live while shown. Every update goes through one coordinator (live.js), one pass at a time:
// - Terminals: Herdr calls render on every live-data change (title ticks too). A shown render that
//   is not a pan's compares a string key of the shown tab (space and tab id, name) and its terminals' shown
//   fields (never titles) with the key the graph was built from, and only a difference asks for a
//   pass. A pan's render skips it; one check runs off the render path 200 ms after the last pan.
// - History: one watcher on the history file's folder. The recorder's rename onto the file marks
//   the history stale (its temp files don't); a shown graph rereads it at once, a hidden one when
//   it shows. A folder that can't be watched is retried every 5 s, rereading the history while
//   shown. A failed read or parse keeps the previous records and says so in the bar.
// - Showing the graph and switching spaces ask for a pass; the history is reread only if stale.
// - Key commands: "close" hides; anything else rereads everything and redraws.
// A pass builds the model off the render path, then compares what the view would show: an equal
// graph keeps the old model and draws nothing; a changed one rebuilds the card slab only if its
// drawn cards, links or geometry differ, else only the host redraws (and only if its headers or
// bar changed). Hidden, a pass builds and draws nothing and the work waits for the graph to show.
// Durations: an unfinished card shows "<1m" for its first minute; once a minute, while shown, the
// slab redraws only if a drawn card's duration text would change.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, spaces, panes, theme, run, props, home, readTextFile, watchFolder, knownAgents, nextCommand, shared, exec, notify, appHome, layout as windowLayout } from "herdr";
import { parseHistory, merge, orderRuns, facts, title, outcome, isDone, duration, layout, colX, rowY, CARD_W, CARD_H, qualify, RESUMABLE, agentOf, reported } from "./model.js";
import { Live } from "./live.js";

// Whether layout node `id` is on screen: it and every ancestor not hidden, and every stack on the
// way showing that branch. null when the layout has no such node.
function onScreen(node, id) {
  if (!node) return null;
  if (node.id === id) return !node.hidden;
  for (const child of node.children ?? []) {
    const shown = onScreen(child, id);
    if (shown !== null) return shown && !node.hidden && (node.active == null || node.active === child.id);
  }
  return null;
}

// Outside a layout block named "graph" (a pane, a check run) it always shows.
const isShown = () => onScreen(windowLayout(), "graph") ?? true;
// Close/Escape hide the layout node the graph sits in: the recipe's "panel", or the block's own
// props.hide when a layout gives the graph its own node (e.g. its own column).
const hideNode = () => props()?.hide ?? "panel";
const hide = () => run("layout.hide", { id: hideNode() });

// The history file: props().history (absolute as given, relative to this mod's folder), else the
// recorder's.
function historyPath(p) {
  if (!p) return `${home()}/.local/share/herdr-agent-graph/history.json`;
  return p.startsWith("/") ? p : `${appHome()}/mods/agent-graph/${p.replace(/^\.\//, "")}`;
}

const GRAPH_W = 900;
const GRAPH_H = 560;
const BAR_H = 32;
const HEAD_H = 34;
const LINK = 1.5;
const MAX_CARDS = 28;
// The slab: cards and links are built for the viewport plus this margin, in a retained child view.
// A pan inside the slab only moves it, so scrolling builds no cards (see Slab below).
const SLAB_MX = CARD_W + 60;
const SLAB_MY = 2 * (CARD_H + 12);

// Graph copies by id, so a Slab (a retained child, given only plain props) finds its host.
const hosts = new Map();
let hostSeq = 0;

// The drawn cards and links of the host's current slab. Rebuilt only when the host sets new props
// (or the theme changes), never when the host re-renders for a pan.
class Slab extends View {
  init(props) { this.hostId = props?.host; }
  update(props) { this.hostId = props?.host; }
  render() {
    const host = hosts.get(this.hostId);
    const s = host?.slab;
    if (!s) return div();
    return host.slabElement(theme(), s, Date.now());
  }
}

// A card's duration uses now while it has neither a finished nor a removed time (or no start).
const aging = (f) => (f.finished == null && f.removed == null) || f.created == null;
// Its text: an aging card says "<1m" for its first minute, so it changes once a minute at most.
function ageText(f, now) {
  const ms = (f.finished ?? f.removed ?? now) - (f.created ?? now);
  return aging(f) && ms >= 0 && ms < 60000 ? "<1m" : duration(ms);
}

// Everything card() and glyph() draw of a node, except an aging card's duration text.
function cardKey(n) {
  const v = n.v;
  if (v.key) return v.key;
  if (v.ghost) return (v.key = JSON.stringify([n.id, "ghost", n.address]));
  const f = v.f;
  return (v.key = JSON.stringify([n.id, n.address, v.title, v.o.word, v.o.kind, v.loud, v.meta,
    v.program?.icon ?? null, Boolean(v.program?.tint), f.removed != null, v.peekable, v.resumable,
    aging(f) ? ["aging", f.created] : ageText(f, 0)]));
}

// What a slab draws: its geometry, its cards where they are, and its links.
const slabKey = (s) => JSON.stringify([s.x0, s.y0, s.sw, s.sh, s.hidden, [...s.shownCols].sort((a, b) => a - b),
  s.drawn.map((d) => [d.x, d.y, cardKey(d.n)]), s.linkGeo]);

// What the bar shows of the coordinator's state (not the space or tab: the window already says).
const barKey = ({ error, missing, ready }) => JSON.stringify([error, missing, ready]);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// When each reported sub-agent was first seen (see reported() in model.js).
let subSeen = new Map();

// The fields this view shows, read once per render (never the title, which ticks), then the
// sub-agents those terminals report on.
function liveTerminals() {
  const raw = terminals();
  const terms = raw.map((t) => {
    const p = t.program;
    return {
      address: t.address,
      parent: t.parent ?? null,
      created_ms: t.created_ms ?? null,
      finished_ms: t.finished_ms ?? null,
      exit_code: t.exit_code ?? null,
      reason: t.reason ?? null,
      state: t.state,
      status: t.status ?? null,
      name: t.name ?? null,
      template: t.template ?? null,
      argv: Array.isArray(t.argv) ? t.argv.slice(0, 12).map(String) : null,
      space_label: t.labels?.["herdr.space"] ?? null,
      tab_label: t.labels?.["herdr.tab"] ?? null,
      program: p ? { name: p.name, icon: p.icon, tint: p.tint, agent: p.agent } : null,
    };
  });
  const subs = reported(raw.map((t, i) => ({ term: terms[i], records: t.records })), subSeen, Date.now());
  subSeen = subs.seen;
  return [...terms, ...subs.children];
}

// The id Herdr writes in a terminal's herdr.space / herdr.tab label (local to its machine).
const localId = (id) => (id && id.includes("/") ? id.slice(id.indexOf("/") + 1) : id ?? "");

// A record's `where` ("space / tab"): the space part and the tab part.
const whereSpace = (where) => (where ?? "").split(" / ")[0];
const whereTab = (where) => (where ?? "").split(" / ").slice(1).join(" / ");

// The live terminals of one tab: those in its panes, anything carrying its herdr.tab label, and
// their sub-agents (found by parent), which have no pane of their own.
function activeTerms(tab) {
  const all = liveTerminals();
  const local = localId(tab.id);
  const keep = new Set(panes().filter((p) => p.terminal && p.tab === tab.id).map((p) => p.terminal));
  for (const t of all) if (t.tab_label && t.tab_label === local) keep.add(t.address);
  const kids = new Map();
  for (const t of all) {
    const key = qualify(t.parent, t.address);
    if (key == null) continue;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(t.address);
  }
  const stack = [...keep];
  while (stack.length) {
    const addr = stack.pop();
    for (const child of kids.get(addr) ?? []) {
      if (keep.has(child)) continue;
      keep.add(child);
      stack.push(child);
    }
  }
  return all.filter((t) => keep.has(t.address));
}

// Theme colors by outcome kind: a card's status word (else muted) and a link by its child (else input).
const TONE = { working: "working", blocked: "blocked", error: "blocked", done: "done", idle: "dim", failed: "ansi1", stopped: "muted", ended: "dim", running: "muted" };
const LINK_TONE = { working: "working", blocked: "blocked", error: "blocked", failed: "ansi1", done: "done" };
const linkTone = (t, kind) => t[LINK_TONE[kind] ?? "input"];

// The program's icon from the app's table; a recorded-only node gets its initial.
function glyph(t, v, size) {
  const p = v.program;
  if (!p?.icon) return div().w(size).flex_none().text_color(t.muted).text_size(size * 0.85).font_semibold().child(v.letter);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.foreground) : image(p.icon).w(size).h(size).flex_none();
}

// What a card or row shows, derived once per model.
// Herdr's agent programs (knownAgents: name, icon, tint) by table key and icon name, once loaded,
// so a recorded card can show its agent's logo like a live one. hc's agent words that differ
// from the table's keys are mapped first.
let agentPrograms = null;
const AGENT_KEYS = { "claude-code": "claude", "grok-build": "grok", cmd: "command-code" };
function loadAgentPrograms(list) {
  const map = new Map();
  for (const p of list ?? []) {
    if (!p?.icon) continue;
    const icon = p.icon.slice(p.icon.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    for (const k of [p.key, icon]) if (k && !map.has(k)) map.set(k, { name: p.name, icon: p.icon, tint: p.tint, agent: true });
  }
  agentPrograms = map;
}
function recordedProgram(rec) {
  if (!rec || !agentPrograms) return null;
  const word = agentOf(rec);
  return agentPrograms.get(AGENT_KEYS[word] ?? word) ?? null;
}

function describe(n, worked) {
  if (n.ghost) return { ghost: true, title: n.address };
  const f = facts(n);
  const o = outcome(n, f);
  const name = title(n);
  // The program first, then what it runs (a model, a test filter) and why it may be quiet.
  const program = n.live?.program?.name ?? n.rec?.agent ?? null;
  const command = n.rec?.command || n.live?.argv?.join(" ") || n.live?.program?.name || n.rec?.agent;
  // A reported sub-agent has no terminal and no session of its own: a click peeks its parent's.
  const sub = Boolean(n.live?.sub);
  const resumable = !sub && Boolean(n.rec && n.live?.state !== "live" && RESUMABLE.has(agentOf(n.rec)));
  return {
    f,
    o,
    title: name,
    meta: sub
      ? [n.live.parent, "sub-agent", n.live.msg].filter(Boolean).join(" · ")
      : [n.address, program, f.removed != null ? "removed" : null, f.notSeen ? "not seen" : null,
        command && command !== program ? command : null].filter(Boolean).join(" · "),
    peek: sub ? n.live.parent : n.address,
    program: n.live?.program ?? recordedProgram(n.rec),
    letter: (n.rec?.agent || name || "?").replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?",
    done: isDone(n, f, o, worked),
    resumable,
    peekable: Boolean(n.live) && !resumable,
    loud: o.kind === "blocked" || o.kind === "error",
  };
}

export default class AgentGraph extends View {
  init(_props, cx) {
    this.path = historyPath(props()?.history);
    this.token = shared("agent-graph.shown") ?? null;
    this.shown = isShown();
    this.fh = cx.focus_handle();
    this.fh.focus();
    this.size = null;
    this.model = { runs: [] };
    // The graph point at the viewport's top-left: Reset and Center move it, and cards outside
    // the viewport are not built at all.
    this.origin = { x: 0, y: 0 };
    // What the last cull of the viewport drew; a render with the same run, origin and size
    // reuses it instead of walking the run again.
    this.hostId = `g${++hostSeq}`;
    hosts.set(this.hostId, this);
    this.slab = null;
    this.slabVer = 0;
    this.slabView = cx.new(Slab, { host: this.hostId, v: 0 });
    // Set by a pan: the render it causes skips the live-data checks.
    this.panOnly = false;
    this.centred = false;
    // Agents seen working here: an idle one among them has done its part.
    this.worked = new Set(store.get("worked", []));
    // Owns every update; its space, error, missing and ready are what the bar shows.
    this.live = new Live({
      isShown,
      snapshot: () => this.snapshot(),
      readHistory: () => readTextFile(this.path),
      parse: parseHistory,
      build: (input, cx) => this.build(input, cx),
      graphKey: (model) => this.graphKey(model),
      barKey,
      publish: (model, change, cx) => this.publish(model, change, cx),
    });
    // The watcher's first resync is the first load.
    cx.spawn(async (cx) => this.live.watch(cx, watchFolder, this.path));
    cx.timer.every(60000, (cx) => this.ageCards(cx));
    // Recorded cards get their agent's logo once Herdr says which agents it knows; a pass is
    // forced because the logos aren't part of the inputs the coordinator compares.
    cx.spawn(async (cx) => {
      try {
        loadAgentPrograms(await knownAgents());
        this.live.request(cx, { force: true });
      } catch {}
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close") {
          hide();
          continue;
        }
        this.live.request(cx, { reread: true, force: true });
      }
    });
  }

  // The shown tab of the active space and its terminals, sorted, with the key a pass compares: the
  // only place live data comes in. Switching tabs changes the key, so the graph follows the tab.
  snapshot() {
    const active = spaces().find((s) => s.active) ?? null;
    const tab = active?.tabs.find((t) => t.active) ?? null;
    const space = active ? { id: active.id, name: active.name, tab: tab ? { id: tab.id, name: tab.name } : null } : null;
    const terms = tab ? activeTerms(tab) : [];
    terms.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : (a.created_ms ?? 0) - (b.created_ms ?? 0)));
    return { space, terms, key: JSON.stringify([space, terms]) };
  }

  // Runs of this tab and what every card says: built off the render path, in steps that yield
  // between them so the window can draw. Uses only the pass's snapshot.
  async build({ space, terms, records }, cx) {
    const merged = merge(records, terms);
    await cx.sleep(0);
    let added = false;
    for (const r of merged) {
      for (const n of r.nodes) {
        if (n.live?.status === "working" && n.live.state === "live" && !this.worked.has(n.id)) {
          this.worked.add(n.id);
          added = true;
        }
      }
    }
    if (added) {
      const keep = [...this.worked].slice(-2000);
      this.worked = new Set(keep);
      store.set("worked", keep);
    }
    // A run with a live terminal of this tab, or recorded in this space and tab (by name: a tab
    // nobody named is called by its position).
    const name = space?.name ?? null;
    const tabName = space?.tab?.name ?? null;
    const here = (where) => Boolean(name && tabName) && whereSpace(where) === name && whereTab(where) === tabName;
    const runs = merged.filter((r) => r.nodes.some((n) => n.live || here(n.rec?.where)));
    const worked = (nid) => this.worked.has(nid);
    for (const r of runs) for (const n of r.nodes) n.v = describe(n, worked);
    await cx.sleep(0);
    orderRuns(runs);
    return { runs };
  }

  // The headers and the bar's count of a model: column totals, the deepest working agent, agents.
  headKey(model) {
    const cur = model.runs[0];
    if (!cur) return "";
    const { g, cols, wave } = this.shape(cur);
    return JSON.stringify([cur.sum.agents, g.cols, cols, wave && [wave.col, wave.row, wave.id]]);
  }

  // Everything the graph draws of a model: headers, and every card of its run where it sits.
  graphKey(model) {
    const cur = model.runs[0];
    if (!cur) return "";
    const { g } = this.shape(cur);
    const rows = [this.headKey(model)];
    for (const n of cur.nodes) {
      const p = g.pos.get(n.id);
      rows.push(`${p.col},${p.row},${n.parent?.id ?? ""},${cardKey(n)}`);
    }
    return rows.join("\n");
  }

  // Shows what a pass changed. A new graph whose slab draws the same as the current one replaces
  // it quietly; otherwise the slab gets new props. The host redraws only for what it draws.
  publish(model, { graph, bar, force }, cx) {
    let redraw = bar || force;
    if (graph) {
      const head = this.headKey(this.model);
      const { x, y } = this.origin;
      const prev = this.slab;
      this.model = model;
      const cur = model.runs[0] ?? null;
      if (cur) this.origin = this.clampOrigin(x, y);
      const next = cur ? this.buildSlab(cur) : null;
      if (!force && prev && next && slabKey(prev) === slabKey(next)) {
        next.labels = prev.labels;
        this.slab = next;
        if (this.origin.x !== x || this.origin.y !== y || this.headKey(model) !== head) redraw = true;
      } else if (prev || next) {
        this.slab = next;
        this.slabView.set_props({ host: this.hostId, v: ++this.slabVer });
        redraw = true;
      }
    }
    if (redraw) cx.notify();
  }

  // Whether a drawn aging card's duration text differs from what the slab last drew.
  slabAged(now) {
    const s = this.slab;
    if (!s?.labels) return false;
    for (const d of s.drawn) {
      const f = d.n.v.f;
      if (f && aging(f) && ageText(f, now) !== s.labels.get(d.n.id)) return true;
    }
    return false;
  }

  // Durations advance by redrawing only the slab, and only when a drawn one would read differently.
  ageCards(cx) {
    if (isShown() && this.slabAged(Date.now())) cx.notify(this.slabView);
  }

  // Columns, headers, links and the deepest working agent of one run, kept with the model. Nodes and
  // links are bucketed by column too, so a render visits only the columns the viewport shows.
  shape(r) {
    if (r.shape) return r.shape;
    const g = layout(r);
    const cols = Array.from({ length: g.cols }, () => ({ total: 0, done: 0, failed: 0, stopped: 0, working: 0 }));
    const byCol = Array.from({ length: g.cols }, () => []);
    let wave = null;
    for (const n of r.nodes) {
      const p = g.pos.get(n.id);
      byCol[p.col].push(n);
      const c = cols[p.col];
      if (n.v.ghost) continue;
      c.total++;
      if (n.v.done) c.done++;
      if (n.v.o.kind === "failed") c.failed++;
      if (n.v.o.kind === "stopped") c.stopped++;
      if (n.v.o.kind === "working") {
        c.working++;
        if (!wave || p.col > wave.col || (p.col === wave.col && p.row < wave.row)) wave = { ...p, id: n.id };
      }
    }
    const links = [];
    const linksByCol = Array.from({ length: g.cols }, () => []);
    for (const n of r.nodes) {
      if (!n.parent) continue;
      const a = g.pos.get(n.parent.id);
      const b = g.pos.get(n.id);
      const l = { id: n.id, pid: n.parent.id, x1: colX(a.col) + CARD_W, y1: rowY(a.row) + CARD_H / 2, x2: colX(b.col), y2: rowY(b.row) + CARD_H / 2, kind: n.v.ghost ? "ended" : n.v.o.kind };
      links.push(l);
      linksByCol[a.col].push(l);
    }
    r.shape = { g, cols, wave, links, byCol, linksByCol };
    return r.shape;
  }

  // Whether the current slab still covers the viewport: the same run and size, the viewport inside
  // its area, and no budgeted-out card in view.
  slabCovers(cur) {
    const s = this.slab;
    const { vw, vh } = this.viewport();
    const bh = Math.max(1, vh - HEAD_H);
    if (!s || s.cur !== cur || s.vw !== vw || s.vh !== vh) return false;
    const vx = this.origin.x - s.x0;
    const vy = this.origin.y - s.y0;
    if (vx < 0 || vy < 0 || vx + vw > s.sw || vy + bh > s.sh) return false;
    for (const c of s.cut) if (c.x < vx + vw && c.x + CARD_W > vx && c.y < vy + bh && c.y + CARD_H > vy) return false;
    return true;
  }

  // Rebuilds the slab around the viewport when it no longer covers it (or when forced after a load),
  // and tells the Slab child to draw it. Only from event handlers and tasks, never from render.
  ensureSlab(force = false) {
    const cur = this.model.runs[0] ?? null;
    if (!cur) {
      if (this.slab) { this.slab = null; this.slabView.set_props({ host: this.hostId, v: ++this.slabVer }); }
      return;
    }
    if (!force && this.slabCovers(cur)) return;
    this.slab = this.buildSlab(cur);
    this.slabView.set_props({ host: this.hostId, v: ++this.slabVer });
  }

  // The cards and links of the viewport plus a margin, in slab coordinates (graph coordinates
  // minus x0, y0). At most MAX_CARDS, nearest the viewport's centre first; the rest are `cut`, and
  // the slab is rebuilt as soon as one of them would come into view.
  buildSlab(cur) {
    const { g, wave, byCol, linksByCol } = this.shape(cur);
    const { vw, vh } = this.viewport();
    const bh = Math.max(1, vh - HEAD_H);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const x0 = Math.max(0, ox - SLAB_MX);
    const y0 = Math.max(0, oy - SLAB_MY);
    const sw = ox + vw + SLAB_MX - x0;
    const sh = oy + bh + SLAB_MY - y0;
    const midX = ox + vw / 2 - x0;
    const midY = oy + bh / 2 - y0;

    const placed = [];
    for (let col = 0; col < g.cols; col++) {
      const x = colX(col) - x0;
      if (!(x + CARD_W > 0 && x < sw)) continue;
      for (const n of byCol[col]) {
        const y = rowY(g.pos.get(n.id).row) - y0;
        if (y + CARD_H > 0 && y < sh) placed.push({ n, x, y, col });
      }
    }
    // Cards in the viewport first, so the margin only gets what the budget leaves; then nearest
    // its centre.
    const vx = ox - x0;
    const vy = oy - y0;
    const inView = (d) => (d.x < vx + vw && d.x + CARD_W > vx && d.y < vy + bh && d.y + CARD_H > vy ? 0 : 1);
    const rank = (d) => (d.x + CARD_W / 2 - midX) ** 2 + (d.y + CARD_H / 2 - midY) ** 2;
    placed.sort((a, b) => inView(a) - inView(b) || rank(a) - rank(b) || a.y - b.y || a.x - b.x);
    let drawn = placed.slice(0, MAX_CARDS);
    // The root and the deepest working agent stay built even when the budget is full: the graph
    // must not lose the run it starts from, and Center must draw what it centres on.
    for (const id of [cur.root.id, wave?.id]) {
      if (!id || drawn.some((d) => d.n.id === id)) continue;
      const d = placed.find((p) => p.n.id === id);
      if (d) drawn = [d, ...drawn.slice(0, MAX_CARDS - 1)];
    }
    const shownIds = new Set(drawn.map((d) => d.n.id));
    const shownCols = new Set(drawn.map((d) => d.col));
    const placedIds = new Set(placed.map((d) => d.n.id));
    const cut = placed.filter((d) => !shownIds.has(d.n.id)).map((d) => ({ x: d.x, y: d.y }));

    // Links whose parent column crosses the slab: draw those between real ends, and stub out a
    // budgeted-out parent.
    const linkGeo = [];
    for (let c = 0; c < g.cols; c++) {
      if (!(colX(c + 1) - x0 > 0 && colX(c) + CARD_W - x0 < sw)) continue;
      for (const l of linksByCol[c]) {
        const x1 = l.x1 - x0;
        const y1 = l.y1 - y0;
        const x2 = l.x2 - x0;
        const y2 = l.y2 - y0;
        const parentReal = shownIds.has(l.pid) || !placedIds.has(l.pid);
        const childReal = shownIds.has(l.id) || !placedIds.has(l.id);
        if (parentReal && childReal && x2 > 0 && x1 < sw && Math.max(y1, y2) > 0 && Math.min(y1, y2) < sh) {
          linkGeo.push({ elbow: true, x1, y1, x2, y2, kind: l.kind });
        } else if (shownIds.has(l.id) && !parentReal && x2 > 0) {
          linkGeo.push({ elbow: false, x2, y2, kind: l.kind });
        }
      }
    }
    return { cur, vw, vh, x0, y0, sw, sh, drawn, cut, hidden: cur.nodes.length - drawn.length, shownCols, linkGeo };
  }

  // What the Slab child draws: links under cards, positioned in slab coordinates. Keeps the
  // duration texts it drew of aging cards, for ageCards.
  slabElement(t, s, now) {
    const labels = new Map();
    const links = [];
    for (const l of s.linkGeo) {
      if (l.elbow) links.push(...this.elbow(l.x1, l.y1, l.x2, l.y2, linkTone(t, l.kind)));
      else links.push(div().absolute().left(Math.max(0, l.x2 - 24)).top(l.y2 - LINK / 2).w(Math.min(24, l.x2)).h(LINK).bg(linkTone(t, l.kind)));
    }
    const cards = s.drawn.map((d) => this.card(t, d.n, d.x, d.y, now, labels));
    s.labels = labels;
    return div().relative().w(s.sw).h(s.sh).children(links).children(cards);
  }

  // Both buttons move what the fixed viewport shows; the card budget follows it.
  resetView(cx) {
    this.origin = { x: 0, y: 0 };
    this.centred = false;
    this.ensureSlab();
    cx.notify();
  }

  viewport() {
    return { vw: Math.max(1, this.size?.width ?? GRAPH_W), vh: Math.max(1, (this.size?.height ?? GRAPH_H) - BAR_H) };
  }

  clampOrigin(x, y) {
    const cur = this.model.runs[0];
    if (!cur) return { x: 0, y: 0 };
    const { g } = this.shape(cur);
    const { vw, vh } = this.viewport();
    return {
      x: Math.round(Math.max(0, Math.min(Math.max(0, g.width - vw), x))),
      y: Math.round(Math.max(0, Math.min(Math.max(0, HEAD_H + g.height - vh), y))),
    };
  }

  pan(e, cx) {
    let dx = e.delta.x, dy = e.delta.y;
    if (e.modifiers?.shift && Math.abs(dx) < 0.5) { dx = dy; dy = 0; }
    const { x, y } = this.clampOrigin(this.origin.x - dx, this.origin.y - dy);
    if (x === this.origin.x && y === this.origin.y) return;
    this.origin = { x, y };
    this.centred = false;
    // Usually only the slab's wrapper moves; cards are rebuilt only at the slab's edge.
    this.ensureSlab();
    this.panOnly = true;
    this.live.panned(cx);
    cx.notify();
  }

  // Puts the deepest working column (and its top working card) in the middle of the view.
  centerWave(cx) {
    const cur = this.model.runs[0];
    const wave = cur && this.shape(cur).wave;
    if (!wave) return;
    const { vw, vh } = this.viewport();
    this.origin = this.clampOrigin(
      colX(wave.col) + CARD_W / 2 - vw / 2,
      HEAD_H + rowY(wave.row) + CARD_H / 2 - vh / 2,
    );
    this.centred = true;
    this.ensureSlab();
    cx.notify();
  }

  async resume(n) {
    try {
      const result = await exec("python3", ["-I", `${appHome()}/mods/agent-graph/resume.py`, "--history", this.path, n.id]);
      const data = JSON.parse(result.stdout);
      if (data.error) { notify({ title: "Cannot resume session", body: data.error }); return; }
      await run("tab.new", { name: n.v.title, folder: data.cwd, argv: data.argv });
      if (data.session == null) notify({ title: "Session not found", body: "The exact session wasn't found; a session picker opened." });
    } catch (error) { notify({ title: "Cannot resume session", body: String(error) }); }
  }

  close() {
    hosts.delete(this.hostId);
  }

  render(cx) {
    // A pan's render: it's shown (it got the wheel), and live data is checked after the pan.
    const panOnly = this.panOnly;
    this.panOnly = false;
    if (!panOnly) {
      if (!isShown()) {
        this.shown = false;
        return div().size_full();
      }
      const token = shared("agent-graph.shown") ?? null;
      if (token !== this.token || !this.shown) {
        // Shown again: a pass (the history reread only if stale), and durations brought up to date.
        const opened = token !== this.token;
        this.token = token;
        this.shown = true;
        this.live.request(cx);
        cx.spawn(async (cx) => {
          await cx.sleep(0);
          if (opened) this.fh.focus();
          this.ageCards(cx);
        });
      } else {
        this.live.observe(cx, this.snapshot());
      }
    }
    const t = theme();
    const cur = this.model.runs[0] ?? null;

    const root = v_flex()
      .track_focus(this.fh)
      .on_key_down((e, cx) => { if (e.key === "escape") { hide(); cx.stop_propagation(); } })
      .id("root")
      .on_size_change((size, cx) => {
        // Only a real change: notifying on every report would render in a loop.
        if (this.size && Math.round(this.size.width) === Math.round(size.width) && Math.round(this.size.height) === Math.round(size.height)) return;
        this.size = size;
        if (this.model.runs[0]) this.origin = this.clampOrigin(this.origin.x, this.origin.y);
        this.ensureSlab();
        cx.notify();
      })
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.canvas)
      .text_size(12)
      .text_color(t.foreground);

    if (!cur) return root.child(this.bar(t)).child(this.empty(t));
    return root.child(this.graph(t, cur));
  }

  // A bar button, icon only: quiet at rest, hover lights it.
  button(t, id, icon, enabled, onClick) {
    return div()
      .id(id)
      .flex_none()
      .flex()
      .items_center()
      .px(6)
      .py(4)
      .rounded(5)
      .text_color(enabled ? t.muted : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(svg(icon).size(14).flex_none());
  }

  bar(t, hidden = 0) {
    const cur = this.model.runs[0] ?? null;
    const { g, wave } = cur ? this.shape(cur) : {};
    const { error, missing } = this.live;
    const bits = [];
    if (cur) {
      bits.push(`${cur.sum.agents} agents · depth ${g.cols - 1}`);
      if (this.centred) bits.push("centred on the deepest working agent");
      if (hidden > 0) bits.push(`${hidden} not drawn`);
    }
    if (error) bits.push(error);
    else if (missing) bits.push("no recorded history yet");
    return h_flex()
      .h(BAR_H)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(12)
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(8).items_center()
        .children(bits.map((text, i) => div().flex_none().text_color(t.dim).child(i ? `· ${text}` : text))))
      .child(this.button(t, "center", "mods/agent-graph/icons/crosshair.svg", Boolean(wave), (_e, cx) => this.centerWave(cx)))
      .child(this.button(t, "reset", "mods/agent-graph/icons/undo.svg", Boolean(cur) && (this.origin.x > 0 || this.origin.y > 0), (_e, cx) => this.resetView(cx)))
      .child(this.button(t, "close", "mods/workspace-chrome/x.svg", true, () => hide()));
  }

  empty(t) {
    // Blank until the first pass has finished, so it never flashes before the first load.
    const text = this.live.ready ? "No agents in this tab yet." : "";
    return div().flex_1().p(24).text_size(12).text_color(t.dim).child(text);
  }

  // ---- the graph: column headers, links and cards on one fixed canvas

  graph(t, cur) {
    const s = this.shape(cur);
    const { wave } = s;
    this.origin = this.clampOrigin(this.origin.x, this.origin.y);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const { vw, vh } = this.viewport();
    const slab = this.slab?.cur === cur ? this.slab : null;

    const bar = this.bar(t, slab?.hidden ?? 0);

    const heads = [];
    s.cols.forEach((c, col) => {
      const x = colX(col) - ox;
      if (x + CARD_W > 0 && x < vw && slab?.shownCols.has(col)) heads.push(this.header(t, c, col, x, wave?.col === col));
    });
    // The slab is a retained child: moving its wrapper is all a pan inside it costs.
    const body = div().absolute().left(0).top(HEAD_H).w(vw).h(Math.max(1, vh - HEAD_H)).overflow_hidden()
      .when(Boolean(slab), (el) => el.child(div().absolute().left(slab.x0 - ox).top(slab.y0 - oy).w(slab.sw).h(slab.sh).child(this.slabView)));
    const canvas = div()
      .relative()
      .flex_none()
      .w(Math.max(1, vw))
      .h(Math.max(1, vh))
      .overflow_hidden()
      .children(heads)
      .child(body);

    const area = div().id("graph").flex_1().min_h(0).min_w(0).overflow_hidden().on_scroll_wheel((e, cx) => this.pan(e, cx)).child(canvas);
    return v_flex().flex_1().min_w(0).min_h(0).child(bar).child(area);
  }

  // A link from a parent's right edge to a child's left edge: across, down (rounded), across.
  elbow(x1, y1, x2, y2, color) {
    const line = () => div().absolute().border_color(color);
    // A straight run is a filled bar: a zero-height div paints no border.
    if (Math.abs(y2 - y1) < 1) return [div().absolute().left(x1).top(y1 - LINK / 2).w(x2 - x1).h(LINK).bg(color)];
    const mx = Math.round((x1 + x2) / 2);
    const mid = (y1 + y2) / 2;
    const r = Math.min(8, Math.abs(y2 - y1) / 2, (x2 - x1) / 4);
    const down = y2 > y1;
    const top = Math.min(y1, y2);
    const half = Math.abs(y2 - y1) / 2;
    return [
      line().left(x1).top(down ? y1 : mid).w(mx - x1).h(half)
        .when(down, (el) => el.border_t(LINK).border_r(LINK).rounded_tr(r))
        .when(!down, (el) => el.border_b(LINK).border_r(LINK).rounded_br(r)),
      line().left(mx - LINK).top(down ? mid : top).w(x2 - mx + LINK).h(half)
        .when(down, (el) => el.border_b(LINK).border_l(LINK).rounded_bl(r))
        .when(!down, (el) => el.border_t(LINK).border_l(LINK).rounded_tl(r)),
    ];
  }

  header(t, c, col, x, active) {
    const bits = [
      { text: col === 0 ? "Root" : `Depth ${col}`, color: active ? t.foreground : t.muted },
      { text: c.total ? `${c.done}/${c.total} done` : "removed before recording", color: t.dim },
      c.working && { text: `${c.working} working`, color: t.working },
      c.failed && { text: `${c.failed} failed`, color: t.ansi1 },
      c.stopped && { text: `${c.stopped} stopped`, color: t.muted },
    ].filter(Boolean);
    return h_flex()
      .absolute()
      .left(x)
      .top(0)
      .w(CARD_W)
      .h(HEAD_H)
      .pt(12)
      .gap(5)
      .items_start()
      .text_size(11)
      .when(active, (el) => el.border_b(2).border_color(t.accent))
      .children(bits.map((b, i) => div().flex_none().text_color(b.color).child(i ? `· ${b.text}` : b.text)));
  }

  card(t, n, x, y, now, labels) {
    const v = n.v;
    const box = v_flex().id(`card-${n.id}`).absolute().left(x).top(y).w(CARD_W).h(CARD_H).rounded(7).border(1).px(10).py(7).gap(3);
    if (v.ghost) {
      return box.border_dashed().border_color(t.input)
        .child(div().truncate().text_size(12.5).text_color(t.muted).child(n.address))
        .child(div().text_size(11).text_color(t.dim).child("removed before recording"));
    }
    const f = v.f;
    const age = ageText(f, now);
    if (aging(f)) labels?.set(n.id, age);
    const meta = [age, v.meta].filter(Boolean).join(" · ");
    const word = div().flex_none().text_color(t[TONE[v.o.kind] ?? "muted"]).when(v.loud, (el) => el.font_semibold()).child(v.o.word);
    const title = div().min_w(0).truncate().text_size(12.5).font_medium().child(v.title);
    return box
      .bg(t.background)
      .border_color(v.loud ? t.blocked : t.border)
      .when(f.removed != null, (el) => el.opacity(0.55))
      .when(v.peekable || v.resumable, (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent)).on_click(() => v.peekable ? run("terminal.peek", { terminal: v.peek }) : this.resume(n)))
      // A live card carries its program's icon; a recorded agent's card its agent's logo.
      .child(v.program?.icon ? h_flex().gap(7).items_center().child(glyph(t, v, 14)).child(title.flex_1()) : title.w_full())
      .child(word)
      .child(div().truncate().text_size(11).text_color(t.dim).child(meta));
  }

}
