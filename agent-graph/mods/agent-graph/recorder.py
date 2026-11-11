"""Follow herdr-core's event stream and keep history.json (see FORMAT.md)."""

import argparse
import fcntl
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import quote

DEFAULT_OUT = "~/.local/share/herdr-agent-graph/history.json"
VERSION = 1
RETAIN_MS = 14 * 86400000
MAX_RECORDS = 1500
SIZE_LIMIT = 900000
FLUSH_DELAY = 1.0
LISTING_EVERY = 15.0
MAINTENANCE_EVERY = 600.0
RECONNECT_DELAY = 2.0

KEYS = (
    "id", "address", "parent", "parent_id", "name", "agent", "command", "cwd",
    "where", "state", "status", "created_ms", "finished_ms", "exit_code",
    "reason", "removed_ms",
)


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, file=sys.stderr, flush=True)


def now_ms():
    return int(time.time() * 1000)


def norm_status(v):
    if isinstance(v, dict):
        v = v.get("state")
    if isinstance(v, str) and v:
        return v
    return None


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    if len(s) > n:
        return s[:n - 1] + "…"
    return s


def command_of(argv):
    if isinstance(argv, list) and argv:
        return clip(" ".join(str(a) for a in argv), 200)
    return None


def machine_of(address):
    if "/" in address:
        return address.split("/", 1)[0]
    return None


def qualify_parent(child_address, parent):
    if not isinstance(parent, str):
        return None
    prefix = machine_of(child_address)
    if prefix and "/" not in parent:
        return f"{prefix}/{parent}"
    return parent


# What encodeURIComponent leaves as it is, besides what quote() always keeps.
URI_COMPONENT_SAFE = "!'()*"


def sub_address(address, record_id):
    """A reported sub-agent's address: its terminal's, `#`, then the record id percent-encoded the
    way JavaScript's encodeURIComponent does it, because main.js builds the same address for the
    live sub-agent and matches it to this record by address."""
    return f"{address}#{quote(record_id, safe=URI_COMPONENT_SAFE)}"


def is_sub(rec):
    parent = rec.get("parent")
    return isinstance(parent, str) and rec["address"].startswith(parent + "#")


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def dump(d):
    s = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    return s.encode("utf-8", errors="replace")


class Recorder:
    def __init__(self):
        self.records = {}
        self.current = {}
        self.dirty = False
        self.changes = 0  # bumped with every change; dirty is cleared by flush

    def touch(self):
        self.dirty = True
        self.changes += 1

    def set(self, rec, key, value):
        if rec.get(key) != value:
            rec[key] = value
            self.touch()

    # -- loading ---------------------------------------------------------

    def preserve(self, path, why):
        """Move a history we can't use aside, so the next write can't destroy it.

        Raises OSError when it can't: the caller must then abort rather than start empty and
        overwrite the original. The name is reserved with O_EXCL so a second attempt in the same
        second (or a restart) can't clobber an earlier backup.
        """
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        for i in range(1, 1001):
            aside = f"{path}.bad-{stamp}" if i == 1 else f"{path}.bad-{stamp}.{i}"
            try:
                fd = os.open(aside, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                continue
            os.close(fd)
            try:
                os.replace(path, aside)
            except OSError:
                try:
                    os.unlink(aside)
                except OSError:
                    pass
                raise
            log(f"kept {path} as {aside} ({why})")
            return
        raise OSError(f"no free name to set {path} aside ({why})")

    def load(self, path):
        try:
            with open(path, "rb") as f:
                data = json.loads(f.read().decode("utf-8", errors="replace"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            # Unsure of the file: keep it aside (may raise OSError and abort startup).
            self.preserve(path, f"cannot read it: {e}")
            return
        if (not isinstance(data, dict) or data.get("version") != VERSION
                or not isinstance(data.get("records"), list)):
            self.preserve(path, f"not a version {VERSION} history")
            return
        for r in data["records"]:
            if (not isinstance(r, dict) or not isinstance(r.get("address"), str)
                    or not is_int(r.get("created_ms"))
                    or r.get("id") != f"{r['address']}@{r['created_ms']}"):
                log(f"skipping bad history record: {str(r)[:80]}")
                continue
            rec = {k: r.get(k) for k in KEYS}
            rec["status"] = norm_status(rec["status"])
            self.records[rec["id"]] = rec
        for rec in self.records.values():
            # A finished sub-agent is gone from the core even though nothing removed it.
            if rec["removed_ms"] is not None or (is_sub(rec) and rec["state"] == "finished"):
                continue
            cur = self.records.get(self.current.get(rec["address"]))
            if cur is None or rec["created_ms"] > cur["created_ms"]:
                self.current[rec["address"]] = rec["id"]

    # -- event handling --------------------------------------------------

    def remove(self, address, now):
        rid = self.current.pop(address, None)
        if rid is None:
            return
        self.set(self.records[rid], "removed_ms", now)
        self.touch()  # the record set changed (current shrank)
        for child in self.live_subs(address):
            self.finish_sub(child, now)

    # -- reported sub-agents (hc's `records`, see FORMAT.md) ---------------

    def live_subs(self, address):
        prefix = address + "#"
        return [self.records[rid] for a, rid in self.current.items() if a.startswith(prefix)]

    def finish_sub(self, rec, now):
        self.set(rec, "state", "finished")
        self.set(rec, "finished_ms", now)
        self.current.pop(rec["address"], None)
        self.touch()

    def sync_subs(self, address, records, now):
        """One record per sub-agent the terminal reports: an id that appears starts one, an id that
        goes (or the terminal finishing) finishes it."""
        rid = self.current.get(address)
        if rid is None:
            return
        parent = self.records[rid]
        reported = {}
        if parent["state"] == "live" and isinstance(records, dict):
            for record_id, r in records.items():
                if isinstance(record_id, str) and record_id and isinstance(r, dict) and norm_status(r):
                    reported[sub_address(address, record_id)] = r
        for child in self.live_subs(address):
            if child["address"] not in reported:
                self.finish_sub(child, now)
        for child_address, r in reported.items():
            rec = self.records.get(self.current.get(child_address))
            if rec is None:
                rec = {k: None for k in KEYS}
                rec.update(id=f"{child_address}@{now}", address=child_address, parent=address,
                           created_ms=now, state="live")
                self.records[rec["id"]] = rec
                self.current[child_address] = rec["id"]
                self.touch()
            self.set(rec, "name", clip(r.get("title"), 120))
            self.set(rec, "status", norm_status(r))
            for k in ("agent", "cwd", "where"):
                self.set(rec, k, parent[k])

    def upsert(self, r, now):
        if not isinstance(r, dict):
            return
        address, created = r.get("address"), r.get("created_ms")
        if not isinstance(address, str) or not is_int(created):
            return
        rid = f"{address}@{created}"
        old = self.current.get(address)
        if old is not None and old != rid:
            self.remove(address, now)
        rec = self.records.get(rid)
        if rec is None:
            rec = {k: None for k in KEYS}
            rec["id"] = rid
            self.records[rid] = rec
            self.touch()
        labels = r.get("labels")
        where = labels.get("where") if isinstance(labels, dict) else None
        state = r.get("state")
        fields = {
            "address": address,
            "name": clip(r.get("name"), 120),
            "command": command_of(r.get("argv")),
            "cwd": clip(r.get("cwd"), 300),
            "where": clip(where, 160),
            "parent": qualify_parent(address, r.get("parent")),
            "state": state if isinstance(state, str) else None,
            "status": norm_status(r.get("status")),
            "created_ms": created,
            "finished_ms": r.get("finished_ms"),
            "exit_code": r.get("exit_code"),
            "reason": r.get("reason"),
            "removed_ms": None,
        }
        for k, v in fields.items():
            self.set(rec, k, v)
        if self.current.get(address) != rid:
            self.current[address] = rid
            self.touch()
        if "records" in r:
            self.sync_subs(address, r["records"], now)

    def handle_snapshot(self, terminals, now):
        seen = set()
        for t in terminals:
            self.upsert(t, now)
            if isinstance(t, dict) and isinstance(t.get("address"), str):
                seen.add(t["address"])
        for address in list(self.current):
            # Sub-agents are never listed as terminals: they follow their terminal's records.
            rid = self.current.get(address)
            if rid is None or is_sub(self.records[rid]):
                continue
            if machine_of(address) is None and address not in seen:
                self.remove(address, now)

    def handle_event(self, params, now):
        etype, address = params.get("type"), params.get("terminal")
        data = params.get("data")
        if not isinstance(data, dict):
            data = {}
        if not isinstance(address, str):
            return
        if etype == "created":
            self.upsert(data, now)
            return
        rid = self.current.get(address)
        if rid is None:
            return
        rec = self.records[rid]
        if etype == "finished":
            self.set(rec, "exit_code", data.get("exit_code"))
            self.set(rec, "finished_ms", data.get("finished_ms"))
            self.set(rec, "reason", data.get("reason"))
            self.set(rec, "state", "finished")
            self.sync_subs(address, None, now)
        elif etype == "labels":
            labels = data.get("labels")
            if isinstance(labels, dict):
                self.set(rec, "where", clip(labels.get("where"), 160))
        elif etype == "status":
            self.set(rec, "status", norm_status(data.get("status")))
            if "records" in data:
                self.sync_subs(address, data["records"], now)
        elif etype == "removed":
            self.remove(address, now)

    def handle_line(self, line, now):
        """Apply one stream line. Returns "snapshot" for a snapshot line."""
        try:
            obj = json.loads(line)
        except ValueError:
            return None
        if not isinstance(obj, dict):
            return None
        try:
            if isinstance(obj.get("terminals"), list):
                self.handle_snapshot(obj["terminals"], now)
                return "snapshot"
            if obj.get("method") == "event" and isinstance(obj.get("params"), dict):
                self.handle_event(obj["params"], now)
            elif isinstance(obj.get("removed"), str):
                self.remove(obj["removed"], now)
        except Exception as e:  # keep following the stream whatever one line holds
            log(f"error handling line {line[:80]!r}: {e!r}")
        return None

    def apply_listing(self, listing, now):
        if not isinstance(listing, dict) or not isinstance(listing.get("terminals"), list):
            return
        connected = {None}
        machines = listing.get("machines")
        for m in machines if isinstance(machines, list) else []:
            if isinstance(m, dict) and m.get("state") == "connected" and isinstance(m.get("name"), str):
                connected.add(m["name"])
        listed = set()
        for t in listing["terminals"]:
            if not isinstance(t, dict) or not isinstance(t.get("address"), str):
                continue
            address = t["address"]
            listed.add(address)
            rid = self.current.get(address)
            if rid is None:
                continue
            rec = self.records[rid]
            agent = t.get("agent")
            agent = agent if isinstance(agent, str) else None
            if rec["agent"] != agent:
                self.set(rec, "agent", agent)
                # Only the listing names the agent, so sub-agents seen before it, finished ones
                # too, take it now.
                for child in self.records.values():
                    if child["parent"] == address and child["created_ms"] >= rec["created_ms"] and is_sub(child):
                        self.set(child, "agent", agent)
            if "status" in t:
                self.set(rec, "status", norm_status(t["status"]))
            if isinstance(t.get("state"), str):
                self.set(rec, "state", t["state"])
        for address in list(self.current):
            # The listing has no sub-agents: they follow their terminal's records.
            rid = self.current.get(address)
            if rid is None or is_sub(self.records[rid]):
                continue
            if address not in listed and machine_of(address) in connected:
                self.remove(address, now)

    # -- prune, resolve, serialize ---------------------------------------

    def prune(self, now):
        keep = set(self.current.values())
        cutoff = now - RETAIN_MS
        old = []
        for rid, rec in self.records.items():
            if rid in keep:
                continue
            latest = max(x for x in (rec["finished_ms"], rec["removed_ms"], rec["created_ms"])
                         if x is not None)
            if latest >= cutoff:
                keep.add(rid)
            else:
                old.append(rid)
        extra = []
        if len(keep) > MAX_RECORDS:
            current = set(self.current.values())
            others = sorted((i for i in keep if i not in current),
                            key=lambda i: (self.records[i]["created_ms"], i))
            extra = others[:min(len(others), len(keep) - MAX_RECORDS)]
        for rid in old + extra:
            del self.records[rid]
        if old or extra:
            self.touch()

    def build(self, now):
        by_address = {}
        for rec in self.records.values():
            by_address.setdefault(rec["address"], []).append(rec)
        for rec in self.records.values():
            best = None
            for p in by_address.get(rec["parent"], ()):
                if p["created_ms"] <= rec["created_ms"] and (
                        best is None or p["created_ms"] > best["created_ms"]):
                    best = p
            rec["parent_id"] = best["id"] if best else None
        ordered = sorted(self.records.values(), key=lambda r: (r["created_ms"], r["id"]))
        return {
            "version": VERSION,
            "updated_ms": now,
            "records": [{k: r[k] for k in KEYS} for r in ordered],
        }

    def snapshot_dict(self, now):
        self.prune(now)
        while True:
            d = self.build(now)
            if len(dump(d)) < SIZE_LIMIT:
                return d
            current = set(self.current.values())
            others = [r for i, r in self.records.items() if i not in current]
            if not others:
                # Nothing but current records left: an over-limit file can't be read back, so
                # the oldest current ones go too. Their terminals still show from the core.
                others = list(self.records.values())
                if not others:
                    return d
                log(f"history over {SIZE_LIMIT} bytes with only current records; dropping the oldest")
            others.sort(key=lambda r: (r["created_ms"], r["id"]))
            for r in others[:max(1, len(others) // 10)]:
                del self.records[r["id"]]
                if self.current.get(r["address"]) == r["id"]:
                    del self.current[r["address"]]
            self.touch()

    def flush(self, path, now):
        if not self.dirty:
            return
        data = dump(self.snapshot_dict(now))
        folder = os.path.dirname(path)
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, f"history.json.{os.getpid()}.tmp")
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.dirty = False


# -- live loop -----------------------------------------------------------


class Stop:
    requested = False


def request_stop(signum, frame):
    Stop.requested = True


def reap(proc):
    if proc is None:
        return
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    if proc.stdout:
        proc.stdout.close()


def safe_flush(rec, path):
    try:
        rec.flush(path, now_ms())
        return True
    except OSError as e:
        log(f"cannot write {path}: {e}")
        return False


def run_listing(hc):
    try:
        p = subprocess.run([hc, "ls", "--all", "--json"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"hc ls failed: {e}")
        return None
    if p.returncode != 0:
        log(f"hc ls exited {p.returncode}")
        return None
    try:
        return json.loads(p.stdout.decode("utf-8", errors="replace"))
    except ValueError as e:
        log(f"hc ls gave bad JSON: {e}")
        return None


def follow(rec, out, hc):
    """Follow one event stream until EOF or a stop request."""
    proc = subprocess.Popen([hc, "events", "--json"], stdout=subprocess.PIPE,
                            stderr=None, bufsize=0)
    sel = selectors.DefaultSelector()
    fd = proc.stdout.fileno()
    sel.register(fd, selectors.EVENT_READ)
    buf = b""
    flush_at = None
    listing_due = False  # a snapshot arrived and wants a listing right away
    last_listing, listing_changes = None, rec.changes
    maintenance_at = time.monotonic() + MAINTENANCE_EVERY
    try:
        while not Stop.requested:
            now = time.monotonic()
            deadlines = [maintenance_at]
            if flush_at is not None:
                deadlines.append(flush_at)
            if rec.changes != listing_changes:
                deadlines.append(last_listing + LISTING_EVERY if last_listing else now)
            if listing_due:
                deadlines.append(now)
            ready = sel.select(max(0.0, min(1.0, min(deadlines) - now)))
            if Stop.requested:
                break
            if ready:
                chunk = os.read(fd, 65536)
                if not chunk:
                    log("event stream ended")
                    break
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for raw in lines:
                    kind = rec.handle_line(raw.decode("utf-8", errors="replace"), now_ms())
                    if kind == "snapshot":
                        listing_due = True
            now = time.monotonic()
            if rec.dirty and flush_at is None:
                flush_at = now + FLUSH_DELAY
            if listing_due or (rec.changes != listing_changes
                               and (last_listing is None or now >= last_listing + LISTING_EVERY)):
                listing = run_listing(hc)
                if listing is not None:
                    rec.apply_listing(listing, now_ms())
                listing_due = False
                last_listing, listing_changes = time.monotonic(), rec.changes
                if rec.dirty and flush_at is None:
                    flush_at = last_listing + FLUSH_DELAY
            if now >= maintenance_at:
                rec.snapshot_dict(now_ms())
                maintenance_at = now + MAINTENANCE_EVERY
                flush_at = now
            if flush_at is not None and time.monotonic() >= flush_at:
                flush_at = None if safe_flush(rec, out) else time.monotonic() + 5.0
    finally:
        sel.close()
        safe_flush(rec, out)
        reap(proc)


def live(rec, out):
    hc = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    log(f"recorder started, following {hc} events, writing {out}")
    while not Stop.requested:
        try:
            follow(rec, out, hc)
        except OSError as e:
            log(f"cannot follow events: {e}")
            safe_flush(rec, out)
        if Stop.requested:
            break
        log(f"reconnecting in {RECONNECT_DELAY:g}s")
        deadline = time.monotonic() + RECONNECT_DELAY
        while not Stop.requested and time.monotonic() < deadline:
            time.sleep(0.2)
    log("recorder stopped")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Record the herdr terminal graph to history.json")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--replay", metavar="FILE")
    args = ap.parse_args(argv)
    out = os.path.abspath(os.path.expanduser(args.out))
    folder = os.path.dirname(out)
    os.makedirs(folder, exist_ok=True)
    lock_path = os.path.join(folder, "history.lock")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(f"another recorder holds {lock_path}", file=sys.stderr)
        return 1
    rec = Recorder()
    try:
        rec.load(out)
    except OSError as e:
        log(f"refusing to start: {e}")
        return 1
    if args.replay:
        with open(args.replay, encoding="utf-8", errors="replace") as f:
            for line in f:
                rec.handle_line(line, now_ms())
        rec.flush(out, now_ms())
        return 0
    return live(rec, out)


if __name__ == "__main__":
    sys.exit(main())
