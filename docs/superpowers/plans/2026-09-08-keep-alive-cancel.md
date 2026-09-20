# Keep-Alive Cancel on Stop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A genuine (closing) stop while in VOD mode terminates the preserved live session and stops the keep-alive `Cancel`-with-empty-streams loop — without disturbing the deliberate keep-alive preservation used for VOD failover.

**Architecture:** Fix `SLDPManager.stop()` (`src/sldp/manager.js`). On a **closing** stop (`closeConnection === true`), always route through `_sendRequest` so the keep-alive timer is truly cancelled and a `close` command is sent even when no streams are requested. Non-closing (`keepConnection`) stops keep the session and its keep-alive loop intact, as required for statistics. `NimioLive.destroy()` additionally force-cancels keep-alive (always a full teardown). Also rename the misnamed `_onTransportError()` callback to `_onInvalidStatus()`.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom, fake timers.

## Global Constraints

- Changes confined to `src/sldp/manager.js`, `src/nimio-live.js`, `src/nimio-transport.js`, and a new test file `tests/sldp-manager.test.js`.
- **Statistics/session-continuity constraint (see spec):** keep-alive preserves the server-side viewer session. It must be torn down **only** on a closing stop (user stop / `destroy()`), **never** on the preserve paths (`keepConnection: true`: VOD detach and `_onTransportError()` failover). Do **not** add an unconditional keep-alive cancel to `NimioLive.stop()`.
- Preserve the LIVE→VOD keep-alive behavior used by `NimioLive.detach()`: `stop({ closeConnection: false })` must not close the socket, and a following `keepAliveConnection()` must still re-arm the loop.
- No new dependencies. Match existing code style in `src/sldp/manager.js`. Keep-alive interval stays 10000 ms. SLDP wire protocol unchanged.

## Background: the wire semantics (verified)

`src/transport/web-socket.js` handles the `stop` command as:

```js
} else if (type === "stop") {
  if (e.data.sns && e.data.sns.length >= 0) {           // always true for an array
    socket.send(JSON.stringify({ command: "Cancel", streams: e.data.sns }));
  }
  if (e.data.close) {
    socket.close();
    socket = undefined;
    self.postMessage({ aux: true, connected: false });
  }
}
```

So `stop` with `sns: []` sends `Cancel` with an empty list (this **is** the
keep-alive message), and `close: true` closes the socket. Sending
`{ sns: [], close: true }` therefore cancels everything and closes the
connection — the correct teardown for a closing stop.

## Why a manager-only fix is correct (not `NimioLive.stop()`)

Keep-alive is armed only in `NimioLive.detach()`, right after
`this.stop({ keepConnection: true })` sets the state to `STOPPED`. So whenever
keep-alive is on, `NimioLive.stop()`'s `isStopped` is `true`, and the guard

```js
if (!isStopped || (closeConnection && this._transport.connected)) {
  this._sldpManager.stop({ closeConnection });
}
```

calls the manager **only** on a closing stop while connected. That is exactly
what we want:

- **Preserve paths** (`keepConnection: true` — VOD detach, `_onTransportError`
  failover) skip the manager, so keep-alive keeps running and the server session
  survives for a later return to live. **Intended — must not change.**
- **Closing stops** (user stop / `destroy()`) reach the manager while the socket
  is still connected (keep-alive held it open), so the fix below runs.

## Current code (for reference)

```js
stop(opts = {}) {
  const sns = this.resetRequestedStreams();
  if (sns.length === 0) return;
  this._sendRequest("stop", { sns, close: !!opts.closeConnection });
}

keepAliveConnection() {
  if (this._keepAliveTimer) return;
  this._keepAliveTimer = setTimeout(() => {
    if (!this._transport.connected) this._keepAliveTimer = undefined;
    if (!this._keepAliveTimer) return;
    this._logger.debug(`send keep alive request`);
    this._sendRequest("stop", { sns: [] });
    this.keepAliveConnection();
  }, 10000);
}

_sendRequest(command, data) {
  this._keepAliveTimer = undefined;
  this._transport.send(command, data);
}
```

## Target code (for reference)

```js
// src/sldp/manager.js
stop(opts = {}) {
  const sns = this.resetRequestedStreams();
  const close = !!opts.closeConnection;
  if (sns.length === 0 && !close) return;   // nothing to cancel, nothing to close
  this._sendRequest("stop", { sns, close });
}

cancelKeepAlive() {                          // public: also called by NimioLive.destroy()
  if (this._keepAliveTimer) {
    clearTimeout(this._keepAliveTimer);
    this._keepAliveTimer = undefined;
  }
}

_sendRequest(command, data) {
  this.cancelKeepAlive();
  this._transport.send(command, data);
}
```

```js
// src/nimio-live.js
destroy() {
  this.stop();
  this._sldpManager.cancelKeepAlive();       // full teardown: kill keep-alive unconditionally
  this._removeUIEventHandlers();
}
```

```js
// src/nimio-transport.js — rename only; body unchanged
_initTransport(instName, url) {
  // ...
  this._transport.callbacks = {
    // ...
    error: this._onInvalidStatus.bind(this),   // was: this._onTransportError.bind(this)
  };
  // ...
},

_onInvalidStatus() {                            // was: _onTransportError()
  this.stop({ keepConnection: true });
  this._eventBus.emit("aux:playback-error", { type: "NO_SRC", mode: MODE.LIVE });
},
```

`keepAliveConnection()` is unchanged. Every real request (including the closing
`stop`) flows through `_sendRequest`, which now truly `clearTimeout`s the
pending keep-alive instead of only dropping the reference. The only stop that
does **not** cancel keep-alive is the empty-streams, non-closing early return —
which is correct, because that is a preserve-style stop that must leave the loop
alone. `NimioLive.destroy()` force-cancels as a safety net (covers the
`connected === false` case where the manager would be skipped); the transport
callback key stays `"error"`, only the JS method name changes.

## File Structure

- **Modify:** `src/sldp/manager.js`
  - Add `cancelKeepAlive()` (public) — `clearTimeout` + forget the timer.
  - `_sendRequest()` — call `cancelKeepAlive()` instead of the bare
    `this._keepAliveTimer = undefined`.
  - `stop()` — only early-return when there is nothing to cancel _and_ no close
    requested; otherwise send `{ sns, close }` (so a closing stop with no
    streams still cancels keep-alive and closes the socket).
- **Modify:** `src/nimio-live.js`
  - `destroy()` — call `this._sldpManager.cancelKeepAlive()` after `this.stop()`.
- **Modify:** `src/nimio-transport.js`
  - Rename `_onTransportError()` → `_onInvalidStatus()` and update the
    `error:` callback binding in `_initTransport()`.
- **Create:** `tests/sldp-manager.test.js`
  - Unit tests with a mock transport and Vitest fake timers.

---

### Task 1: A closing stop cancels keep-alive and closes, even with no streams

**Files:**

- Create: `tests/sldp-manager.test.js`
- Modify: `src/sldp/manager.js`

**Interfaces:**

- Consumes: `SLDPManager` constructor `new SLDPManager(instName)` and `init(transport, config)`; a mock transport exposing `connected`, `send(cmd, data)`, `setCallback(type, cb)`, `runCallback(type, data)`.
- Produces: `SLDPManager.prototype.cancelKeepAlive()` (public); `stop({ closeConnection })` that always routes a closing stop through `_sendRequest`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/sldp-manager.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SLDPManager } from "@/sldp/manager";

function makeTransport() {
  return {
    connected: true,
    sent: [],
    _callbacks: {},
    send(cmd, data) {
      this.sent.push({ cmd, data });
    },
    setCallback(type, cb) {
      this._callbacks[type] = cb;
    },
    runCallback(type, data) {
      if (this._callbacks[type]) this._callbacks[type](data);
    },
  };
}

const isKeepAlive = (m) =>
  m.cmd === "stop" && Array.isArray(m.data.sns) && m.data.sns.length === 0;

describe("SLDPManager closing stop", () => {
  let mgr;
  let transport;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mgr = new SLDPManager("ka-test");
    transport = makeTransport();
    mgr.init(transport, {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops sending keep-alive after a closing stop with no requested streams", () => {
    // VOD mode: no requested streams, keep-alive loop armed.
    mgr.keepAliveConnection();
    vi.advanceTimersByTime(10000);
    expect(transport.sent.filter(isKeepAlive).length).toBeGreaterThan(0);

    mgr.stop({ closeConnection: true });
    const countAtStop = transport.sent.length;

    vi.advanceTimersByTime(60000);
    const keepAlivesAfterStop = transport.sent
      .slice(countAtStop)
      .filter(isKeepAlive).length;
    expect(keepAlivesAfterStop).toBe(0);
  });

  it("sends a close command on a closing stop even with no requested streams", () => {
    mgr.keepAliveConnection();
    vi.advanceTimersByTime(10000);
    transport.sent.length = 0;

    mgr.stop({ closeConnection: true });

    const closeMsgs = transport.sent.filter(
      (m) => m.cmd === "stop" && m.data.close === true,
    );
    expect(closeMsgs).toHaveLength(1);
    expect(closeMsgs[0].data.sns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sldp-manager.test.js`
Expected: FAIL — keep-alive keeps arriving after stop, and no `close` command is sent (the current `stop()` early-returns on empty `sns`).

- [ ] **Step 3: Write minimal implementation**

In `src/sldp/manager.js`, add `cancelKeepAlive()` (public) next to `keepAliveConnection()`:

```js
cancelKeepAlive() {
  if (this._keepAliveTimer) {
    clearTimeout(this._keepAliveTimer);
    this._keepAliveTimer = undefined;
  }
}
```

Change `_sendRequest()` to use it:

```js
_sendRequest(command, data) {
  this.cancelKeepAlive();
  this._transport.send(command, data);
}
```

Change `stop()` so a closing stop is never skipped:

```js
stop(opts = {}) {
  const sns = this.resetRequestedStreams();
  const close = !!opts.closeConnection;
  if (sns.length === 0 && !close) return;
  this._sendRequest("stop", { sns, close });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sldp-manager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/sldp-manager.test.js src/sldp/manager.js
git commit -m "Cancel keep-alive and close SLDP connection on closing stop"
```

---

### Task 2: Preserve-path and existing-behavior regression guards

Locks in the behavior the statistics constraint depends on: preserve-style stops
must leave keep-alive alone, and stops with streams must still cancel + close.

**Files:**

- Modify: `tests/sldp-manager.test.js`

**Interfaces:**

- Consumes: mock transport and `isKeepAlive` helper from Task 1.
- Produces: no production changes.

- [ ] **Step 1: Write the guard tests**

Add inside the existing `describe` block in `tests/sldp-manager.test.js`:

```js
it("detach pattern keeps the connection alive and re-arm still works", () => {
  // NimioLive.detach(): stop without closing, then re-arm keep-alive.
  mgr._reqStreams = { 1: 0 }; // a live stream was requested
  mgr.stop({ closeConnection: false });

  const stopMsg = transport.sent.find((m) => m.cmd === "stop");
  expect(stopMsg.data.close).toBe(false); // socket NOT closed

  mgr.keepAliveConnection();
  transport.sent.length = 0;
  vi.advanceTimersByTime(10000);
  expect(transport.sent.filter(isKeepAlive).length).toBe(1); // loop alive
});

it("non-closing stop with no streams does not send anything", () => {
  mgr.keepAliveConnection();
  vi.advanceTimersByTime(10000);
  transport.sent.length = 0;

  mgr.stop({ closeConnection: false }); // preserve-style stop, no streams

  const stops = transport.sent.filter((m) => m.cmd === "stop");
  expect(stops).toHaveLength(0); // nothing to cancel, nothing to close
});

it("closing stop with requested streams cancels those streams and closes", () => {
  mgr._reqStreams = { 1: 0, 2: 1 };

  mgr.stop({ closeConnection: true });

  const stopMsg = transport.sent.find(
    (m) => m.cmd === "stop" && m.data.close === true,
  );
  expect(stopMsg).toBeTruthy();
  expect(stopMsg.data.sns.sort()).toEqual(["1", "2"]);
});
```

- [ ] **Step 2: Run the file**

Run: `npx vitest run tests/sldp-manager.test.js`
Expected: PASS — behavior preserved by the Task 1 implementation. If any fail,
the implementation regressed a preserved behavior; fix before continuing.

> Note on `_reqStreams`: tests seed it directly (decided) — this mirrors what
> `requestStream()` / `_processCurrentStreams()` populate at runtime and keeps
> the tests focused on the stop/keep-alive behavior.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS — no other tests broken.

- [ ] **Step 4: Commit**

```bash
git add tests/sldp-manager.test.js
git commit -m "Add regression tests for SLDP preserve-path keep-alive"
```

---

### Task 3: `NimioLive.destroy()` force-cancels keep-alive

Belt-and-suspenders for the one closing path that can skip `SLDPManager.stop()`:
`destroy()` while the socket already reported `connected === false`. `destroy()`
is always a full teardown, so cancelling keep-alive there is safe and never
touches the failover path.

**Files:**

- Modify: `src/nimio-live.js` (`destroy()`)
- Modify: `tests/sldp-manager.test.js` (a manager-level test for the contract)

**Interfaces:**

- Consumes: `SLDPManager.prototype.cancelKeepAlive()` from Task 1.
- Produces: `NimioLive.destroy()` calls `this._sldpManager.cancelKeepAlive()`.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe` block in `tests/sldp-manager.test.js`. This
asserts the contract `destroy()` relies on: `cancelKeepAlive()` stops the loop
even when the transport is disconnected (so `stop()` would have been skipped).

```js
it("cancelKeepAlive() stops the loop even when the transport is disconnected", () => {
  mgr.keepAliveConnection();
  vi.advanceTimersByTime(10000);
  expect(transport.sent.filter(isKeepAlive).length).toBeGreaterThan(0);

  transport.connected = false; // socket already dropped
  transport.sent.length = 0;
  mgr.cancelKeepAlive();

  vi.advanceTimersByTime(60000);
  expect(transport.sent).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it passes at the manager level**

Run: `npx vitest run tests/sldp-manager.test.js -t "disconnected"`
Expected: PASS (public method exists from Task 1). This locks the contract
before wiring it into `NimioLive`.

- [ ] **Step 3: Wire it into `NimioLive.destroy()`**

In `src/nimio-live.js`:

```js
destroy() {
  this.stop();
  this._sldpManager.cancelKeepAlive();
  this._removeUIEventHandlers();
}
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nimio-live.js tests/sldp-manager.test.js
git commit -m "Force keep-alive teardown in NimioLive.destroy()"
```

---

### Task 4: Rename `_onTransportError()` → `_onInvalidStatus()`

Pure rename to fix a misnomer: the callback fires on an invalid/empty SLDP
status (no playable source), not a transport failure. No behavior change.

**Files:**

- Modify: `src/nimio-transport.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `NimioTransport._onInvalidStatus()` (replaces `_onTransportError()`).

- [ ] **Step 1: Confirm the only references**

Run: `grep -rn "_onTransportError" src/`
Expected: exactly two hits, both in `src/nimio-transport.js` — the method
definition and the `error:` binding in `_initTransport()`.

- [ ] **Step 2: Rename**

In `src/nimio-transport.js`:

- Rename the method `_onTransportError()` → `_onInvalidStatus()` (body unchanged).
- Update the binding: `error: this._onInvalidStatus.bind(this),`

Leave the transport callback key `"error"` and the worker message type
(`src/sldp/agent.js` posts `{ type: "error" }`) unchanged.

- [ ] **Step 3: Verify no stale references and suite is green**

Run: `grep -rn "_onTransportError" src/ ; npx vitest run`
Expected: no matches for `_onTransportError`; full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add src/nimio-transport.js
git commit -m "Rename _onTransportError to _onInvalidStatus"
```

---

## Self-review

- **Spec coverage:**
  - Desired behavior 1 (closing stop cancels keep-alive) → Task 1.
  - Desired behavior 2 (close on empty streams for a closing stop) → Task 1.
  - Desired behavior 3 (preserve paths keep keep-alive; no `NimioLive.stop()`
    teardown) → satisfied structurally (manager not called on preserve paths) and
    guarded by Task 2 (detach re-arm; non-closing empty stop sends nothing).
  - Desired behavior 4 (stop-with-streams still cancels + closes) → Task 2.
  - `destroy()` force-teardown (covers `connected === false`) → Task 3.
  - Naming fix (`_onTransportError` → `_onInvalidStatus`) → Task 4.
- **Placeholder scan:** none — all steps carry concrete code and commands.
- **Type consistency:** `cancelKeepAlive()`, `stop(opts)`, `_sendRequest(command, data)`, and the mock transport shape are used identically across tasks.

## Resolved decisions

- **Callback name:** `_onInvalidStatus()` (accepted). Matches the existing
  "Invalid or empty status received" log and covers both malformed and empty
  status. Rejected: `_onVoidStatus` (implies empty-only) and `_onBadStatus`
  (vague / HTTP-code connotation).
- **`destroy()` teardown:** `NimioLive.destroy()` force-cancels keep-alive
  (Task 3).
- **Test setup:** tests seed the private `_reqStreams` field directly (accepted),
  rather than driving it through the public `requestStream()` path.

## Open questions for discussion

None — all decisions resolved. Ready to execute.
