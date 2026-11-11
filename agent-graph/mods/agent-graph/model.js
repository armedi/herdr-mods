// History records + live terminals -> nodes, parent links and runs, keyed by id (never by address
// alone: an address can be reused after `hc rm`, and every lifetime is its own node).

const machineOf = (addr) => (addr.includes("/") ? addr.slice(0, addr.indexOf("/")) : null);

// A raw parent address as FORMAT.md qualifies it: with the child's machine prefix when it has none.
export function qualify(parent, child) {
  if (!parent) return null;
  const m = machineOf(child);
  return m && !parent.includes("/") ? `${m}/${parent}` : parent;
}

// Agents whose closed runs can be resumed: keep in step with ALIASES in resume.py.
export const RESUMABLE = new Set(["claude", "claude-code", "codex", "grok", "grok-build", "cmd", "command-code", "copilot", "opencode"]);

/** A record's agent word: hc's `agent`, else the basename of its command's first word. */
export const agentOf = (rec) => rec.agent || (rec.command || "").trim().split(/\s+/)[0].split("/").pop();

/**
 * The sub-agents live terminals report on, as terminal-shaped children of them. hc keeps every
 * OSC 7501 record other than a program's root one in the terminal's `records`, by id: Claude Code
 * sends one per running Agent-tool sub-agent, titled with its description, and clears it when the
 * sub-agent finishes. A child's address is `<terminal>#<id>`, the id URI-encoded so that a "/" in
 * it can't read as a machine prefix. Records carry no start time, so `seen` (address -> ms) says
 * when each child was first seen; the returned map keeps only the children still reported.
 * list: [{ term, records }], term as main.js's liveTerminals() gives it, records as hc's.
 */
export function reported(list, seen, now) {
  const children = [];
  const next = new Map();
  for (const { term, records } of list) {
    if (term.state !== "live" || !records || typeof records !== "object") continue;
    for (const [id, r] of Object.entries(records)) {
      if (!id || typeof r?.state !== "string") continue;
      const address = `${term.address}#${encodeURIComponent(id)}`;
      const seenMs = seen.get(address) ?? now;
      next.set(address, seenMs);
      children.push({
        address,
        parent: term.address,
        created_ms: null,
        finished_ms: null,
        exit_code: null,
        reason: null,
        state: "live",
        status: r.state,
        name: r.title || "sub-agent",
        template: null,
        argv: null,
        space_label: term.space_label,
        tab_label: term.tab_label,
        program: term.program,
        sub: true,
        msg: r.msg || null,
        seen_ms: seenMs,
      });
    }
  }
  return { children, seen: next };
}

/** Whether a node is a reported sub-agent: a live one from reported(), or a recorded one (the
 *  recorder writes its address as its terminal's, `#`, then the id). */
export const isSub = (n) => Boolean(n.live?.sub) || Boolean(n.rec?.parent && n.rec.address.startsWith(`${n.rec.parent}#`));

export function parseHistory(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.records)) throw new Error("no records list");
  return data.records.filter((r) => r && typeof r.id === "string" && typeof r.address === "string");
}

const createdOf = (n) => n.rec?.created_ms ?? n.live?.created_ms ?? n.live?.seen_ms ?? 0;

// The record FORMAT.md's parent_id would name: that address, latest created_ms not after the child's.
function recordedParent(list, created) {
  let best = null;
  for (const n of list ?? []) {
    const c = n.rec.created_ms ?? 0;
    if (created != null && c > created) continue;
    if (!best || c > (best.rec.created_ms ?? 0)) best = n;
  }
  return best;
}

/** Every node, its parent and children, and the runs (roots with at least one descendant). */
export function merge(records, terms) {
  const nodes = new Map();
  const byAddr = new Map();
  for (const rec of records) {
    if (nodes.has(rec.id)) continue;
    const n = { id: rec.id, address: rec.address, rec, live: null, ghost: false, parent: null, kids: [] };
    nodes.set(rec.id, n);
    if (!byAddr.has(rec.address)) byAddr.set(rec.address, []);
    byAddr.get(rec.address).push(n);
  }

  // A live terminal matches its record by id; without created_ms, only the newest record of its
  // address, and only while that one isn't removed.
  const liveByAddr = new Map();
  for (const t of terms) {
    if (!t?.address) continue;
    let n = null;
    if (t.created_ms != null) n = nodes.get(`${t.address}@${t.created_ms}`) ?? null;
    else {
      const newest = recordedParent(byAddr.get(t.address), null);
      if (newest && newest.rec.removed_ms == null) n = newest;
    }
    if (n?.live) continue;
    if (!n) {
      const id = t.created_ms != null ? `${t.address}@${t.created_ms}` : `${t.address}@live`;
      if (nodes.has(id)) continue;
      n = { id, address: t.address, rec: null, live: null, ghost: false, parent: null, kids: [] };
      nodes.set(id, n);
    }
    n.live = t;
    if (!liveByAddr.has(t.address) || t.state === "live") liveByAddr.set(t.address, n);
  }

  // Parents: records by parent_id; live-only nodes by their parent's live terminal, else its record.
  // A parent that resolves to nothing becomes a ghost shared by all its children.
  const ghosts = new Map();
  for (const n of nodes.values()) {
    let p = null;
    let raw = null;
    if (n.rec) {
      raw = qualify(n.rec.parent, n.address);
      if (n.rec.parent_id) p = nodes.get(n.rec.parent_id) ?? null;
      // parent_id is null when no retained record qualifies; a parent that exists live now
      // (only seen in terminals(), or not yet recorded) still isn't an unknown one.
      if (!p && raw) {
        const created = n.rec.created_ms ?? null;
        const live = liveByAddr.get(raw);
        if (live && (created == null || createdOf(live) <= created)) p = live;
        else p = recordedParent(byAddr.get(raw), created);
      }
    } else {
      raw = qualify(n.live.parent, n.address);
      if (raw) p = liveByAddr.get(raw) ?? recordedParent(byAddr.get(raw), n.live.created_ms);
    }
    if (!p && raw) {
      const gid = `ghost:${raw}`;
      if (!ghosts.has(gid)) ghosts.set(gid, { id: gid, address: raw, rec: null, live: null, ghost: true, parent: null, kids: [] });
      p = ghosts.get(gid);
    }
    n.parent = p === n ? null : p;
  }
  const all = [...nodes.values(), ...ghosts.values()];

  // Cycles: cut the link that closes the loop.
  const mark = new Map();
  for (const n of all) {
    if (mark.has(n)) continue;
    const path = [];
    let c = n;
    for (;;) {
      mark.set(c, 1);
      path.push(c);
      if (!c.parent) break;
      const m = mark.get(c.parent);
      if (m === 1) { c.parent = null; break; }
      if (m === 2) break;
      c = c.parent;
    }
    for (const p of path) mark.set(p, 2);
  }
  for (const n of all) if (n.parent) n.parent.kids.push(n);
  for (const n of all) n.kids.sort((a, b) => createdOf(a) - createdOf(b));

  const runs = [];
  for (const root of all) {
    if (root.parent) continue;
    // A live agent that has not spawned anything yet is still a graph of one.
    const solo = root.live && (root.live.status != null || root.live.program?.agent);
    if (root.kids.length === 0 && !solo) continue;
    const list = [];
    const visit = (n, depth) => {
      n.depth = depth;
      list.push(n);
      for (const k of n.kids) visit(k, depth + 1);
    };
    visit(root, 0);
    runs.push({ id: root.id, root, nodes: list });
  }
  return runs;
}

// ---- what a card says

/** Live data wins for state, status, name, program and template. */
export function facts(n) {
  if (n.ghost) return null;
  const l = n.live;
  const r = n.rec;
  const liveFinished = l && l.state !== "live";
  return {
    state: l ? l.state : r.state,
    status: l ? l.status ?? null : r.status ?? null,
    created: r?.created_ms ?? l?.created_ms ?? l?.seen_ms ?? null,
    finished: (liveFinished ? l.finished_ms : null) ?? r?.finished_ms ?? null,
    exit_code: liveFinished ? l.exit_code ?? null : r?.exit_code ?? null,
    reason: liveFinished ? l.reason ?? null : r?.reason ?? null,
    // In terminals() now: it exists, whatever the history says.
    removed: l ? null : r?.removed_ms ?? null,
    notSeen: !l && r?.removed_ms == null,
  };
}

export function title(n) {
  if (n.ghost) return n.address;
  const l = n.live;
  const r = n.rec;
  const word = (s) => (s ?? "").trim().split(/\s+/)[0] || null;
  return l?.name || r?.name || l?.template || l?.program?.name || r?.agent || word(r?.command) || word(l?.argv?.join?.(" ")) || n.address;
}

/** One word for how it ends or stands: { word, kind }. kind picks the color. */
export function outcome(n, f = facts(n)) {
  if (f.state === "live") {
    // Gone while live: it didn't say how it ended.
    if (f.removed != null) return { word: "ended", kind: "ended" };
    if (f.status) return { word: f.status, kind: f.status };
    return { word: "running", kind: "running" };
  }
  if (f.reason === "killed") return { word: "stopped", kind: "stopped" };
  if (f.exit_code === 0) return { word: "done", kind: "done" };
  if (f.exit_code != null) return { word: `failed (${f.exit_code})`, kind: "failed" };
  return { word: "ended", kind: "ended" };
}

/** Counts toward "k/n done": finished, or a live done, or idle after having worked. */
export function isDone(n, f, o, worked) {
  if (f.state !== "live" || f.removed != null) return true;
  if (o.kind === "done") return true;
  return o.kind === "idle" && (worked(n.id) || n.kids.length > 0);
}

export function duration(ms) {
  if (ms == null || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function clock(ms, now) {
  if (ms == null) return "";
  const d = new Date(ms);
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString() ? t : `${MONTHS[d.getMonth()]} ${d.getDate()} ${t}`;
}

// ---- runs

const AGG = { blocked: 4, error: 4, working: 3, failed: 2 };

/** A run's picker facts: agent count, aggregate state, latest activity, live work. */
function summarize(run) {
  let agg = "done";
  let latest = 0;
  let liveWorking = false;
  let agents = 0;
  for (const n of run.nodes) {
    if (n.ghost) continue;
    agents++;
    const f = n.v?.f ?? facts(n);
    const o = n.v?.o ?? outcome(n, f);
    if ((AGG[o.kind] ?? 0) > (AGG[agg] ?? 0)) agg = o.kind === "error" ? "blocked" : o.kind;
    if (o.kind === "working" && n.live) liveWorking = true;
    latest = Math.max(latest, f.created ?? 0, f.finished ?? 0, f.removed ?? 0);
  }
  return { agg, latest, liveWorking, agents };
}

export function orderRuns(runs) {
  for (const r of runs) r.sum = summarize(r);
  return runs.sort((a, b) => (b.sum.liveWorking - a.sum.liveWorking) || (b.sum.latest - a.sum.latest));
}

// ---- layout: columns by depth, children under their parent in spawn order, so links don't cross

export const CARD_W = 216;
export const CARD_H = 76;
const COL_GAP = 60;
const ROW_GAP = 12;
const PAD = 20;

export const colX = (col) => PAD + col * (CARD_W + COL_GAP);
export const rowY = (row) => PAD + row * (CARD_H + ROW_GAP);

// Each column keeps depth-first order; a parent moves down to its first child's row.
export function layout(run) {
  const next = [];
  const pos = new Map();
  const visit = (n, minRow) => {
    let row = Math.max(next[n.depth] ?? 0, minRow);
    for (const k of n.kids) visit(k, row);
    if (n.kids.length) row = Math.max(row, pos.get(n.kids[0].id).row);
    pos.set(n.id, { col: n.depth, row });
    next[n.depth] = row + 1;
  };
  visit(run.root, 0);
  const cols = next.length;
  const rows = Math.max(...next);
  return {
    pos,
    cols,
    width: PAD * 2 + cols * CARD_W + (cols - 1) * COL_GAP,
    height: PAD * 2 + rows * (CARD_H + ROW_GAP) - ROW_GAP,
  };
}
