# Media Path After-Stop Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work started before a stop or destroy no longer acts afterwards on the media path: late decoder messages are dropped, stale SLDP status replies request nothing, and an aborted rendition switch leaves the main flow switchable and reports once.

**Architecture:** `PlaybackContext.setStreams()` commits atomically and reports supersession; `SLDPManager` carries a run token bumped by every stop and by a new `destroy()`, tracks setup timers, and returns prepared streams from `_processStatus()`; `DecoderFlow` gains a `_destroyed` flag that makes `destroy()` idempotent and late messages inert, and a peer notification so a dying switch peer clears and fails the switch on the main flow.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom, fake timers, fake transport / fake decoder worker fixtures.

**Spec:** `docs/superpowers/specs/2026-10-14-media-after-stop-guards-design.md`

## Global Constraints

- Branch `fix/media-after-stop-guards`, stacked on `fix/worker-termination-pr` (`efe8964`). The flow changes extend PR 1's `destroy()` and `_scheduleForcedTermination()`; do not duplicate or rework them.
- No change to the SLDP wire protocol, the keep-alive interval (10000 ms), or `SWITCH_THRESHOLD_US`.
- No facade (`src/nimio.js`), UI, audio-initialisation or service-hook changes (PR 2b, PR 3).
- Project rule: **one code commit at the end** (Task 6). Earlier tasks only `git add`. Spec/plan commits stay local.
- `npx prettier --check src tests` and `npx vitest run` must be clean before the commit.
- Switch roles: the main flow calls `switchTo(newFlow)` and is `dst`; the new rendition flow is `src`. Only the main flow has `onSwitchResult`.

## Review Focus

- A `shutdownComplete` on the main flow whose peer was destroyed without notification (pointer already cleared on the peer): must not adopt a `null` worker → adoption guard test in Task 5.
- A `src` flow whose `decoderError` arrives after it was already destroyed: must not notify or report twice → `decoderError` after destroy test in Task 4 plus the "reports once" tests in Task 5.
- A status reply for a run that was stopped **and restarted** before the reply settles: the old reply must not clear the fresh reply's play request → settle-order test in Task 2.
- `destroy()` on a flow during `_resetPlayback()` (state already stopped) while a switch is in progress: no `onSwitchResult` and no throw → "silent when stopped" test in Task 5.
- `setStreams()` called twice where the newer resolves first: the older must not overwrite → Task 1 test.

---

### Task 1: `PlaybackContext.setStreams()` commits atomically

**Files:**

- Modify: `src/playback/context.js` (`setStreams()` lines 38–121, `_cpAudioRenditions()` line 427)
- Create: `tests/playback-context.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `setStreams(streams)` resolves to `true` when committed, `false` when superseded. Task 2's `_processStatus()` reads this.

- [ ] **Step 1: Write the failing test**

Create `tests/playback-context.test.js`:

```js
import { describe, it, expect } from "vitest";
import { PlaybackContext } from "@/playback/context";

function stream(name, height) {
  return {
    stream: name,
    stream_info: {
      resolution: `640x${height}`,
      vcodec: "avc1.42e01e",
      bandwidth: "1000",
      vtimescale: "90000",
    },
  };
}

describe("PlaybackContext.setStreams() concurrency", () => {
  it("a superseded call commits nothing and the newest call wins", async () => {
    const ctx = PlaybackContext.getInstance("ctx-seq");
    const support = { video: { "avc1.42e01e": true }, audio: {} };
    let settleOld;
    ctx._checkSupportedCodecs = () =>
      settleOld
        ? Promise.resolve(support)
        : new Promise((resolve) => (settleOld = () => resolve(support)));

    const old = ctx.setStreams([stream("a", 360), stream("b", 720)]);
    const fresh = ctx.setStreams([stream("c", 480)]);
    await expect(fresh).resolves.toBe(true);
    settleOld();

    await expect(old).resolves.toBe(false);
    expect(ctx.streams.map((s) => s.stream)).toEqual(["c"]);
    expect(ctx.videoRenditions).toHaveLength(1);
    expect(ctx.videoRenditions[0].name).toBe("c");
  });

  it("a committed call exposes its renditions", async () => {
    const ctx = PlaybackContext.getInstance("ctx-commit");
    ctx._checkSupportedCodecs = async () => ({
      video: { "avc1.42e01e": true },
      audio: {},
    });

    await expect(
      ctx.setStreams([stream("hi", 720), stream("lo", 360)]),
    ).resolves.toBe(true);

    expect(ctx.videoRenditions.map((r) => r.name)).toEqual(["lo", "hi"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/playback-context.test.js`
Expected: FAIL — `fresh` resolves to `undefined` (not `true`), and after `settleOld()` the streams are `["a","b"]`.

- [ ] **Step 3: Implement the atomic commit**

In `src/playback/context.js`, replace `setStreams()` (from `async setStreams(streams) {` through the three `_cpAudioRenditions` calls and the closing brace) with:

```js
  // Resolves to true when the streams were committed, false when a newer
  // setStreams() call superseded this one while codec support was checked.
  // Shared state is only touched after the await, in one synchronous step.
  async setStreams(streams) {
    const seq = (this._streamsSeq = (this._streamsSeq || 0) + 1);
    const cSupport = await this._checkSupportedCodecs(streams);
    if (seq !== this._streamsSeq) return false;

    const streamsMap = {};
    const ordRenditions = [];
    const ordVideoRenditions = [];
    const ordAudioRenditions = [];

    let noVideoStreams = [];
    for (let i = 0; i < streams.length; i++) {
      streamsMap[streams[i].stream] = i;

      let streamInfo = streams[i].stream_info;
      if (streamInfo.vtimescale) {
        streamInfo.vtimescale = parseInt(streamInfo.vtimescale);
      }
      if (streamInfo.atimescale) {
        streamInfo.atimescale = parseInt(streamInfo.atimescale);
      }

      let vIdx = null;
      if (streamInfo.resolution && streamInfo.vcodec) {
        let res = streamInfo.resolution.split("x");
        streamInfo.width = parseInt(res[0]);
        streamInfo.height = parseInt(res[1]);
        streamInfo.name = res[1] + "p";

        if (cSupport.video[streamInfo.vcodec]) {
          streamInfo.vcodecSupported = true;
          streamInfo.bwStr = streamInfo.bandwidth;
          if (streamInfo.bandwidth) {
            streamInfo.bandwidth = parseInt(streamInfo.bandwidth);
          }

          for (vIdx = 0; vIdx < ordVideoRenditions.length; vIdx++) {
            let ordStreamInfo =
              streams[ordVideoRenditions[vIdx].idx].stream_info;
            if (
              ordStreamInfo.height > streamInfo.height ||
              (ordStreamInfo.height === streamInfo.height &&
                ordStreamInfo.bandwidth > streamInfo.bandwidth)
            ) {
              break;
            }
          }

          ordVideoRenditions.splice(vIdx, 0, {
            idx: i,
            bandwidth: streamInfo.bandwidth,
            width: streamInfo.width,
            height: streamInfo.height,
            vcodec: streamInfo.vcodec,
            rendition: streamInfo.name,
            name: streams[i].stream,
          });
        }
      }

      if (!streamInfo.vcodecSupported) {
        noVideoStreams.push({ idx: i });
      }

      if (streamInfo.acodec) {
        streamInfo.acodecSupported = cSupport.audio[streamInfo.acodec];
        if (vIdx !== null && ordVideoRenditions[vIdx]) {
          ordVideoRenditions[vIdx].hasAudio = streamInfo.acodecSupported;
        }
      }
    }

    for (let i = 0; i < ordVideoRenditions.length; i++) {
      let r = { ...ordVideoRenditions[i] };
      if (r.hasAudio) {
        r.acodec = streams[r.idx].stream_info.acodec;
        delete r.hasAudio;
      }
      ordRenditions.push(r);
    }

    this._cpAudioRenditions(ordAudioRenditions, ordVideoRenditions, streams);
    this._cpAudioRenditions(ordAudioRenditions, noVideoStreams, streams);
    this._cpAudioRenditions(ordRenditions, noVideoStreams, streams);

    this._streams = streams;
    this._streamsMap = streamsMap;
    this._cSupport = cSupport;
    this._ordVideoRenditions = ordVideoRenditions;
    this._ordAudioRenditions = ordAudioRenditions;
    this._ordRenditions = ordRenditions;
    return true;
  }
```

And change `_cpAudioRenditions` to read from the passed array:

```js
  _cpAudioRenditions(target, source, streams) {
    for (let i = 0; i < source.length; i++) {
      let stream = streams[source[i].idx];
      if (stream.stream_info.acodecSupported) {
        target.push({
          idx: source[i].idx,
          bandwidth: stream.stream_info.bandwidth,
          acodec: stream.stream_info.acodec,
          name: stream.stream,
        });
      }
    }
  }
```

Run `grep -n "_cpAudioRenditions(" src/playback/context.js` — all callers are the three above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/playback-context.test.js tests/sldp-manager.test.js tests/nimio-live.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/playback/context.js tests/playback-context.test.js
git add src/playback/context.js tests/playback-context.test.js
```

---

### Task 2: `SLDPManager` run token, setup timers, `destroy()`

**Files:**

- Modify: `src/sldp/manager.js` (constructor, `init()` status callback, `start()`, `resetRequestedStreams()`, `requestStream()`, `_processStatus()`, new `destroy()` and `_cancelSetupTimers()`)
- Create: `tests/sldp-manager-run.test.js`

**Interfaces:**

- Consumes: `PlaybackContext.setStreams()` → `true | false` (Task 1).
- Produces: `SLDPManager.prototype.destroy()`; `_processStatus()` resolves to the prepared streams array or `null`. Task 3 calls `destroy()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sldp-manager-run.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SLDPManager } from "@/sldp/manager";

// A manager with a fake transport that records sends and exposes the status
// callback, a fake context, and a started run.
function createManager(name) {
  const mgr = new SLDPManager(name);
  const transport = {
    callbacks: {},
    setCallback: vi.fn((type, cb) => (transport.callbacks[type] = cb)),
    send: vi.fn(),
    runCallback: vi.fn(),
    connected: true,
  };
  mgr.init(transport, {});
  mgr._context = {
    setSourceUrl: vi.fn(),
    setStreams: () => Promise.resolve(true),
    getStreamsConfig: () => [],
    streams: [
      {
        stream: "s1",
        stream_info: { vcodec: "avc1", width: 1, height: 1, vtimescale: 90000 },
      },
    ],
  };
  mgr._processCurrentStreams = vi.fn();
  mgr._eventBus = { emit: vi.fn() };
  mgr.start("wss://example.com/live");
  return { mgr, transport };
}

const playsOf = (transport) =>
  transport.send.mock.calls.filter((c) => c[0] === "play");

describe("SLDPManager run token and timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stop cancels queued stream setup callbacks", () => {
    const { mgr, transport } = createManager("sldp-stop");
    mgr.requestStream("video", 0);

    mgr.stop();
    vi.runAllTimers();

    expect(transport.runCallback).not.toHaveBeenCalled();
  });

  it("destroy cancels queued stream setup callbacks", () => {
    const { mgr, transport } = createManager("sldp-destroy-timers");
    mgr.requestStream("video", 0);

    mgr.destroy();
    vi.runAllTimers();

    expect(transport.runCallback).not.toHaveBeenCalled();
  });

  it("a status whose processing settles after a stop requests nothing", async () => {
    const { mgr, transport } = createManager("sldp-status-stop");
    let settle;
    mgr._context.setStreams = () =>
      new Promise((resolve) => (settle = resolve));

    const pending = transport.callbacks.status({ info: [] });
    mgr.stop();
    settle(true);
    await pending;

    expect(mgr._processCurrentStreams).not.toHaveBeenCalled();
    expect(mgr._eventBus.emit).not.toHaveBeenCalledWith(
      "nimio:connection-established",
      expect.anything(),
    );
    expect(playsOf(transport)).toHaveLength(0);
  });

  it("a stop from a connection-established listener prevents the play request", async () => {
    const { mgr, transport } = createManager("sldp-listener-stop");
    mgr._eventBus.emit = vi.fn((event) => {
      if (event === "nimio:connection-established") mgr.stop();
    });

    await transport.callbacks.status({ info: [] });

    expect(playsOf(transport)).toHaveLength(0);
  });

  it("a cancelled status settling first does not clear the restarted status's play", async () => {
    const { mgr, transport } = createManager("sldp-settle-order");
    const settlers = [];
    mgr._context.setStreams = () =>
      new Promise((resolve) => settlers.push(() => resolve(true)));
    mgr._processCurrentStreams = vi.fn(() => {
      mgr._curStreams = [{ sn: 1, stream: "s1" }];
    });

    const old = transport.callbacks.status({ info: [] });
    mgr.stop(); // stop and restart while the old codec check is pending
    mgr.start("wss://example.com/live");
    const fresh = transport.callbacks.status({ info: [] });
    settlers[0]();
    settlers[1](); // both settle in the same turn, old first
    await Promise.all([old, fresh]);

    const plays = playsOf(transport);
    expect(plays).toHaveLength(1);
    expect(plays[0][1].streams).toEqual([{ sn: 1, stream: "s1" }]);
  });

  it("a status arriving after a stop that preceded it requests nothing", async () => {
    const { mgr, transport } = createManager("sldp-stop-before-status");

    mgr.stop({ closeConnection: false }); // e.g. detach to VOD before the reply
    await transport.callbacks.status({ info: [] });

    expect(mgr._processCurrentStreams).not.toHaveBeenCalled();
    expect(playsOf(transport)).toHaveLength(0);
  });

  it("a status arriving after destroy requests nothing", async () => {
    const { mgr, transport } = createManager("sldp-destroy-before-status");

    mgr.destroy();
    await transport.callbacks.status({ info: [] });

    expect(playsOf(transport)).toHaveLength(0);
  });

  it("a status for a live run still requests the prepared streams", async () => {
    const { mgr, transport } = createManager("sldp-live-run");
    mgr._processCurrentStreams = vi.fn(() => {
      mgr._curStreams = [{ sn: 2, stream: "s1" }];
    });

    await transport.callbacks.status({ info: [] });

    expect(mgr._eventBus.emit).toHaveBeenCalledWith(
      "nimio:connection-established",
      [],
    );
    expect(playsOf(transport)).toHaveLength(1);
    expect(playsOf(transport)[0][1].streams).toEqual([{ sn: 2, stream: "s1" }]);
    expect(mgr._curStreams).toEqual([]);
  });

  it("destroy clears an armed keep-alive timer and leaves no timers", () => {
    const { mgr, transport } = createManager("sldp-keepalive-destroy");
    mgr.keepAliveConnection();
    transport.send.mockClear();

    mgr.destroy();
    vi.advanceTimersByTime(10000);

    const keepAlives = transport.send.mock.calls.filter(
      ([cmd, data]) => cmd === "stop" && data.sns?.length === 0,
    );
    expect(keepAlives).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sldp-manager-run.test.js`
Expected: FAIL — the destroy tests with `mgr.destroy is not a function`; "stop cancels queued stream setup callbacks" with `runCallback` called; the status-across-stop tests with a `play` sent or `_processCurrentStreams` called. "a status for a live run still requests the prepared streams" passes already (guard).

- [ ] **Step 3: Implement**

In `src/sldp/manager.js`:

Constructor, after `this._useSyncMode = false;`:

```js
this._setupTimers = new Set();
this._runToken = 0; // bumped on every stop and on destroy
```

Replace the status callback in `init()`:

```js
this._transport.setCallback("status", async (status) => {
  // a stop between start() and the status reply invalidates the run
  if (this._startToken !== this._runToken) return;
  if (this._useSyncMode) {
    this._handleSyncParams(status);
  }
  const token = this._runToken;
  const streams = await this._processStatus(status.info);
  // stopped during the codec check, or by a connection-established listener
  if (!streams || token !== this._runToken) return;
  this._sendRequest("play", { streams });
});
```

`start(url)`: add `this._startToken = this._runToken;` as the first line.

`resetRequestedStreams()`: add as the first two lines:

```js
this._runToken++;
this._cancelSetupTimers();
```

`requestStream()`: replace the `setTimeout` with:

```js
const timer = setTimeout(() => {
  this._setupTimers.delete(timer);
  this._transport.runCallback(`${type}Setup`, setup);
}, 0);
this._setupTimers.add(timer);
```

After `cancelKeepAlive()` add:

```js
  destroy() {
    this._runToken++;
    this._cancelSetupTimers();
    this.cancelKeepAlive();
  }

  _cancelSetupTimers() {
    for (const id of this._setupTimers) clearTimeout(id);
    this._setupTimers.clear();
  }
```

Replace `_processStatus()`:

```js
  // Resolves to the streams to request, or null when the run was stopped
  // during the (asynchronous) codec check; nothing is applied in that case.
  async _processStatus(streams) {
    const token = this._runToken;
    const committed = await this._context.setStreams(streams);
    if (!committed || token !== this._runToken) return null;

    const streamsConfig = this._context.getStreamsConfig();
    for (const stream of streamsConfig) {
      if (this._hasVideo && stream.video === "not supported") {
        this._logger.warn(
          `Video codec not supported: ${stream.vcodec} (stream: ${stream.name})`,
        );
      }
    }

    this._processCurrentStreams();
    const requested = this._curStreams;
    this._curStreams = [];

    this._eventBus.emit("nimio:connection-established", streamsConfig);
    return requested;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sldp-manager-run.test.js tests/sldp-manager.test.js tests/nimio-live-failover.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/sldp/manager.js tests/sldp-manager-run.test.js
git add src/sldp/manager.js tests/sldp-manager-run.test.js
```

---

### Task 3: `NimioLive.destroy()` destroys the SLDP manager

**Files:**

- Modify: `src/nimio-live.js` (`destroy()`, lines 287–295)
- Modify: `tests/nimio-live.test.js` (the `describe("NimioLive.destroy() releases the transport worker")` block)

**Interfaces:**

- Consumes: `SLDPManager.prototype.destroy()` (Task 2).
- Produces: order `stop`, UI handlers, `_deinitTransport`, `_reconnect.destroy`, `_sldpManager.destroy`, `_transport.destroy`.

- [ ] **Step 1: Update the order test to fail**

In `tests/nimio-live.test.js`, inside the existing destroy-order test, add the manager stub and the expected entry:

```js
live._reconnect = { destroy: vi.fn(() => order.push("reconnect")) };
live._sldpManager = { destroy: vi.fn(() => order.push("sldp")) };
live._transport = { destroy: vi.fn(() => order.push("transport")) };

live.destroy();

expect(live._transport.destroy).toHaveBeenCalledTimes(1);
expect(live._sldpManager.destroy).toHaveBeenCalledTimes(1);
expect(order).toEqual([
  "stop",
  "ui",
  "deinitTransport",
  "reconnect",
  "sldp",
  "transport",
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/nimio-live.test.js -t "releases the transport worker"`
Expected: FAIL — `sldpManager.destroy` called 0 times.

- [ ] **Step 3: Implement**

```js
  destroy() {
    this.stop();
    this._removeUIEventHandlers();
    this._deinitTransport();
    this._reconnect.destroy();
    // a status reply or setup timer of the stopped run must do nothing
    this._sldpManager.destroy();
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

### Task 4: Decoder flow after destroy

**Files:**

- Modify: `src/media/decoders/flow.js` (`destroy()` line 114; `_handleDecoderMessage()` cases at lines 176, 185, 193; `_handleDecodedFrame()` line 291)
- Modify: `tests/flow-audio.test.js` (append a `describe`; extend `createFlowWithWorker()`)

**Interfaces:**

- Consumes: PR 1's `_scheduleForcedTermination(decoder)`.
- Produces: `_destroyed` flag; `destroy()` idempotent; `_handleDecodedFrame()` resolves `false` and closes the frame when destroyed or bufferless, including after the start-ts await. Task 5 relies on `_destroyed`.

- [ ] **Step 1: Write the failing tests**

In `tests/flow-audio.test.js`, extend the fixture's fake timestamp manager so switch tests in Task 5 can reuse it:

```js
flow._timestampManager = { removeTrack: vi.fn(), updateTimeBase: vi.fn() };
```

Append:

```js
describe("DecoderFlow after destroy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroy twice posts one shutdown and arms one timer", () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;

    flow.destroy();
    flow.destroy();

    expect(decoder.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a frame arriving after destroy is closed and not pushed", async () => {
    const flow = createFlowWithWorker();
    flow.destroy();
    const audioFrame = createMockAudioFrame(0);

    await flow._handleDecoderMessage({
      data: {
        type: "decodedFrame",
        audioFrame,
        decTimestamp: 0,
        rawTimestamp: 0,
      },
    });

    expect(audioFrame.close).toHaveBeenCalledTimes(1);
  });

  it("a decoder error arriving after destroy calls nothing", async () => {
    const flow = createFlowWithWorker();
    flow.onDecodingError = vi.fn();
    flow.destroy();
    flow._decoder = { postMessage: vi.fn() }; // would be touched by a second destroy()

    await flow._handleDecoderMessage({ data: { type: "decoderError" } });

    expect(flow.onDecodingError).not.toHaveBeenCalled();
    expect(flow._decoder.postMessage).not.toHaveBeenCalled();
  });

  it("shutdownComplete on a destroyed flow terminates the worker and adopts nothing", async () => {
    const flow = createFlowWithWorker();
    const decoder = flow._decoder;
    const peer = { exportDecoder: vi.fn(), buffer: null, isActive: () => true };
    flow._isShuttingDown = true; // finalizeSwitch already posted shutdown
    flow._switchPeerFlow = peer;
    flow._switchContext = { dst: true };
    flow.onSwitchResult = vi.fn();

    flow.destroy(); // clears the peer pointer (notification is Task 5)
    flow._switchPeerFlow = peer; // simulate a pointer that survived
    await flow._handleDecoderMessage({ data: { type: "shutdownComplete" } });

    expect(decoder.terminate).toHaveBeenCalledTimes(1);
    expect(peer.exportDecoder).not.toHaveBeenCalled();
    expect(flow._decoder).toBeNull();
    expect(flow._switchPeerFlow).toBeNull();
    expect(flow._switchContext).toBeNull();
  });

  it("a frame whose start-ts handler was pending when the flow was destroyed is closed", async () => {
    const flow = createFlowWithWorker();
    flow._startTsUs = 0;
    flow.onStartTsNotSet = async () => {
      flow.destroy(); // playback reset while the engine initialised output
      return true;
    };
    const audioFrame = createMockAudioFrame(0);

    await expect(flow._handleDecodedFrame(audioFrame)).resolves.toBe(false);

    expect(audioFrame.close).toHaveBeenCalledTimes(1);
  });

  it("a throwing start-ts handler closes the frame and reports failure", async () => {
    const flow = createFlowWithWorker();
    flow._startTsUs = 0;
    flow.onStartTsNotSet = () => Promise.reject(new Error("cancelled"));
    const audioFrame = createMockAudioFrame(0);

    await expect(flow._handleDecodedFrame(audioFrame)).resolves.toBe(false);

    expect(audioFrame.close).toHaveBeenCalledTimes(1);
    expect(flow._logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/flow-audio.test.js -t "after destroy"`
Expected: FAIL — two shutdowns / two timers; the late frame test throws `TypeError` from `_pushToBuffer` on a null buffer (or fails `close` count); the decoder-error test calls `onDecodingError`; the destroyed-mid-await test resolves `true` or throws; the throwing handler test rejects.

- [ ] **Step 3: Implement**

In `src/media/decoders/flow.js`:

`destroy()`:

```js
  destroy() {
    if (this._destroyed) return; // idempotent: one shutdown, one fallback timer
    // messages still in flight from the worker must not reach the buffer,
    // the engine or a switch peer once the flow is destroyed
    this._destroyed = true;
    const decoder = this._decoder;
    this._switchPeerFlow = null;
    if (!decoder) return;

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

`_handleDecoderMessage()`:

```js
      case "decodedFrame":
        let frame = this._prepareFrame(e.data);
        if (this._destroyed) {
          frame.close();
          break;
        }
        // ... unchanged
      case "decoderError":
        if (this._destroyed) break;
        // ... unchanged
      case "shutdownComplete":
        this._logger.debug("Shutdown has completed");
        this._isShuttingDown = null;
        if (this._decoder) {
          this._removeDecoderListener();
          this._decoder.terminate();
          this._decoder = null;
        }
        if (this._destroyed) {
          // destroyed while a switch was finalizing: adopt nothing
          this._switchPeerFlow = null;
          this._switchContext = null;
          break;
        }
        // ... unchanged adoption
```

`_handleDecodedFrame()`:

```js
  async _handleDecodedFrame(frame) {
    if (this._destroyed || !this._buffer) {
      frame.close();
      return false;
    }
    if (this._state.isStopped()) {
      frame.close();
      return true;
    }

    if (this._startTsUs === 0) {
      if (this._onStartTsNotSet) {
        let res;
        try {
          res = await this._onStartTsNotSet(frame);
        } catch (err) {
          this._logger.error("Flow output initialization failed", err);
          res = false;
        }
        if (!res || !this._buffer) {
          // output failed, or the flow was destroyed while waiting
          frame.close();
          return false;
        }
      }

      // check _startTsUs to avoid multiple assignments when all promises are resolved
      if (this._startTsUs === 0) {
        this._startTsUs = this._state.getPlaybackStartTsUs();
      }
    }

    this._pushToBuffer(frame);
    return true;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/flow-audio.test.js tests/flow-video.test.js`
Expected: PASS, including PR 1's "worker termination" block and the pre-existing buffer-full tests (the `createFlow(null)` test still resolves `undefined` from `_handleDecoderOutput`).

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/media/decoders/flow.js tests/flow-audio.test.js
git add src/media/decoders/flow.js tests/flow-audio.test.js
```

---

### Task 5: Switch abort cleanup

**Files:**

- Modify: `src/media/decoders/flow.js` (`destroy()`, `decoderError` case, `shutdownComplete` adoption, `_handleDstSwitchFrame()`, new `_onPeerDestroyed()`)
- Modify: `tests/flow-audio.test.js` (append a `describe`)

**Interfaces:**

- Consumes: `_destroyed` (Task 4); `switchTo()`, `_startSwitch()`, `isActive()` as they exist.
- Produces: `_onPeerDestroyed()`; the `src` `decoderError` path destroys without reporting; the main flow reports a failed switch exactly once.

- [ ] **Step 1: Write the failing tests**

Append to `tests/flow-audio.test.js`:

```js
const SWITCH_ABORT_MSG =
  "Rendition switch aborted: the new rendition's decoder stopped";

// A main flow (dst) switching to a new rendition flow (src), as
// NimioTransport does: main.switchTo(src) pairs them both ways.
function createSwitchPair() {
  const main = createFlowWithWorker();
  const src = createFlowWithWorker();
  main.onSwitchResult = vi.fn();
  main.switchTo(src);
  expect(main._switchContext?.dst).toBe(true);
  expect(src._switchContext?.src).toBe(true);
  expect(src._switchPeerFlow).toBe(main);
  return { main, src };
}

describe("DecoderFlow switch abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroying the src peer clears the main flow's switch and reports once", () => {
    const { main, src } = createSwitchPair();

    src.destroy();

    expect(main._switchContext).toBeNull();
    expect(main._switchPeerFlow).toBeNull();
    expect(main.onSwitchResult).toHaveBeenCalledTimes(1);
    expect(main.onSwitchResult).toHaveBeenCalledWith(false, SWITCH_ABORT_MSG);
    expect(main._startSwitch("dst")).toBe(true); // a new switch can start
  });

  it("is silent when the main flow's playback is already stopped (teardown)", () => {
    const { main, src } = createSwitchPair();
    main._state.isStopped = () => true;

    src.destroy();

    expect(main._switchContext).toBeNull();
    expect(main._switchPeerFlow).toBeNull();
    expect(main.onSwitchResult).not.toHaveBeenCalled();
  });

  it("a decoder error on the src flow destroys it and fails the switch via the main flow", async () => {
    const { main, src } = createSwitchPair();
    const srcDecoder = src._decoder;

    await src._handleDecoderMessage({ data: { type: "decoderError" } });

    expect(srcDecoder.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    expect(main.onSwitchResult).toHaveBeenCalledTimes(1);
    expect(main.onSwitchResult).toHaveBeenCalledWith(false, SWITCH_ABORT_MSG);
    expect(src._switchPeerFlow).toBeNull();
  });

  it("the main flow's excessive-gap abort reports exactly once", () => {
    const { main, src } = createSwitchPair();
    src._switchContext.firstTsUs = 1_000;
    const srcDecoder = src._decoder;

    main._handleDstSwitchFrame({ timestamp: 20_000_000 });

    expect(srcDecoder.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    expect(main.onSwitchResult).toHaveBeenCalledTimes(1);
    expect(main.onSwitchResult.mock.calls[0][0]).toBe(false);
    expect(main._switchContext).toBeNull();
    expect(main._switchPeerFlow).toBeNull();
  });

  it("does not adopt from a peer that is no longer active", async () => {
    const { main, src } = createSwitchPair();
    const mainDecoder = main._decoder;
    main._isShuttingDown = true; // finalizeSwitch posted the shutdown
    src._buffer = null; // peer released without notifying (defensive path)

    await main._handleDecoderMessage({ data: { type: "shutdownComplete" } });

    expect(mainDecoder.terminate).toHaveBeenCalledTimes(1);
    expect(main._decoder).toBeNull();
    expect(main._switchPeerFlow).toBeNull();
    expect(main._switchContext).toBeNull();
    expect(main.onSwitchResult).toHaveBeenCalledTimes(1);
    expect(main.onSwitchResult).toHaveBeenCalledWith(false, SWITCH_ABORT_MSG);
  });

  it("destroying the main flow clears the src peer without a report", () => {
    const { main, src } = createSwitchPair();

    main.destroy();

    expect(src._switchContext).toBeNull();
    expect(src._switchPeerFlow).toBeNull();
    expect(main.onSwitchResult).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/flow-audio.test.js -t "switch abort"`
Expected: FAIL — `onSwitchResult` never called on peer destroy; the src decoder-error test rejects with `TypeError: this._onSwitchResult is not a function`; the inactive-peer test adopts (`exportDecoder` path) or throws on `absorb`.

- [ ] **Step 3: Implement**

In `src/media/decoders/flow.js`:

`destroy()` — notify the peer before clearing the pointer (replace the single `this._switchPeerFlow = null;` line from Task 4):

```js
const peer = this._switchPeerFlow;
this._switchPeerFlow = null;
// a paired peer learns that this side of the switch is gone (§5)
if (peer && peer._switchPeerFlow === this) peer._onPeerDestroyed();
```

`decoderError` case:

```js
      case "decoderError":
        if (this._destroyed) break;
        if (this._switchContext?.src) {
          // the new rendition's decoder failed: destroying notifies the main
          // flow, which owns the switch result
          this.destroy();
          break;
        }
        this._onDecodingError(this._type);
        break;
```

`shutdownComplete` adoption (replace `if (this._switchPeerFlow) {` and add the guard):

```js
        if (this._switchPeerFlow && !this._switchPeerFlow.isActive()) {
          // the peer was released without telling us: nothing to adopt
          this._switchPeerFlow = null;
          this._switchContext = null;
          this._onSwitchResult?.(false, SWITCH_ABORT_MSG);
          break;
        }
        if (this._switchPeerFlow) {
          // ... unchanged adoption
```

`_handleDstSwitchFrame()` excessive gap — clear own pointers first:

```js
this._switchContext = null;
const peer = this._switchPeerFlow;
this._switchPeerFlow = null;
peer.destroy(); // sees our pointer is gone: no notification back
this._onSwitchResult(
  false,
  `Rendition switch isn't possible, because timestamps of renditions aren't in sync: the gap is approximately ${(absDiff / 1_000_000).toFixed(1)} seconds. Please check your ABR setup.`,
);
return;
```

New method next to `_startSwitch()`, and a module constant next to `SWITCH_THRESHOLD_US`:

```js
const SWITCH_ABORT_MSG =
  "Rendition switch aborted: the new rendition's decoder stopped";
```

```js
  // The other side of an in-progress switch was destroyed. Drop the switch
  // state; the main (dst) flow owns the result. Teardown is silent: the
  // playback state is already stopped when _resetPlayback() destroys flows.
  _onPeerDestroyed() {
    const wasDst = !!this._switchContext?.dst;
    this._switchContext = null;
    this._switchPeerFlow = null;
    if (wasDst && this._onSwitchResult && !this._state?.isStopped()) {
      this._onSwitchResult(false, SWITCH_ABORT_MSG);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/flow-audio.test.js tests/flow-video.test.js tests/nimio-live.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/media/decoders/flow.js tests/flow-audio.test.js
git add src/media/decoders/flow.js tests/flow-audio.test.js
```

---

### Task 6: Full verification and the single commit

- [ ] **Step 1: Full suite and formatting**

Run: `npx prettier --check src tests && npx vitest run`
Expected: prettier clean; all files pass (PR 1's 25 files plus `tests/playback-context.test.js` and `tests/sldp-manager-run.test.js`).

- [ ] **Step 2: Confirm the staged set**

Run: `git status --short`
Expected staged: `src/playback/context.js`, `src/sldp/manager.js`, `src/nimio-live.js`, `src/media/decoders/flow.js`, `tests/playback-context.test.js`, `tests/sldp-manager-run.test.js`, `tests/nimio-live.test.js`, `tests/flow-audio.test.js`. Nothing under `docs/`.

- [ ] **Step 3: Commit (the one code commit of this PR)**

```bash
git commit -F - <<'MSG'
Drop late decoder messages and stale SLDP replies after stop

Work started before a stop or destroy could still act on the media path:
a decoder message delivered after DecoderFlow.destroy() reached a released
buffer; an SLDP status reply for a run that was stopped applied streams and
requested playback; a rendition switch whose new flow died mid-switch left
the main flow with a stale peer, so later switches never started and a
finalizing main flow adopted a null worker.

- PlaybackContext.setStreams() computes into locals and commits in one step
  after the codec check; it resolves false when a newer call superseded it.
- SLDPManager: run token bumped by every stop and by the new destroy(); the
  status callback and _processStatus() drop a reply whose run is gone, also
  when a connection-established listener stops playback; setup timers are
  tracked and cancelled on stop/destroy; destroy() also clears keep-alive.
  NimioLive.destroy() calls it before destroying the transport.
- DecoderFlow: destroy() is idempotent; a frame or decoder error after
  destroy is dropped (frame closed); shutdownComplete on a destroyed flow
  adopts nothing; a frame whose start-ts handler was pending when the flow
  was destroyed, or whose handler threw, is closed.
- Switch abort: a destroyed flow notifies a paired peer, which drops its
  switch state; the main (dst) flow reports the failure once unless playback
  is already stopped. The src decoder-error path no longer calls a callback
  it does not have (which threw and skipped its own destroy); the main
  flow's excessive-gap path clears its pointers before destroying the peer;
  adoption requires an active peer.

Tests: PlaybackContext supersession, SLDP run token and timers, NimioLive
destroy order, flow after-destroy paths, switch abort paths.
MSG
```

- [ ] **Step 4: PR hand-off**

PR title: "Drop late decoder messages and stale SLDP replies after stop". Body
from the commit message plus: depends on PR 1 (worker termination); second of
the PRs replacing #92; PR 2b (live engine audio init, service hooks) and PR 3
(facade/UI) remain.

---

### Task 7 (review follow-ups, done): findings from the branch review and the maintainer-side review

- [x] `_onPeerDestroyed()` escalates to `onDecodingError(type)` when the main
      flow's input was already cancelled (`processChunk()`) or it already
      posted its own shutdown (`finalizeSwitch()`).
- [x] `PlaybackContext.cancelPendingStreams()`; the manager calls it on every
      stop and on `destroy()`, so a stop during the codec check commits
      nothing (real-context tests in `tests/sldp-manager-run.test.js` and
      `tests/playback-context.test.js`).
- [x] Status callback captures the run token before the sync-mode emit and
      re-checks after it.
- [x] Transport session: adapter numbers each `start`, worker hands it to the
      agent, agent tags every post, adapter drops stale tagged messages
      (`tests/transport-adapter.test.js`, `tests/transport-web-socket.test.js`,
      new `tests/sldp-agent.test.js`).
- [x] `_handleDecodedFrame()` post-await guard includes `_destroyed`;
      `flow-audio.js` / `flow-video.js` `_handleDecoderOutput()` return after
      the await when destroyed.
- [x] Worker lifecycle notifications (`connected`, `disconnect`) carry the
      socket's session; the adapter drops stale ones.
- [x] `_failSwitch(msg, lostDecoder)` is the single owner of a failed switch
      on the main flow; the gap abort recovers when the input was cancelled;
      the adoption guard escalates (no decoder left).
- [x] `_onAudioCodecDataReceived()` reports an incompatible-update failure
      only when the peer notification did not already (`_nextRenditionData`
      still set); new `tests/nimio-transport-switch.test.js`.
- [x] `SLDPManager.sessionReady` (false from `start()`/`destroy()`, true once
      a status committed); `attach()` reuses the socket only then, else it
      handshakes again (detach during the codec check cancels the commit).

## Self-review

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 3; §4 → Task 4; §5 → Task 5; Error handling → Task 4 (throwing handler) and Task 5 (`?.` on the callback, idempotent destroy); Testing list → Tasks 1–5; Delivery → Task 6.
- **Placeholder scan:** none; "unchanged" markers only elide code that stays byte-identical and is named.
- **Type consistency:** `_processStatus()` returns array or `null` (Task 2) and the callback tests `!streams`; `SWITCH_ABORT_MSG` identical in Task 5 code and tests; `_onPeerDestroyed()` named identically; `setStreams()` boolean in Task 1 consumed in Task 2.
- **Review Focus:** each line has its test in the named task.
