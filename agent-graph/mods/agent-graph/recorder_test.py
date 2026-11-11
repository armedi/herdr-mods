import fcntl
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDER = os.path.join(HERE, "recorder.py")
spec = importlib.util.spec_from_file_location("recorder", RECORDER)
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)

DAY = 86400000
NOW = 1800000000000


def term(address, created_ms, **kw):
    t = {
        "address": address, "argv": ["zsh"], "created_ms": created_ms, "cwd": "/tmp",
        "exit_code": None, "finished_ms": None, "labels": {}, "name": address,
        "parent": None, "reason": None, "state": "live", "status": None, "title": "",
    }
    t.update(kw)
    return t


def snapshot(*terminals):
    return json.dumps({"channel": None, "seq": 1, "terminals": list(terminals)})


def event(etype, address, data):
    return json.dumps({"jsonrpc": "2.0", "method": "event",
                       "params": {"type": etype, "terminal": address, "seq": 2, "data": data}})


def by_id(d):
    return {r["id"]: r for r in d["records"]}


def feed(rec, *lines, now=NOW):
    for line in lines:
        rec.handle_line(line, now)


class RecorderTest(unittest.TestCase):
    def setUp(self):
        self.rec = recorder.Recorder()

    def snap(self, now=NOW):
        return self.rec.snapshot_dict(now)

    def test_01_snapshot_records(self):
        feed(self.rec, snapshot(
            term("t1", 100, argv=["claude", "--flag"], labels={"where": "space / tab"}),
            term("t2", 200, parent="t1", name="child"),
        ))
        recs = by_id(self.snap())
        self.assertEqual(set(recs), {"t1@100", "t2@200"})
        self.assertEqual(recs["t1@100"]["where"], "space / tab")
        self.assertEqual(recs["t1@100"]["command"], "claude --flag")
        self.assertIsNone(recs["t1@100"]["parent_id"])
        self.assertEqual(recs["t2@200"]["parent"], "t1")
        self.assertEqual(recs["t2@200"]["parent_id"], "t1@100")
        self.assertEqual(recs["t2@200"]["name"], "child")

    def test_02_created_then_finished(self):
        feed(self.rec,
             event("created", "t3", term("t3", 300)),
             event("finished", "t3", {"exit_code": 7, "finished_ms": 999, "reason": "exited", "signal": None}))
        r = by_id(self.snap())["t3@300"]
        self.assertEqual((r["state"], r["exit_code"], r["finished_ms"], r["reason"]),
                         ("finished", 7, 999, "exited"))

    def test_03_removed_both_shapes(self):
        feed(self.rec, snapshot(term("t1", 100), term("t2", 200)),
             event("removed", "t1", {}), json.dumps({"removed": "t2"}))
        recs = by_id(self.snap())
        self.assertEqual(recs["t1@100"]["removed_ms"], NOW)
        self.assertEqual(recs["t2@200"]["removed_ms"], NOW)
        self.assertEqual(self.rec.current, {})

    def test_04_status_words(self):
        feed(self.rec, snapshot(term("t1", 100), term("t2", 200, status={"app": "x", "state": "idle"})))
        self.assertEqual(by_id(self.snap())["t2@200"]["status"], "idle")
        feed(self.rec, event("status", "t1", {
            "status": {"app": "claude-code", "msg": "x", "state": "working"},
            "reported": True, "records": {}}))
        self.assertEqual(by_id(self.snap())["t1@100"]["status"], "working")
        feed(self.rec, event("status", "t1", {"status": None, "reported": False, "records": {}}))
        self.assertIsNone(by_id(self.snap())["t1@100"]["status"])

    def test_05_address_reuse(self):
        feed(self.rec, event("created", "t5", term("t5", 100)), event("removed", "t5", {}),
             event("created", "t5", term("t5", 200)),
             event("created", "t6", term("t6", 250, parent="t5")),
             event("created", "t7", term("t7", 150, parent="t5")))
        recs = by_id(self.snap())
        self.assertEqual(len([r for r in recs.values() if r["address"] == "t5"]), 2)
        self.assertEqual(recs["t6@250"]["parent_id"], "t5@200")
        self.assertEqual(recs["t7@150"]["parent_id"], "t5@100")
        self.assertIsNotNone(recs["t5@100"]["removed_ms"])
        self.assertIsNone(recs["t5@200"]["removed_ms"])

    def test_06_remote_prefix(self):
        feed(self.rec, event("created", "remote/t3", term("remote/t3", 100, parent="t1")))
        self.assertEqual(by_id(self.snap())["remote/t3@100"]["parent"], "remote/t1")

    def test_07_apply_listing(self):
        feed(self.rec, snapshot(term("t1", 100), term("t2", 200)))
        feed(self.rec, event("created", "remote/t1", term("remote/t1", 300)))
        self.rec.apply_listing({"machines": [], "terminals": [
            {"address": "t1", "agent": "claude-code", "status": "working", "state": "live"}]}, NOW + 1)
        recs = by_id(self.snap())
        self.assertEqual(recs["t1@100"]["agent"], "claude-code")
        self.assertEqual(recs["t1@100"]["status"], "working")
        self.assertEqual(recs["t2@200"]["removed_ms"], NOW + 1)
        self.assertIsNone(recs["remote/t1@300"]["removed_ms"])
        self.rec.apply_listing({"machines": [{"name": "remote", "state": "connecting"}],
                                "terminals": []}, NOW + 2)
        self.assertIsNone(by_id(self.snap())["remote/t1@300"]["removed_ms"])
        self.rec.apply_listing({"machines": [{"name": "remote", "state": "connected"}],
                                "terminals": [{"address": "t1"}]}, NOW + 3)
        self.assertEqual(by_id(self.snap())["remote/t1@300"]["removed_ms"], NOW + 3)

    def test_08_snapshot_remote_and_local(self):
        feed(self.rec, event("created", "remote/t1", term("remote/t1", 100)),
             event("created", "t2", term("t2", 200)))
        feed(self.rec, snapshot(term("t9", 900)))
        recs = by_id(self.snap())
        self.assertIsNone(recs["remote/t1@100"]["removed_ms"])
        self.assertEqual(recs["t2@200"]["removed_ms"], NOW)

    def test_09_prune(self):
        feed(self.rec, event("created", "t1", term("t1", NOW - 20 * DAY)),
             event("created", "t2", term("t2", NOW - 20 * DAY)),
             event("created", "t3", term("t3", NOW - 30 * DAY)))
        self.rec.handle_line(event("removed", "t1", {}), NOW - 15 * DAY)
        self.rec.handle_line(event("removed", "t2", {}), NOW - 13 * DAY)
        recs = by_id(self.snap())
        self.assertNotIn(f"t1@{NOW - 20 * DAY}", recs)
        self.assertIn(f"t2@{NOW - 20 * DAY}", recs)
        self.assertIn(f"t3@{NOW - 30 * DAY}", recs)

    def test_09_prune_count(self):
        for i in range(1600):
            feed(self.rec, event("created", f"t{i}", term(f"t{i}", NOW - 100000 + i)),
                 event("removed", f"t{i}", {}))
        d = self.snap()
        self.assertEqual(len(d["records"]), 1500)
        self.assertEqual(min(r["created_ms"] for r in d["records"]), NOW - 100000 + 100)
        self.assertEqual(len(self.rec.records), 1500)

    def test_10_pruned_parent(self):
        feed(self.rec, event("created", "t1", term("t1", NOW - 20 * DAY)),
             event("created", "t2", term("t2", NOW - DAY, parent="t1")))
        self.rec.handle_line(event("removed", "t1", {}), NOW - 19 * DAY)
        r = by_id(self.snap())[f"t2@{NOW - DAY}"]
        self.assertIsNone(r["parent_id"])
        self.assertEqual(r["parent"], "t1")

    def test_11_size_cap(self):
        for i in range(1400):
            feed(self.rec,
                 event("created", f"t{i}", term(f"t{i}", NOW - 100000 + i, cwd="/" + "c" * 400,
                                                 argv=["a" * 250], name="n" * 200,
                                                 labels={"where": "w" * 300})),
                 event("removed", f"t{i}", {}))
        d = self.snap()
        data = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLess(len(data), 900000)
        self.assertGreater(len(d["records"]), 0)
        self.assertEqual(len(d["records"][0]["cwd"]), 300)

    def test_12_ignored_events(self):
        feed(self.rec, event("created", "t1", term("t1", 100)))
        self.rec.dirty = False
        feed(self.rec, event("title", "t1", {"title": "x"}), event("foreground", "t1", {"x": 1}),
             event("size", "t1", {}), "not json", json.dumps([1]), json.dumps({"other": 1}),
             event("status", "t99", {"status": None}))
        self.assertFalse(self.rec.dirty)

    def test_13_loading(self):
        good = dict.fromkeys(recorder.KEYS)
        good.update(id="t1@100", address="t1", created_ms=100, status={"state": "idle"})
        bad = dict(good, id="t1@999")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            with open(path, "w") as f:
                json.dump({"version": 1, "updated_ms": 1, "records": [bad, good, "x"]}, f)
            rec = recorder.Recorder()
            rec.load(path)
        self.assertEqual(list(rec.records), ["t1@100"])
        self.assertEqual(rec.current, {"t1": "t1@100"})
        self.assertEqual(rec.records["t1@100"]["status"], "idle")

    def test_13_loading_wrong_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            with open(path, "w") as f:
                json.dump({"version": 2, "records": []}, f)
            rec = recorder.Recorder()
            rec.load(path)
            self.assertEqual(rec.records, {})
            self.assertEqual(len([n for n in os.listdir(tmp) if n.startswith("history.json.bad-")]), 1)

    def test_13_loading_preserves_unreadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            with open(path, "w") as f:
                f.write("{ not json")
            rec = recorder.Recorder()
            rec.load(path)
            self.assertEqual(rec.records, {})
            aside = [n for n in os.listdir(tmp) if n.startswith("history.json.bad-")]
            self.assertEqual(len(aside), 1)
            with open(os.path.join(tmp, aside[0])) as f:
                self.assertEqual(f.read(), "{ not json")

    def test_13_preserve_names_unique(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            for _ in range(3):
                with open(path, "w") as f:
                    f.write("{")
                recorder.Recorder().load(path)
            aside = [n for n in os.listdir(tmp) if n.startswith("history.json.bad-")]
            self.assertEqual(len(aside), 3)

    def test_13_preserve_failure_aborts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            with open(path, "w") as f:
                f.write("{ not json")
            with mock.patch("os.replace", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    recorder.Recorder().load(path)
            with open(path) as f:
                self.assertEqual(f.read(), "{ not json")

    def test_11b_size_cap_current_only(self):
        for i in range(2000):
            feed(self.rec, event("created", f"t{i}", term(f"t{i}", NOW - 200000 + i,
                                                         cwd="/" + "c" * 400, argv=["a" * 250],
                                                         name="n" * 200, labels={"where": "w" * 300})))
        d = self.snap()
        data = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLess(len(data), 900000)
        self.assertGreater(len(d["records"]), 0)

    def test_16_sub_agents_from_status_events(self):
        feed(self.rec, snapshot(term("t1", 100, argv=["claude"], labels={"where": "space / tab"})))
        self.rec.apply_listing({"machines": [], "terminals": [
            {"address": "t1", "agent": "claude-code", "state": "live"}]}, NOW)
        root = {"app": "claude-code", "state": "working"}
        self.rec.handle_line(event("status", "t1", {"status": root, "reported": True, "records": {
            "a1": {"app": "claude-code", "state": "working", "title": "Find the parser"}}}), NOW + 10)
        r = by_id(self.snap())[f"t1#a1@{NOW + 10}"]
        self.assertEqual((r["address"], r["parent"], r["parent_id"], r["name"], r["status"], r["state"]),
                         ("t1#a1", "t1", "t1@100", "Find the parser", "working", "live"))
        self.assertEqual((r["agent"], r["cwd"], r["where"], r["command"]),
                         ("claude-code", "/tmp", "space / tab", None))
        self.rec.handle_line(event("status", "t1", {"status": root, "reported": True, "records": {}}), NOW + 20)
        r = by_id(self.snap())[f"t1#a1@{NOW + 10}"]
        self.assertEqual((r["state"], r["finished_ms"], r["exit_code"], r["reason"], r["removed_ms"]),
                         ("finished", NOW + 20, None, None, None))
        self.assertEqual(self.rec.current, {"t1": "t1@100"})

    def test_17_sub_agents_end_with_their_terminal(self):
        feed(self.rec, snapshot(term("t1", 100), term("t2", 200)))
        feed(self.rec, event("status", "t1", {"records": {"a1": {"state": "working"}}}),
             event("status", "t2", {"records": {"a2": {"state": "blocked"}}}), now=NOW + 5)
        self.rec.handle_line(event("finished", "t1", {"exit_code": 0, "finished_ms": NOW + 29, "reason": "exited"}), NOW + 30)
        self.rec.handle_line(event("removed", "t2", {}), NOW + 40)
        recs = by_id(self.snap())
        a1, a2 = recs[f"t1#a1@{NOW + 5}"], recs[f"t2#a2@{NOW + 5}"]
        self.assertEqual((a1["state"], a1["finished_ms"]), ("finished", NOW + 30))
        self.assertEqual((a2["state"], a2["finished_ms"], a2["removed_ms"]), ("finished", NOW + 40, None))
        self.assertEqual(self.rec.current, {"t1": "t1@100"})

    def test_18_sub_agents_in_snapshots_and_listings(self):
        t1 = term("t1", 100, records={"a1": {"state": "working", "title": "x"}, "a2": {"state": "working"}})
        feed(self.rec, snapshot(t1))
        # A later snapshot (after a reconnect) lists no sub-agent as a terminal of its own.
        feed(self.rec, snapshot(t1), now=NOW + 5)
        # Nor does `hc ls`, which has no records at all.
        self.rec.apply_listing({"machines": [], "terminals": [
            {"address": "t1", "agent": "claude-code", "cwd": "/tmp", "name": "t1", "state": "live",
             "status": "working", "turn": 0}]}, NOW + 9)
        recs = by_id(self.snap())
        self.assertEqual({i for i in recs if "#" in i}, {f"t1#a1@{NOW}", f"t1#a2@{NOW}"})
        self.assertTrue(all(recs[i]["state"] == "live" and recs[i]["removed_ms"] is None for i in recs))
        self.assertEqual(set(self.rec.current), {"t1", "t1#a1", "t1#a2"})

    def test_19_sub_agents_on_another_machine(self):
        feed(self.rec, event("created", "remote/t3", term("remote/t3", 100, parent="t1",
                                                          records={"a1": {"state": "working"}})))
        self.rec.apply_listing({"machines": [{"name": "remote", "state": "connected"}], "terminals": [
            {"address": "remote/t3", "state": "live"}]}, NOW + 1)
        r = by_id(self.snap())[f"remote/t3#a1@{NOW}"]
        self.assertEqual((r["parent"], r["parent_id"], r["state"], r["removed_ms"]),
                         ("remote/t3", "remote/t3@100", "live", None))

    def test_20_sub_agents_after_a_restart(self):
        both = {"a1": {"state": "working"}, "a2": {"state": "working"}}
        feed(self.rec, snapshot(term("t1", 100, records=both)))
        feed(self.rec, event("status", "t1", {"records": {"a1": {"state": "working"}}}), now=NOW + 5)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "history.json")
            self.rec.flush(path, NOW + 6)
            rec = recorder.Recorder()
            rec.load(path)
        # The finished one is gone from the core, the running one is still there.
        self.assertEqual(rec.current, {"t1": "t1@100", "t1#a1": f"t1#a1@{NOW}"})
        feed(rec, snapshot(term("t1", 100, records={"a1": {"state": "working"}})), now=NOW + 60)
        recs = by_id(rec.snapshot_dict(NOW + 60))
        self.assertEqual(set(recs), {"t1@100", f"t1#a1@{NOW}", f"t1#a2@{NOW}"})
        self.assertEqual(recs[f"t1#a2@{NOW}"]["finished_ms"], NOW + 5)

    def test_21_sub_address_matches_main_js_byte_for_byte(self):
        # main.js builds the live sub-agent's address with encodeURIComponent and matches this
        # record by it; model_test.mjs pins the same string.
        self.assertEqual(recorder.sub_address("box/t7", "x/y z#é!'()*~-_."),
                         "box/t7#x%2Fy%20z%23%C3%A9!'()*~-_.")

    def test_22_sub_agents_take_the_agent_the_listing_names_later(self):
        # A sub-agent can start and finish before the next `hc ls` names its terminal's agent.
        feed(self.rec, snapshot(term("t1", 100)))
        feed(self.rec, event("status", "t1", {"records": {"a1": {"state": "working"}}}), now=NOW + 1)
        feed(self.rec, event("status", "t1", {"records": {}}), now=NOW + 2)
        self.rec.apply_listing({"machines": [], "terminals": [
            {"address": "t1", "agent": "claude-code", "state": "live"}]}, NOW + 3)
        feed(self.rec, event("status", "t1", {"records": {"a2": {"state": "working"}}}), now=NOW + 4)
        recs = by_id(self.snap())
        self.assertEqual(recs[f"t1#a1@{NOW + 1}"]["agent"], "claude-code")
        self.assertEqual(recs[f"t1#a2@{NOW + 4}"]["agent"], "claude-code")


class ProcessTest(unittest.TestCase):
    def run_replay(self, tmp, lines):
        events = os.path.join(tmp, "events.jsonl")
        with open(events, "w") as f:
            f.write("\n".join(lines) + "\n")
        return subprocess.run(
            ["/usr/bin/python3", "-I", RECORDER, "--replay", events,
             "--out", os.path.join(tmp, "history.json")], capture_output=True, text=True)

    def test_14_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self.run_replay(tmp, [
                snapshot(term("t1", 100), term("t2", recorder.now_ms(), parent="t1")),
                event("finished", "t2", {"exit_code": 0, "finished_ms": 5, "reason": "exited"}),
            ])
            self.assertEqual(p.returncode, 0, p.stderr)
            path = os.path.join(tmp, "history.json")
            self.assertLess(os.path.getsize(path), 900000)
            with open(path) as f:
                d = json.load(f)
        self.assertEqual(d["version"], 1)
        recs = [r for r in d["records"]]
        self.assertEqual(len(recs), 2)
        self.assertEqual([set(r) for r in recs], [set(recorder.KEYS)] * 2)
        child = [r for r in recs if r["address"] == "t2"][0]
        self.assertEqual(child["state"], "finished")
        self.assertEqual(child["parent_id"], "t1@100")

    def test_15_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(os.path.join(tmp, "history.lock"), os.O_RDWR | os.O_CREAT)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                p = self.run_replay(tmp, [snapshot(term("t1", 100))])
            finally:
                os.close(fd)
            self.assertEqual(p.returncode, 1)
            self.assertIn("another recorder holds", p.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "history.json")))


if __name__ == "__main__":
    unittest.main()
