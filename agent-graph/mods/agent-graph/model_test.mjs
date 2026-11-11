// The pure model (model.js): reported sub-agents and how they join the graph, live and recorded.
// Run: node model_test.mjs

import assert from "node:assert/strict";
import { reported, merge, facts, layout, outcome, isSub } from "./model.js";

const CLAUDE = { name: "Claude Code", icon: "icons/claude.svg", tint: false, agent: true };

// A history record as the recorder writes it (FORMAT.md).
function rec(address, created_ms, extra = {}) {
  return {
    id: `${address}@${created_ms}`,
    address,
    parent: null,
    parent_id: null,
    name: null,
    agent: "claude-code",
    command: null,
    cwd: "/work",
    where: "space / tab",
    state: "live",
    status: "working",
    created_ms,
    finished_ms: null,
    exit_code: null,
    reason: null,
    removed_ms: null,
    ...extra,
  };
}

// A live terminal as main.js's liveTerminals() gives it.
function term(address, extra = {}) {
  return {
    address,
    parent: null,
    created_ms: 1000,
    finished_ms: null,
    exit_code: null,
    reason: null,
    state: "live",
    status: "working",
    name: null,
    template: null,
    argv: ["claude"],
    space_label: "s1",
    tab_label: "tab1",
    program: CLAUDE,
    ...extra,
  };
}

const tests = {
  "reported records become children of their terminal"() {
    const t1 = term("t1");
    const { children, seen } = reported([{ term: t1, records: {
      a1: { state: "working", title: "Find the parser" },
      a2: { state: "blocked", kind: "question", msg: "Which file?" },
    } }], new Map(), 5000);
    assert.deepEqual(children.map((c) => [c.address, c.parent, c.status, c.name, c.msg]), [
      ["t1#a1", "t1", "working", "Find the parser", null],
      ["t1#a2", "t1", "blocked", "sub-agent", "Which file?"],
    ]);
    for (const c of children) {
      assert.equal(c.sub, true);
      assert.equal(c.state, "live");
      assert.equal(c.program, CLAUDE);
      assert.equal(c.tab_label, "tab1");
      // No start time of its own: a created_ms would key it apart from its later history record.
      assert.equal(c.created_ms, null);
      assert.equal(c.seen_ms, 5000);
    }
    assert.deepEqual([...seen], [["t1#a1", 5000], ["t1#a2", 5000]]);
  },

  "a child keeps the time it was first seen while it is reported"() {
    const t1 = term("t1");
    const first = reported([{ term: t1, records: { a1: { state: "working" } } }], new Map(), 5000);
    const again = reported([{ term: t1, records: { a1: { state: "working" }, a2: { state: "working" } } }], first.seen, 9000);
    assert.deepEqual(again.children.map((c) => [c.address, c.seen_ms]), [["t1#a1", 5000], ["t1#a2", 9000]]);
  },

  "a cleared record goes, and so does its first-seen time"() {
    const t1 = term("t1");
    const first = reported([{ term: t1, records: { a1: { state: "working" }, a2: { state: "working" } } }], new Map(), 5000);
    const after = reported([{ term: t1, records: { a2: { state: "working" } } }], first.seen, 9000);
    assert.deepEqual(after.children.map((c) => c.address), ["t1#a2"]);
    assert.deepEqual([...after.seen.keys()], ["t1#a2"]);
    // Reported again later, it is a new sub-agent with a new start.
    const back = reported([{ term: t1, records: { a1: { state: "working" } } }], after.seen, 12000);
    assert.equal(back.children[0].seen_ms, 12000);
  },

  "a finished terminal, or one without records, adds nothing"() {
    const list = [
      { term: term("t1", { state: "finished" }), records: { a1: { state: "working" } } },
      { term: term("t2"), records: undefined },
      { term: term("t3"), records: {} },
      { term: term("t4"), records: { "": { state: "working" }, bad: { title: "no state" } } },
    ];
    const { children, seen } = reported(list, new Map(), 5000);
    assert.deepEqual(children, []);
    assert.equal(seen.size, 0);
  },

  "a remote terminal's children stay on its machine, even with a slash in the id"() {
    const remote = term("box/t7");
    const local = term("t2");
    const { children } = reported([
      { term: remote, records: { a1: { state: "working" } } },
      { term: local, records: { "x/y": { state: "working" } } },
    ], new Map(), 5000);
    assert.deepEqual(children.map((c) => [c.address, c.parent]), [["box/t7#a1", "box/t7"], ["t2#x%2Fy", "t2"]]);
    // Both join their own terminal, not a ghost on another machine.
    const runs = merge([], [remote, local, ...children]);
    const parentOf = new Map(runs.flatMap((r) => r.nodes).map((n) => [n.address, n.parent?.address ?? null]));
    assert.equal(parentOf.get("box/t7#a1"), "box/t7");
    assert.equal(parentOf.get("t2#x%2Fy"), "t2");
    assert.equal(runs.flatMap((r) => r.nodes).some((n) => n.ghost), false);
  },

  "merge puts sub-agents one column right of their terminal, in the order first seen"() {
    const t1 = term("t1");
    const helper = term("t9", { parent: "t1", created_ms: 6000, argv: ["sleep", "60"], program: null, status: null });
    const first = reported([{ term: t1, records: { b: { state: "working" } } }], new Map(), 7000);
    const { children } = reported([{ term: t1, records: { a: { state: "working" }, b: { state: "working" } } }], first.seen, 8000);
    const runs = merge([], [t1, helper, ...children]);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.root.address, "t1");
    // An `hc run` helper (created 6000) and the reported sub-agents (seen 7000 and 8000), by start.
    assert.deepEqual(run.root.kids.map((k) => k.address), ["t9", "t1#b", "t1#a"]);
    const g = layout(run);
    assert.equal(g.cols, 2);
    for (const k of run.root.kids) assert.equal(g.pos.get(k.id).col, 1);
  },

  "a sub-agent's duration counts from when it was first seen"() {
    const t1 = term("t1");
    const { children } = reported([{ term: t1, records: { a1: { state: "working" } } }], new Map(), 5000);
    const run = merge([], [t1, ...children])[0];
    const kid = run.root.kids[0];
    const f = facts(kid);
    assert.equal(f.created, 5000);
    assert.equal(f.state, "live");
    assert.equal(f.status, "working");
  },

  "a running sub-agent joins its recorded record instead of showing twice"() {
    const records = [
      rec("t1", 1000, { command: "claude" }),
      rec("t1#a1", 4000, { parent: "t1", parent_id: "t1@1000", name: "Find the parser" }),
    ];
    const t1 = term("t1");
    // This copy of the graph saw it later than the recorder did.
    const { children } = reported([{ term: t1, records: { a1: { state: "blocked", title: "Find the parser" } } }], new Map(), 9000);
    const run = merge(records, [t1, ...children])[0];
    assert.deepEqual(run.nodes.map((n) => n.address), ["t1", "t1#a1"]);
    const kid = run.root.kids[0];
    assert.ok(kid.rec && kid.live);
    assert.equal(isSub(kid), true);
    const f = facts(kid);
    // The live status wins; the start is the recorder's, the same in every copy of the graph.
    assert.equal(f.status, "blocked");
    assert.equal(f.created, 4000);
  },

  "a finished sub-agent stays under its agent as ended"() {
    const records = [
      rec("t1", 1000, { command: "claude" }),
      rec("t1#a1", 4000, { parent: "t1", parent_id: "t1@1000", name: "Find the parser", state: "finished", finished_ms: 9000 }),
    ];
    const run = merge(records, [term("t1")])[0];
    const kid = run.root.kids[0];
    assert.equal(kid.address, "t1#a1");
    assert.equal(kid.live, null);
    assert.equal(isSub(kid), true);
    assert.equal(isSub(run.root), false);
    assert.deepEqual(outcome(kid), { word: "ended", kind: "ended" });
    assert.equal(facts(kid).finished, 9000);
  },

  "only an address under its own parent is a recorded sub-agent"() {
    assert.equal(isSub({ rec: rec("box/t7#a1", 1, { parent: "box/t7" }), live: null }), true);
    assert.equal(isSub({ rec: rec("t2", 1, { parent: "t1" }), live: null }), false);
    assert.equal(isSub({ rec: rec("t10#a1", 1, { parent: "t1" }), live: null }), false);
    assert.equal(isSub({ rec: rec("t1#a1", 1), live: null }), false);
  },

  "the sub-agent address matches recorder.py's byte for byte"() {
    // The recorder writes the same address with quote(); the view matches its record by it.
    // recorder_test.py pins the same string.
    const { children } = reported([{ term: term("box/t7"), records: { "x/y z#é!'()*~-_.": { state: "working" } } }], new Map(), 1);
    assert.equal(children[0].address, "box/t7#x%2Fy%20z%23%C3%A9!'()*~-_.");
  },
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try {
    await test();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${e?.stack ?? e}`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`all ${Object.keys(tests).length} passed`);
