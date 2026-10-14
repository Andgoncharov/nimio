# Worker Termination on Destroy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Nimio.destroy()` leaves no Worker thread behind: the transport worker is asked to close and hard-terminated as a fallback, and decoder workers always acknowledge `shutdown` so the flow can terminate them, with a hard-terminate fallback when they do not.

**Architecture:** A new `terminate` command in the transport worker runs upstream's `closeSocket()` and `self.close()`; `TransportAdapter.destroy()` posts it after the closing stop and schedules `worker.terminate()` 1000 ms later; `NimioLive.destroy()` calls it last. Decoder workers post `shutdownComplete` and close even when no decoder was created; `DecoderFlow.destroy()` always arms a 1000 ms identity-keyed hard terminate.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom, fake timers, fake `Worker`/`WebSocket` globals.

**Spec:** `docs/superpowers/specs/2026-10-14-worker-termination-design.md`

## Global Constraints

- Branch `fix/worker-termination` from upstream `main` (`f2d6eea`). No rebase onto anything else.
- Fallback delays are exactly `1000` ms: `TERMINATE_FALLBACK_MS` in `src/transport/adapter.js`, `SHUTDOWN_FALLBACK_MS` in `src/media/decoders/flow.js`.
- No change to `Nimio.destroy()`, the service registry, or the decoder flow's late-message handling (second PR).
- Project rule: **one code commit at the end** (Task 6). Earlier tasks only `git add`. Spec/plan commits stay local and are not part of the PR.
- `npx prettier --check src tests` and `npx vitest run` must be clean before the commit.
- Existing worker tests drive the real worker modules with `self.onmessage` / `globalThis.dispatchEvent`; follow the conventions of the file you extend.

## Review Focus

- A `shutdownComplete` that arrives after the fallback already terminated the worker: must not throw and must not terminate twice → test in Task 5.
- `terminate` arriving after a closing stop already ran `closeSocket()` (the normal teardown order): must close the scope without touching a socket → test in Task 1.
- `TransportAdapter.destroy()` called twice (facade and engine both tearing down): one `terminate` post, one hard terminate → test in Task 2.
- A worker `message` delivered after `destroy()` (late `status` or `videoSetup`): must reach no callback → `onmessage` nulled, test in Task 2.
- `DecoderFlow.destroy()` on a flow whose worker is already gone: no timer armed, no throw → test in Task 5.

---

### Task 1: Transport worker `terminate` command

**Files:**

- Modify: `src/transport/web-socket.js` (insert before the `!socket && ["play","stop"]` guard, currently line 112)
- Test: `tests/transport-web-socket.test.js` (upstream's file; add cases inside the existing `describe`)

**Interfaces:**

- Consumes: module-level `socket`, `closeSocket()` (upstream helper: clears `onopen`/`onclose`/`onmessage`, closes, forgets, posts `{ aux: true, connected: false }`).
- Produces: worker message `{ type: "terminate" }` → `closeSocket()` if a socket exists, then `self.close()`. Task 2 posts this message.

- [ ] **Step 1: Write the failing tests**

Add at the end of the `describe("WebSocket transport worker", ...)` block in `tests/transport-web-socket.test.js`. The file already stubs `WebSocket`, mocks the protocol agent, sets `self.postMessage = vi.fn()` and imports the worker once in `beforeAll`; `start(url)` and `send(data)` are its helpers.

```js
describe("terminate command", () => {
  let closeScope;

  beforeEach(() => {
    closeScope = vi.spyOn(self, "close").mockImplementation(() => {});
    self.postMessage.mockClear();
  });

  afterEach(() => {
    closeScope.mockRestore();
  });

  it("closes an open socket silently and closes the worker scope", () => {
    const socket = start("wss://host/app/stream");
    socket.readyState = ws.FakeWebSocket.OPEN;

    send({ type: "terminate" });

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onopen).toBeFalsy();
    expect(socket.onclose).toBeFalsy();
    expect(socket.onmessage).toBeFalsy();
    expect(self.postMessage).toHaveBeenCalledWith({
      aux: true,
      connected: false,
    });
    expect(self.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "disconnect" }),
    );
    expect(closeScope).toHaveBeenCalledTimes(1);
  });

  it("closes the worker scope when no socket exists", () => {
    send({ type: "terminate" });

    expect(closeScope).toHaveBeenCalledTimes(1);
    expect(self.postMessage).not.toHaveBeenCalled();
  });

  it("after a closing stop, terminate only closes the scope", () => {
    const socket = start("wss://host/app/stream");
    send({ type: "stop", sns: [], close: true });
    expect(socket.close).toHaveBeenCalledTimes(1);
    self.postMessage.mockClear();

    send({ type: "terminate" });

    expect(socket.close).toHaveBeenCalledTimes(1); // not closed again
    expect(self.postMessage).not.toHaveBeenCalled();
    expect(closeScope).toHaveBeenCalledTimes(1);
  });
});
```

`afterEach` is not imported in that file yet; extend its vitest import to
`{ describe, it, expect, vi, beforeAll, beforeEach, afterEach }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/transport-web-socket.test.js`
Expected: the three new tests FAIL — `closeScope` is never called (the worker falls through to `protocolAgent.handleMessage("terminate", …)`), and in the first test the socket is not closed.

- [ ] **Step 3: Implement the command**

In `src/transport/web-socket.js`, immediately before

```js
  if (!socket && ["play", "stop"].includes(type)) {
```

insert:

```js
if (type === "terminate") {
  // Posted by TransportAdapter.destroy() after the closing stop, so the
  // socket (if any) is already closed in the normal case.
  if (socket) closeSocket();
  self.close();
  return;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/transport-web-socket.test.js`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/transport/web-socket.js tests/transport-web-socket.test.js
git add src/transport/web-socket.js tests/transport-web-socket.test.js
```

---

### Task 2: `TransportAdapter.destroy()`

**Files:**

- Modify: `src/transport/adapter.js`
- Create: `tests/transport-adapter.test.js`

**Interfaces:**

- Consumes: worker message `{ type: "terminate" }` from Task 1.
- Produces: `TransportAdapter.prototype.destroy()` (idempotent); after it, `connected === false`, `send()` and `runCallback()` are no-ops. Task 3 calls `destroy()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/transport-adapter.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TransportAdapter } from "@/transport/adapter";

const workers = [];

class FakeWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    this.onmessage = null;
    workers.push(this);
  }
}

function createAdapter(name) {
  const adapter = new TransportAdapter(name, "worker.js");
  return { adapter, worker: workers.at(-1) };
}

describe("TransportAdapter.destroy()", () => {
  beforeEach(() => {
    workers.length = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the worker to terminate, stops listening and reports disconnected", () => {
    const { adapter, worker } = createAdapter("ta-1");
    worker.onmessage({ data: { aux: true, connected: true } });
    expect(adapter.connected).toBe(true);

    adapter.destroy();

    expect(worker.onmessage).toBeNull();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "terminate" });
    expect(adapter.connected).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("hard-terminates the worker after exactly the fallback delay", () => {
    const { adapter, worker } = createAdapter("ta-2");

    adapter.destroy();
    vi.advanceTimersByTime(999);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("still schedules the hard terminate when postMessage throws", () => {
    const { adapter, worker } = createAdapter("ta-3");
    worker.postMessage = vi.fn(() => {
      throw new Error("worker gone");
    });

    expect(() => adapter.destroy()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and makes later send() calls no-ops", () => {
    const { adapter, worker } = createAdapter("ta-4");

    adapter.destroy();
    adapter.destroy();
    adapter.send("play", { streams: [] });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("drops a late worker message: no callback runs after destroy", () => {
    const { adapter, worker } = createAdapter("ta-5");
    const status = vi.fn();
    adapter.setCallback("status", status);
    const onmessage = worker.onmessage;

    adapter.destroy();
    // the browser would not deliver this (onmessage is null); even if a
    // reference leaked, the callbacks are gone
    expect(worker.onmessage).toBeNull();
    onmessage({ data: { type: "status", data: {} } });

    expect(status).not.toHaveBeenCalled();
  });

  it("runCallback() is a no-op after destroy", () => {
    const { adapter } = createAdapter("ta-6");
    const cb = vi.fn();
    adapter.setCallback("videoSetup", cb);

    adapter.destroy();

    expect(() =>
      adapter.runCallback("videoSetup", { trackId: 1 }),
    ).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it("runCallback() logs and returns when no callback is set", () => {
    const { adapter } = createAdapter("ta-7");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => adapter.runCallback("audioSetup", {})).not.toThrow();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/transport-adapter.test.js`
Expected: FAIL — `adapter.destroy is not a function` for the destroy tests; the last test fails with `TypeError: this._callbacks[type] is not a function`.

- [ ] **Step 3: Implement `destroy()` and the guards**

Replace `src/transport/adapter.js` with:

```js
import { LoggersFactory } from "@/shared/logger";

// Time given to the worker to process "terminate" (which closes the socket
// and the worker itself) before the thread is killed from the main side.
const TERMINATE_FALLBACK_MS = 1000;

export class TransportAdapter {
  constructor(instName, workerUrl) {
    this._logger = LoggersFactory.create(instName, "Transport");

    this._worker = new Worker(workerUrl, {
      type: "module",
    });
    this._callbacks = {};
    this._worker.onmessage = (e) => this._handleMessage(e.data);
    this._connected = false;
  }

  send(cmd, data) {
    if (!this._worker) return; // destroyed
    data.type = cmd;
    this._worker.postMessage(data);
  }

  destroy() {
    const worker = this._worker;
    if (!worker) return;

    this._worker = undefined;
    this._callbacks = {};
    this._connected = false;
    worker.onmessage = null;
    try {
      // handled after any stop/close already queued, so the socket is
      // closed gracefully before the worker closes itself
      worker.postMessage({ type: "terminate" });
    } catch (err) {
      this._logger.debug("Transport worker terminate request failed", err);
    }
    setTimeout(() => worker.terminate(), TERMINATE_FALLBACK_MS);
  }

  get connected() {
    return this._connected;
  }

  get callbacks() {
    return this._callbacks;
  }

  set callbacks(cbs) {
    this._callbacks = cbs;
  }

  setCallback(type, callback) {
    this._callbacks[type] = callback;
    return this;
  }

  runCallback(type, data) {
    if (!this._worker) return; // destroyed
    const callback = this._callbacks[type];
    if (!callback) {
      this._logger.error(`No callback set for type: ${type}`);
      return;
    }
    return callback(data);
  }

  _handleMessage(msg) {
    if (msg.type && this._callbacks[msg.type]) {
      this._callbacks[msg.type](msg.data);
    } else if (msg.aux) {
      if ("connected" in msg) {
        // console.log(`Connected ${msg.connected}`);
        this._connected = msg.connected;
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/transport-adapter.test.js tests/sldp-manager.test.js tests/nimio-live-failover.test.js`
Expected: PASS (the latter two use a hand-written transport, not this class, but confirm nothing imports changed).

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/transport/adapter.js tests/transport-adapter.test.js
git add src/transport/adapter.js tests/transport-adapter.test.js
```

---

### Task 3: `NimioLive.destroy()` destroys the transport last

**Files:**

- Modify: `src/nimio-live.js` (`destroy()`, currently lines 287–292)
- Test: `tests/nimio-live.test.js` (append a `describe`)

**Interfaces:**

- Consumes: `TransportAdapter.prototype.destroy()` from Task 2.
- Produces: nothing new; `destroy()` order is `stop()`, `_removeUIEventHandlers()`, `_deinitTransport()`, `_reconnect.destroy()`, `_transport.destroy()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/nimio-live.test.js` (the file already imports `NimioLive` and `vi`; it builds engines with `Object.create(NimioLive.prototype)`):

```js
describe("NimioLive.destroy() releases the transport worker", () => {
  it("destroys the transport after stopping and unsubscribing", () => {
    const live = Object.create(NimioLive.prototype);
    const order = [];
    live.stop = vi.fn(() => order.push("stop"));
    live._removeUIEventHandlers = vi.fn(() => order.push("ui"));
    live._deinitTransport = vi.fn(() => order.push("deinitTransport"));
    live._reconnect = { destroy: vi.fn(() => order.push("reconnect")) };
    live._transport = { destroy: vi.fn(() => order.push("transport")) };

    live.destroy();

    expect(live._transport.destroy).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "stop",
      "ui",
      "deinitTransport",
      "reconnect",
      "transport",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/nimio-live.test.js -t "releases the transport worker"`
Expected: FAIL — `transport.destroy` called 0 times; `order` lacks `"transport"`.

- [ ] **Step 3: Implement**

In `src/nimio-live.js`, change `destroy()` to:

```js
  destroy() {
    this.stop();
    this._removeUIEventHandlers();
    this._deinitTransport();
    this._reconnect.destroy();
    // last: the closing stop posted by stop() is processed by the worker
    // before the terminate request, so the server session ends cleanly
    this._transport.destroy();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live.test.js tests/nimio-live-attach.test.js tests/nimio-live-failover.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-live.js tests/nimio-live.test.js
git add src/nimio-live.js tests/nimio-live.test.js
```

---

### Task 4: Decoder workers acknowledge `shutdown` unconditionally

**Files:**

- Modify: `src/media/decoders/decoder-video.js` (`case "shutdown"`, currently lines 223–231)
- Modify: `src/media/decoders/decoder-audio.js` (`case "shutdown"`, currently lines 194–201)
- Test: `tests/decoder-video.test.js`, `tests/decoder-audio.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: on `{ type: "shutdown" }` a worker always posts `{ type: "shutdownComplete" }` and calls `close()`. Task 5 relies on the acknowledgement arriving even before codec data.

- [ ] **Step 1: Write the failing tests**

In `tests/decoder-video.test.js`, inside `describe("decoder-video", ...)`, add (the file's `setupWorkerGlobals()` already installs `postMessage` and an event target; `sendWorkerMessage` dispatches a `message` event):

```js
it("acknowledges shutdown and closes even before codec data arrived", async () => {
  globalThis.close = vi.fn();
  await import("@/media/decoders/decoder-video.js");
  sendWorkerMessage({
    type: "config",
    config: { codec: "avc1.42e01e", width: 640, height: 480 },
  });

  sendWorkerMessage({ type: "shutdown" });

  expect(postMessageMock).toHaveBeenCalledWith({ type: "shutdownComplete" });
  expect(globalThis.close).toHaveBeenCalledTimes(1);
});
```

In `tests/decoder-audio.test.js`, inside `describe("decoder-audio", ...)`, add:

```js
it("acknowledges shutdown and closes even before codec data arrived", async () => {
  globalThis.close = vi.fn();
  await import("@/media/decoders/decoder-audio.js");

  globalThis.dispatchEvent(
    new MessageEvent("message", { data: { type: "shutdown" } }),
  );

  expect(postMessageMock).toHaveBeenCalledWith({ type: "shutdownComplete" });
  expect(globalThis.close).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/decoder-video.test.js tests/decoder-audio.test.js -t "acknowledges shutdown"`
Expected: FAIL — `postMessageMock` was not called with `shutdownComplete` (no decoder exists yet, so the `if` skips everything).

- [ ] **Step 3: Implement**

`src/media/decoders/decoder-video.js`, replace the `shutdown` case with:

```js
    case "shutdown":
      if (videoDecoder) {
        buffered.length = 0;
        decodeTimings.clear();
        shutdownDecoder();
      }
      // always acknowledge, even before codec data created the decoder,
      // or the main thread would never terminate this worker
      self.postMessage({ type: "shutdownComplete" });
      self.close();
      break;
```

`src/media/decoders/decoder-audio.js`, replace the `shutdown` case with:

```js
    case "shutdown":
      if (audioDecoder) {
        buffered.length = 0;
        shutdownDecoder();
      }
      // always acknowledge, even before codec data created the decoder,
      // or the main thread would never terminate this worker
      self.postMessage({ type: "shutdownComplete" });
      self.close();
      break;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/decoder-video.test.js tests/decoder-audio.test.js`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/media/decoders/decoder-video.js src/media/decoders/decoder-audio.js tests/decoder-video.test.js tests/decoder-audio.test.js
git add src/media/decoders/decoder-video.js src/media/decoders/decoder-audio.js tests/decoder-video.test.js tests/decoder-audio.test.js
```

---

### Task 5: `DecoderFlow.destroy()` hard-terminate fallback

**Files:**

- Modify: `src/media/decoders/flow.js` (constant after `SWITCH_THRESHOLD_US`; `destroy()` currently lines 111–122; new `_scheduleForcedTermination()` next to `_removeDecoderListener()`)
- Test: `tests/flow-audio.test.js` (append a fixture and a `describe`)

**Interfaces:**

- Consumes: `shutdownComplete` acknowledgement (Task 4) handled by the existing `_handleDecoderMessage()`, which terminates the worker and sets `_decoder` to `null` or to the switch peer's worker.
- Produces: `destroy()` always arms `_scheduleForcedTermination(decoder)`; the fallback terminates only if `this._decoder === decoder` after `SHUTDOWN_FALLBACK_MS`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/flow-audio.test.js` (it already has `createFlow`, `createAudioBuffer`, `vi`):

```js
// A flow with a fake decoder worker; destroy() touches exactly these fields
function createFlowWithWorker() {
  const flow = createFlow(createAudioBuffer());
  flow._logger = { debug: vi.fn(), error: vi.fn() };
  flow._decoder = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  };
  flow._eventBus = { emit: vi.fn() };
  flow._metricsManager = { remove: vi.fn() };
  flow._timestampManager = { removeTrack: vi.fn() };
  flow._trackId = 7;
  flow._type = "audio";
  return flow;
}

describe("DecoderFlow.destroy() worker termination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts shutdown and hard-terminates a worker that never acknowledges", () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;

    flow.destroy();

    expect(decoder.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    vi.advanceTimersByTime(999);
    expect(decoder.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(decoder.terminate).toHaveBeenCalledTimes(1);
    expect(flow._decoder).toBeNull();
    expect(flow._buffer).toBeNull();
  });

  it("arms the fallback even when a switch already posted the shutdown", () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;
    flow._isShuttingDown = true; // finalizeSwitch() ran before destroy()

    flow.destroy();

    expect(decoder.postMessage).not.toHaveBeenCalled(); // no second shutdown
    vi.advanceTimersByTime(1000);
    expect(decoder.terminate).toHaveBeenCalledTimes(1);
    expect(flow._decoder).toBeNull();
    expect(flow._buffer).toBeNull();
  });

  it("does not terminate again when shutdownComplete arrived first", async () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;

    flow.destroy();
    await flow._handleDecoderMessage({ data: { type: "shutdownComplete" } });
    expect(decoder.terminate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);

    expect(decoder.terminate).toHaveBeenCalledTimes(1);
    expect(flow._decoder).toBeNull();
  });

  it("ignores a shutdownComplete that arrives after the fallback fired", async () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;

    flow.destroy();
    vi.advanceTimersByTime(1000);
    expect(decoder.terminate).toHaveBeenCalledTimes(1);

    await expect(
      flow._handleDecoderMessage({ data: { type: "shutdownComplete" } }),
    ).resolves.not.toThrow();

    expect(decoder.terminate).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a worker and arms no timer", () => {
    const flow = createFlowWithWorker();
    flow._decoder = null;

    expect(() => flow.destroy()).not.toThrow();

    expect(vi.getTimerCount()).toBe(0);
  });
});
```

`afterEach` is not imported in that file yet; extend its vitest import to
`{ describe, it, expect, vi, beforeEach, afterEach }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/flow-audio.test.js -t "worker termination"`
Expected: the first two FAIL — `terminate` never called (no fallback exists; the second returns early on `_isShuttingDown`). The other three pass already and stay as guards.

- [ ] **Step 3: Implement**

In `src/media/decoders/flow.js`, after `const SWITCH_THRESHOLD_US = 8_000_000;` add:

```js
// Time given to the decoder worker to acknowledge "shutdown" before the
// thread is killed from the main side (worker crashed or never replied).
const SHUTDOWN_FALLBACK_MS = 1000;
```

Replace `destroy()` with:

```js
  destroy() {
    const decoder = this._decoder;
    if (!decoder) return;

    this._switchPeerFlow = null;
    this._cancelInput();
    this._shutdown(); // no-op when a switch already posted the shutdown
    // whatever the worker does with the shutdown, it is terminated
    this._scheduleForcedTermination(decoder);
    this._trackId = null;
    if (this._buffer) {
      this._buffer.reset();
      this._buffer = null;
    }
  }
```

After `_removeDecoderListener()` add:

```js
  // Fallback for a worker that never posts shutdownComplete. Keyed on the
  // worker identity: if the acknowledgement arrived (or a switch adopted the
  // peer's worker) this._decoder no longer points at it and nothing happens.
  _scheduleForcedTermination(decoder) {
    setTimeout(() => {
      if (this._decoder !== decoder) return;
      this._removeDecoderListener();
      decoder.terminate();
      this._decoder = null;
    }, SHUTDOWN_FALLBACK_MS);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/flow-audio.test.js tests/flow-video.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/media/decoders/flow.js tests/flow-audio.test.js
git add src/media/decoders/flow.js tests/flow-audio.test.js
```

---

### Task 6: Full verification and the single commit

**Files:** none new.

- [ ] **Step 1: Full suite and formatting**

Run: `npx prettier --check src tests && npx vitest run`
Expected: prettier clean; all test files pass (22 existing files plus `tests/transport-adapter.test.js`).

- [ ] **Step 2: Confirm only intended files are staged**

Run: `git status --short`
Expected staged (`A`/`M`): `src/transport/web-socket.js`, `src/transport/adapter.js`, `src/nimio-live.js`, `src/media/decoders/decoder-video.js`, `src/media/decoders/decoder-audio.js`, `src/media/decoders/flow.js`, `tests/transport-web-socket.test.js`, `tests/transport-adapter.test.js`, `tests/nimio-live.test.js`, `tests/decoder-video.test.js`, `tests/decoder-audio.test.js`, `tests/flow-audio.test.js`. Nothing under `docs/`.

- [ ] **Step 3: Commit (the one code commit of this PR)**

```bash
git commit -F - <<'MSG'
Terminate transport and decoder workers on destroy

A destroyed player left Worker threads behind. The transport worker was never
terminated, and with it the adapter callbacks, the live engine and everything
they reference. A decoder worker that received "shutdown" before any codec
data created a decoder never acknowledged and never closed, and a wedged
worker leaked the same way.

- Transport worker: new "terminate" command runs closeSocket() if a socket
  exists and closes the worker scope.
- TransportAdapter.destroy(): detaches onmessage, drops callbacks, reports
  disconnected, posts "terminate" and hard-terminates the worker after 1 s as
  a fallback; idempotent; send()/runCallback() are no-ops afterwards.
  runCallback() no longer throws when no callback is set.
- NimioLive.destroy() destroys the transport last, after the closing stop,
  so the server session is closed before the worker goes away.
- Decoder workers always post shutdownComplete and close on "shutdown".
- DecoderFlow.destroy() always arms a 1 s identity-keyed hard terminate,
  including when a rendition switch already posted the shutdown.

Tests: transport worker terminate, TransportAdapter.destroy(), NimioLive
destroy order, decoder shutdown before codec data, flow fallback paths.
MSG
```

- [ ] **Step 4: Record the PR hand-off**

PR title: "Terminate transport and decoder workers on destroy". Body: the commit
message plus a note that this is the first of three PRs replacing #92 after
#95, and that #92 will be closed with a pointer.

---

## Self-review

- **Spec coverage:** §1 → Task 1; §2 → Task 2 (including the `runCallback` return); §3 → Task 3; §4 → Task 4; §5 → Task 5; Error handling → Task 2 throwing-`postMessage` test; Testing list → Tasks 1–5 test steps; Delivery → Task 6.
- **Placeholder scan:** every code step carries the code; no "similar to", no TBD.
- **Type consistency:** `destroy()` on `TransportAdapter` (Task 2) is what Task 3 calls; `_scheduleForcedTermination(decoder)` named identically in Task 5 implementation and tests; `SHUTDOWN_FALLBACK_MS` / `TERMINATE_FALLBACK_MS` as in the spec.
- **Review Focus:** each of the five lines has a test in the named task.
