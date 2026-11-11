// The pure model (model.js): reported sub-agents and how they join the graph.
// Run: node model_test.mjs

import assert from "node:assert/strict";
import { reported, merge, facts, layout } from "./model.js";

const CLAUDE = { name: "Claude Code", icon: "icons/claude.svg", tint: false, agent: true };

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
