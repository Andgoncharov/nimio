# Live Engine After-Stop Guards and Service Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Asynchronous live-engine work started before a stop no longer acts afterwards, the engine unsubscribes everything it subscribed, the per-instance services release their timers, graph connections and pending loads on destroy, an uncommitted session is closed instead of kept alive on detach, and a next rendition orphaned by a main-track incompatible audio header is failed and cancelled.

**Architecture:** An audio initialisation generation counter, bumped by `_stopAudio()`, is captured before each await in `_initAudioProcessor()` and the first-audio-frame handler. Setup handlers return while stopped. The sync-mode handler is stored and removed in `destroy()`. `MetricsManager`, `AudioGraphController` and `VUMeterService` gain `destroy()`; `BaseMeter.dispose()` makes a pending worklet load inert. `detach()` branches on `sessionReady`; the main-track incompatible path fails a pending next rendition.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom, fake timers, controllable promises for worklet module loads.

**Spec:** `docs/superpowers/specs/2026-10-14-live-after-stop-guards-design.md`

## Global Constraints

- Branch `fix/live-after-stop-guards`, stacked on PR 2a's code branch `fix/media-after-stop-guards-pr` (`2e7a7da`). Do not touch the SLDP manager, the transport session or `DecoderFlow` beyond calling what PR 2a shipped.
- No facade (`src/nimio.js`) or UI changes (PR 3).
- Project rule: **one code commit at the end** (Task 7). Earlier tasks only `git add`. Spec/plan commits stay local.
- `npx prettier --check src tests` and `npx vitest run` must be clean before the commit.
- Engines in tests are built with `Object.create(NimioLive.prototype)` and the fields the method under test touches; see the fixture in each task.

## Review Focus

- `_initAudioProcessor()` cancelled by a stop **and restarted** before the old module load settles: the old continuation must not create a node on the new run → Task 1 test "init cancelled ... restarted".
- `_startNoAudioMode()` when no node exists yet (stream without audio at start): must still initialise the idle processor → Task 1 test "no-audio mode initialises when no node exists".
- `detach()` with `sessionReady === false` must not emit `nimio:playback-end` → Task 5 test asserts the bus saw no such emit.
- `VUMeterService.clear()` called twice, and a module failing after `clear()`: no error log, no re-init → Task 4 tests.
- Main-track incompatible header with `_nextRenditionData` set but no `decoderFlow` yet (setup not received): no throw, switch failed, stream cancelled → Task 6 test.

---

### Task 1: Audio initialisation generation, no-audio keeps the node, advertizer node capture

**Files:**

- Modify: `src/nimio-live.js` (constructor near line 88; `_onAudioStartTsNotSet()` lines 563–600; `_initAudioProcessor()` lines 733–826; `_stopAudio()` line 857)
- Modify: `src/nimio-transport.js` (`_sendPendingAdvertizerActions()` lines 41–56)
- Create: `tests/nimio-live-audio.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `this._audioInitGen` (number) on the engine; `_stopAudio()` increments it. Task 5 does not depend on it; Task 3 edits `destroy()` only.

- [ ] **Step 1: Write the failing tests**

Create `tests/nimio-live-audio.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NimioLive } from "@/nimio-live";

// A fake AudioWorkletNode that records every instance and whose port can
// capture message handlers (the sync clock registers one).
function installFakeNode(nodes, handlers = []) {
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      constructor(ctx) {
        if (!ctx) throw new TypeError("null audio context");
        nodes.push(this);
        this.port = {
          start: vi.fn(),
          postMessage: vi.fn(),
          addEventListener: (type, h) => handlers.push(h),
          removeEventListener: vi.fn(),
        };
      }
    },
  );
}

// Audio context whose worklet module load settles when the test says so.
function controllableContext(sampleRate = 48000) {
  const ctx = { sampleRate, audioWorklet: {} };
  ctx.audioWorklet.addModule = () =>
    new Promise((resolve, reject) => {
      ctx.settle = resolve;
      ctx.fail = reject;
    });
  return ctx;
}

// Minimal live engine: only what _initAudioProcessor(), _stopAudio(),
// _onAudioStartTsNotSet() and _sendPendingAdvertizerActions() touch.
function createAudioEngine(ctx) {
  const live = Object.create(NimioLive.prototype);
  live._logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
  live._config = {
    volumeId: "v",
    muted: false,
    latency: 0,
    latencyTolerance: 0,
    latencyAdjustMethod: "x",
    metricsOverlay: false,
    logLevel: 0,
    workletLogs: false,
    syncBuffer: 0,
  };
  live._audioInitGen = 0;
  live._audioContext = null;
  live._audioNode = null;
  live._audioWorkletReady = null;
  live._audioBuffer = null;
  live._noVideo = false;
  live._noAudio = false;
  live._audioCtrl = {
    initContext: vi.fn(() => ctx),
    initVolume: vi.fn(),
    reset: vi.fn(),
    connectSource: vi.fn(),
  };
  live._vuMeterSvc = { setAudioInfo: vi.fn(), isInitialized: () => false };
  live._workletLogReceiver = { add: vi.fn() };
  live._latencyCtrl = {};
  live._state = {
    isShared: () => true,
    isStopped: () => false,
    setPlaybackStartTsUs: vi.fn(),
  };
  live._advertizerEval = { hasPendingActions: () => false };
  live._syncModeParams = { inited: false };
  return live;
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("NimioLive audio initialisation after stop", () => {
  let nodes;

  beforeEach(() => {
    nodes = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("init cancelled by _stopAudio() resolves and creates no node", async () => {
    installFakeNode(nodes);
    const ctx = controllableContext();
    const live = createAudioEngine(ctx);

    const init = live._initAudioProcessor(48000, 2);
    live._stopAudio();
    ctx.settle();

    await expect(init).resolves.toBeUndefined();
    expect(nodes).toHaveLength(0);
    expect(live._audioCtrl.connectSource).not.toHaveBeenCalled();
  });

  it("init cancelled by a stop and restarted: the old load creates no node on the new run", async () => {
    installFakeNode(nodes);
    const oldCtx = controllableContext();
    const live = createAudioEngine(oldCtx);

    const oldInit = live._initAudioProcessor(48000, 2);
    live._stopAudio();
    const newCtx = controllableContext();
    live._audioCtrl.initContext = vi.fn(() => newCtx);
    const newInit = live._initAudioProcessor(48000, 2);
    oldCtx.settle();
    await flush();
    expect(nodes).toHaveLength(0); // the stale continuation did nothing
    newCtx.settle();
    await Promise.all([oldInit, newInit]);

    expect(nodes).toHaveLength(1);
    expect(live._audioNode).toBe(nodes[0]);
  });

  it("a module that fails after the stop logs no error", async () => {
    installFakeNode(nodes);
    const ctx = controllableContext();
    const live = createAudioEngine(ctx);

    const init = live._initAudioProcessor(48000, 2);
    live._stopAudio();
    ctx.fail(new Error("not found"));
    await init;

    expect(live._logger.error).not.toHaveBeenCalled();
  });

  it("a stale start-ts request after a stop and restart records nothing", async () => {
    installFakeNode(nodes);
    const ctx = controllableContext();
    const live = createAudioEngine(ctx);
    live._audioConfig = { sampleRate: 48000, numberOfChannels: 2 };
    live._firstAudioFrameTsUs = 0;
    live._firstVideoFrameTsUs = 0;
    live._noVideo = true;
    const frame = { sampleRate: 48000, numberOfChannels: 2, decTimestamp: 777 };

    const stale = live._onAudioStartTsNotSet(frame);
    live._stopAudio(); // playback stopped while the module was loading
    live._audioContext = ctx; // ...and restarted: a new context and node exist
    live._audioNode = { port: { postMessage: vi.fn() } };
    ctx.settle();

    await expect(stale).resolves.toBe(false);
    expect(live._firstAudioFrameTsUs).toBe(0);
    expect(live._state.setPlaybackStartTsUs).not.toHaveBeenCalled();
  });

  it("the sync-clock reply arriving after a stop touches no node", async () => {
    const handlers = [];
    installFakeNode(nodes, handlers);
    const ctx = controllableContext();
    const live = createAudioEngine(ctx);
    live._config.syncBuffer = 1;
    live._applySyncModeParams = vi.fn();

    const init = live._initAudioProcessor(48000, 2);
    ctx.settle();
    await flush();
    expect(handlers).toHaveLength(1); // the clock handshake is waiting
    const node = nodes[0];

    live._stopAudio(); // stop during the handshake
    for (let i = 0; i < 3; i++) {
      handlers[0]({
        data: {
          aux: true,
          type: "clock-reply",
          timeMainSend: 0,
          timeWorker: 0,
        },
      });
    }
    await init;

    expect(live._applySyncModeParams).not.toHaveBeenCalled();
    expect(live._audioNode).toBeNull();
    expect(node.port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sync-mode-params" }),
    );
  });

  it("no-audio mode keeps an existing node and context", async () => {
    const live = createAudioEngine(controllableContext());
    const node = { port: { postMessage: vi.fn() } };
    live._audioContext = { sampleRate: 44100 };
    live._audioNode = node;
    live._audioWorkletReady = Promise.resolve();

    await live._startNoAudioMode(); // e.g. after an audio decoder error

    expect(live._audioCtrl.initContext).not.toHaveBeenCalled();
    expect(live._audioNode).toBe(node);
    expect(live._audioContext.sampleRate).toBe(44100);
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: "audio-status",
      data: { enabled: false },
    });
  });

  it("no-audio mode initialises the idle processor when no node exists", async () => {
    installFakeNode(nodes);
    const ctx = controllableContext();
    const live = createAudioEngine(ctx);

    const start = live._startNoAudioMode();
    ctx.settle();
    await start;

    expect(nodes).toHaveLength(1);
    expect(live._audioNode).toBe(nodes[0]);
  });

  it("the advertizer eval-ready reply uses the node it was registered on", () => {
    const handlers = [];
    const node = {
      port: {
        postMessage: vi.fn(),
        addEventListener: (type, h) => handlers.push(h),
        removeEventListener: vi.fn(),
      },
    };
    const live = createAudioEngine(controllableContext());
    live._audioNode = node;
    live._advertizerEval = {
      hasPendingActions: () => true,
      pendingActions: [{ op: "rem" }],
      clearPendingActions: vi.fn(),
    };

    live._sendPendingAdvertizerActions();
    live._audioNode = null; // stopped before the processor replied

    expect(() =>
      handlers[0]({ data: "transp-discont-eval-ready" }),
    ).not.toThrow();
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: "transp-track-action",
      data: { op: "rem" },
    });
    expect(node.port.removeEventListener).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-audio.test.js`
Expected: FAIL — "cancelled" tests create a node (`nodes` length 1, `connectSource` called) or throw on the null context; the failing-module test logs an error; the stale start-ts test resolves `true`-ish or records a timestamp; the sync test applies params; no-audio-keeps-node calls `initContext`; the advertizer test throws `Cannot read properties of null (reading 'port')`. "no-audio mode initialises ... when no node exists" passes already (guard).

- [ ] **Step 3: Implement**

`src/nimio-live.js`, constructor, after `this._audioWorkletReady = null;`:

```js
this._audioInitGen = 0; // bumped by _stopAudio() to cancel a pending init
```

`_stopAudio()`, first line of the body:

```js
this._audioInitGen++;
```

`_initAudioProcessor()`:

```js
  async _initAudioProcessor(sampleRate, channels, idle) {
    // No-audio mode on top of an existing node: that node already drives the
    // playback clock and _setNoAudio() silenced it. Re-initialising would
    // close its context and freeze video.
    if (idle && this._audioNode) return;
    const gen = this._audioInitGen;
    this._logger.debug(
      `Initialize audio processor, sampleRate=${sampleRate}, channels=${channels}, idle=${idle}, audio context exists=${!!this._audioContext}`,
    );
    // ... unchanged context init ...
      // load processor
      this._audioWorkletReady = this._audioContext.audioWorklet
        .addModule(audioProcUrl)
        .catch((err) => {
          if (gen === this._audioInitGen) {
            this._logger.error("Audio worklet error", err);
          }
        });
    // ... unchanged ...
    await this._audioWorkletReady;
    if (gen !== this._audioInitGen) {
      // audio was stopped (or the engine destroyed) while the module loaded
      this._logger.debug("Audio processor initialization cancelled");
      return;
    }
    if (this._audioNode) return;
    // ... unchanged node creation ...
    if (this._config.syncBuffer > 0) {
      let smc = new SyncModeClock(this._audioNode.port);
      await smc.sync();
      if (gen !== this._audioInitGen) return; // stopped during the handshake
      this._applySyncModeParams();
    }
    // ... unchanged ...
  }
```

`_onAudioStartTsNotSet()`, replace the init await and the error check:

```js
// create AudioContext with correct sampleRate on first frame
const gen = this._audioInitGen;
await this._initAudioProcessor(frame.sampleRate, frame.numberOfChannels);
if (gen !== this._audioInitGen) {
  // playback was stopped (and maybe restarted) meanwhile: this frame
  // belongs to the old run and must not touch the new one's state
  return false;
}

if (!this._audioContext || !this._audioNode) {
  if (!this._state.isStopped()) {
    this._logger.error("Audio context is not initialized. Can't play audio.");
  }
  this._audioContext = this._audioNode = null;
  return false;
}
```

`src/nimio-transport.js`, `_sendPendingAdvertizerActions()`:

```js
  _sendPendingAdvertizerActions() {
    const node = this._audioNode; // the node may be replaced before the reply
    if (!node) return;
    if (this._advertizerEval.hasPendingActions()) {
      const hdlr = (event) => {
        if (event.data != "transp-discont-eval-ready") return;
        let pa = this._advertizerEval.pendingActions;
        for (let i = 0; i < pa.length; i++) {
          node.port.postMessage({
            type: "transp-track-action",
            data: pa[i],
          });
        }
        this._advertizerEval.clearPendingActions();
        node.port.removeEventListener("message", hdlr);
      };
      node.port.addEventListener("message", hdlr);
    }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-audio.test.js tests/nimio-live.test.js tests/nimio-live-attach.test.js tests/nimio-live-failover.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-live.js src/nimio-transport.js tests/nimio-live-audio.test.js
git add src/nimio-live.js src/nimio-transport.js tests/nimio-live-audio.test.js
```

---

### Task 2: Setups ignored while stopped

**Files:**

- Modify: `src/nimio-transport.js` (`_onVideoSetupReceived()` line 88, `_onAudioSetupReceived()` line 125)
- Test: `tests/nimio-live.test.js` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Append to `tests/nimio-live.test.js`:

```js
describe("NimioLive stream setups while stopped", () => {
  it("ignores video and audio setups received after stop()", () => {
    const live = Object.create(NimioLive.prototype);
    live._state = { isStopped: () => true };
    live._config = { hardwareAcceleration: "no-preference" };
    live._decoderFlows = { video: null, audio: null };
    live._nextRenditionData = null;
    live._createMainDecoderFlow = vi.fn();
    live._setNoVideo = vi.fn();
    live._startNoAudioMode = vi.fn();
    live.stop = vi.fn();

    live._onVideoSetupReceived({ trackId: 1, config: { codec: "avc1" } });
    live._onAudioSetupReceived({ trackId: 2, config: { codec: "mp4a.40.2" } });
    live._onAudioSetupReceived({ trackId: 2 }); // no-config branch

    expect(live._createMainDecoderFlow).not.toHaveBeenCalled();
    expect(live._setNoVideo).not.toHaveBeenCalled();
    expect(live._startNoAudioMode).not.toHaveBeenCalled();
    expect(live.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/nimio-live.test.js -t "setups while stopped"`
Expected: FAIL — `_createMainDecoderFlow` called (and the no-config branch calls `_startNoAudioMode`).

- [ ] **Step 3: Implement**

In `src/nimio-transport.js`, first line of each handler body:

```js
  _onVideoSetupReceived(data) {
    if (this._state.isStopped()) return; // late setup after stop()
    ...
  _onAudioSetupReceived(data) {
    if (this._state.isStopped()) return; // late setup after stop()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-transport.js tests/nimio-live.test.js
git add src/nimio-transport.js tests/nimio-live.test.js
```

---

### Task 3: Sync-mode listener removed on destroy

**Files:**

- Modify: `src/nimio-sync-mode.js` (`_createSyncModeParams()`)
- Modify: `src/nimio-live.js` (`destroy()`)
- Test: `tests/nimio-live.test.js` (extend the destroy-order `describe`)

- [ ] **Step 1: Write the failing test**

In `tests/nimio-live.test.js`, inside `describe("NimioLive.destroy() releases the transport worker")`, add:

```js
it("removes the sync-mode params listener it subscribed", () => {
  const live = Object.create(NimioLive.prototype);
  const bus = { on: vi.fn(), off: vi.fn() };
  live._eventBus = bus;
  live._createSyncModeParams();
  const handler = bus.on.mock.calls[0][1];
  expect(typeof handler).toBe("function");
  live.stop = vi.fn();
  live._removeUIEventHandlers = vi.fn();
  live._deinitTransport = vi.fn();
  live._reconnect = { destroy: vi.fn() };
  live._sldpManager = { destroy: vi.fn() };
  live._transport = { destroy: vi.fn() };

  live.destroy();

  expect(bus.off).toHaveBeenCalledWith("nimio:sync-mode-params", handler);
});

it("destroy without sync mode unsubscribes nothing extra", () => {
  const live = Object.create(NimioLive.prototype);
  const bus = { off: vi.fn() };
  live._eventBus = bus;
  live.stop = vi.fn();
  live._removeUIEventHandlers = vi.fn();
  live._deinitTransport = vi.fn();
  live._reconnect = { destroy: vi.fn() };
  live._sldpManager = { destroy: vi.fn() };
  live._transport = { destroy: vi.fn() };

  expect(() => live.destroy()).not.toThrow();
  expect(bus.off).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live.test.js -t "sync-mode"`
Expected: the first FAILS — `bus.off` not called with the handler (the handler is an anonymous closure today, so `off` is never called). The second passes already (guard).

- [ ] **Step 3: Implement**

`src/nimio-sync-mode.js`:

```js
  _createSyncModeParams() {
    this._syncModeParams = {};
    this._onSyncModeParams = (data) => {
      this._syncModeParams.playerTimeMs = data.playerTimeMs;
      this._syncModeParams.serverTimeMs = data.serverTimeMs;
    };
    this._eventBus.on("nimio:sync-mode-params", this._onSyncModeParams);
  },
```

`src/nimio-live.js`, `destroy()`:

```js
  destroy() {
    this.stop();
    this._removeUIEventHandlers();
    this._deinitTransport();
    if (this._onSyncModeParams) {
      this._eventBus.off("nimio:sync-mode-params", this._onSyncModeParams);
    }
    this._reconnect.destroy();
    // a status reply or setup timer of the stopped run must do nothing
    this._sldpManager.destroy();
    // last: the closing stop posted by stop() is processed by the worker
    // before the terminate request, so the server session ends cleanly
    this._transport.destroy();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live.test.js`
Expected: PASS (the existing destroy-order test still passes: its stub has no `_onSyncModeParams`).

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-sync-mode.js src/nimio-live.js tests/nimio-live.test.js
git add src/nimio-sync-mode.js src/nimio-live.js tests/nimio-live.test.js
```

---

### Task 4: Service release hooks (metrics, audio graph, VU meter)

**Files:**

- Modify: `src/metrics/manager.js`, `src/audio/graph-controller.js`, `src/vumeter/base.js`, `src/vumeter/audio-worklet.js`, `src/vumeter/service.js`
- Create: `tests/metrics-manager.test.js`, `tests/audio-graph-controller.test.js`, `tests/vumeter-service.test.js`

**Interfaces:**

- Produces: `MetricsManager.prototype.destroy()`, `AudioGraphController.prototype.destroy()`, `BaseMeter.prototype.dispose()`, `VUMeterService.prototype.destroy()`; `VUMeterService.clear()` disposes the meter.

- [ ] **Step 1: Write the failing tests**

`tests/metrics-manager.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetricsManager } from "@/metrics/manager";

describe("MetricsManager.destroy()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops every store's interval and forgets the stores", () => {
    const mgr = MetricsManager.getInstance("mm-destroy");
    mgr.add(1, "video");
    mgr.add(2, "audio");
    mgr.run(1);
    mgr.run(2);
    expect(vi.getTimerCount()).toBe(2);

    mgr.destroy();

    expect(vi.getTimerCount()).toBe(0);
    expect(mgr.getMetric(1)).toBeNull();
    expect(mgr.getMetric(2)).toBeNull();
    expect(() => mgr.destroy()).not.toThrow();
  });
});
```

`tests/audio-graph-controller.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { AudioGraphController } from "@/audio/graph-controller";

function fakeNode() {
  return { connect: vi.fn(), disconnect: vi.fn(), context: {} };
}

describe("AudioGraphController.destroy()", () => {
  it("disconnects the graph and forgets the source and nodes", () => {
    const ctrl = AudioGraphController.getInstance("agc-destroy");
    const src = fakeNode();
    const gain = fakeNode();
    ctrl.setSource(src);
    ctrl.appendNode(gain, { connectPrev: true });
    expect(src.connect).toHaveBeenCalledWith(gain);

    ctrl.destroy();

    expect(src.disconnect).toHaveBeenCalledWith(gain);
    expect(ctrl.canAcceptNode(src)).toBe(false);
    expect(ctrl.appendNode(fakeNode(), { connectPrev: true })).toBe(0);
  });
});
```

`tests/vumeter-service.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VUMeterService } from "@/vumeter/service";
import { AudioContextProvider } from "@/audio/context-provider";

let nodes;
let deferred;

class FakeAudioContext {
  constructor(opts) {
    this.sampleRate = opts.sampleRate;
    this.state = "running";
    this.destination = { maxChannelCount: 2, channelCount: 2 };
    this.audioWorklet = {
      addModule: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            deferred = { resolve, reject };
          }),
      ),
    };
    this.close = vi.fn(() => Promise.resolve());
  }
}

class FakeAudioWorkletNode {
  constructor() {
    this.port = { postMessage: vi.fn() };
    this.connect = vi.fn();
    this.disconnect = vi.fn();
    nodes.push(this);
  }
}

async function microtasks(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("VUMeterService.clear() with a pending worklet module", () => {
  let n = 0;
  let name;
  let error;

  beforeEach(() => {
    nodes = [];
    deferred = undefined;
    name = `vu-pending-${++n}`;
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    window.AudioContext = FakeAudioContext;
    AudioContextProvider.getInstance(name).init(48000);
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    error.mockRestore();
    vi.unstubAllGlobals();
    delete window.AudioContext;
  });

  function startMeter() {
    const svc = VUMeterService.getInstance(name);
    svc.init({ mode: "peak", type: "input", api: "AudioWorklet" }, () => {});
    svc.setAudioInfo({ sampleRate: 48000, channels: 2 });
    svc.start();
    expect(deferred).toBeDefined();
    return svc;
  }

  it("ignores a module that loads after clear()", async () => {
    const svc = startMeter();

    svc.clear();
    deferred.resolve();
    await microtasks();

    expect(nodes).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("ignores a module that fails after clear()", async () => {
    const svc = startMeter();

    svc.clear();
    deferred.reject(new Error("not found"));
    await microtasks();

    expect(nodes).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    expect(svc.isInitialized()).toBe(false); // no re-init by the error path
  });

  it("clear() twice and destroy() are safe", () => {
    const svc = startMeter();

    svc.clear();
    expect(() => svc.clear()).not.toThrow();
    expect(() => svc.destroy()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/metrics-manager.test.js tests/audio-graph-controller.test.js tests/vumeter-service.test.js`
Expected: FAIL — `mgr.destroy is not a function`, `ctrl.destroy is not a function`; the VU tests create a node after `clear()` (length 1) or log an error; `svc.destroy is not a function`. If `startMeter()` fails before the assertions (fake context shape), adjust the fakes until `deferred` is set; the behaviour under test starts at `clear()`.

- [ ] **Step 3: Implement**

`src/metrics/manager.js`, after `remove(id)`:

```js
  destroy() {
    for (const m of this._metrics.values()) m.destroy();
    this._metrics.clear();
  }
```

`src/audio/graph-controller.js`, after `dismantle()`:

```js
  destroy() {
    this.dismantle();
  }
```

`src/vumeter/base.js`, after `stop(removeUI)`:

```js
  // Final stop: a pending asynchronous setup (worklet module load) must
  // neither create a meter nor call back into the owner.
  dispose() {
    this._disposed = true;
    this.stop(true);
    this._readyCallback = undefined;
    this._errorCallback = undefined;
    this._updateCallback = undefined;
  }
```

`src/vumeter/audio-worklet.js`, first line of each of the three arrow handlers:

```js
  _onWorkletModuleAdded = () => {
    if (this._disposed) return;
    ...
  _onWorkletModuleNotFound = (error) => {
    if (this._disposed) return;
    ...
  _onWorkletModuleError = (error) => {
    if (this._disposed) return;
```

`src/vumeter/service.js`:

```js
  clear() {
    if (this._inst) {
      this._audGraphCtrl.removeNode(this._inst.node);
      this._inst.dispose(); // a pending worklet load must create no meter
    }
    this._settings = undefined;
    this._inst = undefined;
    this._started = false;
  }

  destroy() {
    this.clear();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/metrics-manager.test.js tests/audio-graph-controller.test.js tests/vumeter-service.test.js tests/service.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/metrics/manager.js src/audio/graph-controller.js src/vumeter/base.js src/vumeter/audio-worklet.js src/vumeter/service.js tests/metrics-manager.test.js tests/audio-graph-controller.test.js tests/vumeter-service.test.js
git add src/metrics/manager.js src/audio/graph-controller.js src/vumeter/base.js src/vumeter/audio-worklet.js src/vumeter/service.js tests/metrics-manager.test.js tests/audio-graph-controller.test.js tests/vumeter-service.test.js
```

---

### Task 5: `detach()` closes an uncommitted session

**Files:**

- Modify: `src/nimio-live.js` (`detach()` lines 249–268)
- Test: `tests/nimio-live.test.js` (append a `describe`)

**Interfaces:**

- Consumes: `SLDPManager.sessionReady`, `keepAliveConnection()`, `stop({ closeConnection })` from PR 2a / PR 90.

- [ ] **Step 1: Write the failing tests**

Append to `tests/nimio-live.test.js`:

```js
describe("NimioLive.detach() and the kept-alive session", () => {
  function createDetachable(sessionReady) {
    const live = Object.create(NimioLive.prototype);
    live._ui = {};
    live._context = { setState: vi.fn() };
    live._state = { value: "playing" };
    live.stop = vi.fn();
    live._detachUI = vi.fn();
    live._eventBus = { emit: vi.fn() };
    live._sldpManager = {
      sessionReady,
      keepAliveConnection: vi.fn(),
      stop: vi.fn(),
    };
    return live;
  }

  it("keeps a committed session alive", () => {
    const live = createDetachable(true);

    expect(live.detach()).toBe(true);

    expect(live.stop).toHaveBeenCalledWith({ keepConnection: true });
    expect(live._sldpManager.keepAliveConnection).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.stop).not.toHaveBeenCalled();
  });

  it("closes a session that never committed instead of keeping it alive", () => {
    const live = createDetachable(false);

    expect(live.detach()).toBe(true);

    expect(live.stop).toHaveBeenCalledWith({ keepConnection: true });
    expect(live._sldpManager.keepAliveConnection).not.toHaveBeenCalled();
    expect(live._sldpManager.stop).toHaveBeenCalledWith({
      closeConnection: true,
    });
    expect(live._eventBus.emit).not.toHaveBeenCalledWith(
      "nimio:playback-end",
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live.test.js -t "kept-alive session"`
Expected: the second FAILS — `keepAliveConnection` called, `sldpManager.stop` not called. The first passes already (guard).

- [ ] **Step 3: Implement**

`src/nimio-live.js`, `detach()`:

```js
this._context.setState(this._state.value, false);
this.stop({ keepConnection: true });
if (this._sldpManager.sessionReady) {
  // the session has stream metadata: keep it for a later attach()
  this._sldpManager.keepAliveConnection();
} else {
  // nothing to reuse (attach() would handshake anyway): close it now
  this._sldpManager.stop({ closeConnection: true });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live.test.js tests/nimio-live-failover.test.js tests/sldp-manager.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-live.js tests/nimio-live.test.js
git add src/nimio-live.js tests/nimio-live.test.js
```

---

### Task 6: Main-track incompatible header fails a pending next rendition

**Files:**

- Modify: `src/nimio-transport.js` (`_onAudioCodecDataReceived()`, main-track `else` branch around lines 221–226)
- Test: `tests/nimio-transport-switch.test.js` (append a `describe`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/nimio-transport-switch.test.js` (reuse `createFlowWithWorker` and the mocked `AudioConfig`; `createEngine` sets `_nextRenditionData` for track 5 and the main flow for track 7):

```js
// Main-track header update that the existing audio output cannot accept.
function createMainTrackEngine({ paired, nextFlowExists = true }) {
  const { live, main, next } = createEngine({ paired });
  live._audioBuffer = { reset: vi.fn() }; // an audio output already exists
  live._context = { resetCurrentStream: vi.fn() };
  if (!nextFlowExists) live._nextRenditionData.decoderFlow = undefined;
  return { live, main, next };
}

const mainCodecData = { trackId: 7, data: new Uint8Array(2), family: "aac" };

describe("incompatible audio config update on the main track", () => {
  it("with a paired next rendition: fails the switch once and cancels both streams", () => {
    const { live, main, next } = createMainTrackEngine({ paired: true });

    expect(() => live._onAudioCodecDataReceived(mainCodecData)).not.toThrow();

    expect(main._decoder.postMessage).toHaveBeenCalledWith({
      type: "shutdown",
    });
    expect(next._decoder.postMessage).toHaveBeenCalledWith({
      type: "shutdown",
    });
    expect(live._decoderFlows.audio).toBeNull();
    expect(live._nextRenditionData).toBeNull();
    expect(live._onRenditionSwitchResult).toHaveBeenCalledTimes(1);
    expect(live._onRenditionSwitchResult).toHaveBeenCalledWith("audio", false);
    expect(live._sldpManager.cancelStream).toHaveBeenCalledWith(7);
    expect(live._sldpManager.cancelStream).toHaveBeenCalledWith(5);
  });

  it("with a pending next rendition whose setup has not arrived: fails it without throwing", () => {
    const { live } = createMainTrackEngine({
      paired: false,
      nextFlowExists: false,
    });

    expect(() => live._onAudioCodecDataReceived(mainCodecData)).not.toThrow();

    expect(live._nextRenditionData).toBeNull();
    expect(live._onRenditionSwitchResult).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.cancelStream).toHaveBeenCalledWith(5);
  });

  it("without a pending rendition: only the main stream is torn down", () => {
    const { live } = createMainTrackEngine({ paired: false });
    live._nextRenditionData = null;

    live._onAudioCodecDataReceived(mainCodecData);

    expect(live._onRenditionSwitchResult).not.toHaveBeenCalled();
    expect(live._sldpManager.cancelStream).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.cancelStream).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-transport-switch.test.js -t "main track"`
Expected: the first two FAIL — `_nextRenditionData` still set, `_onRenditionSwitchResult` not called. The third passes already (guard).

- [ ] **Step 3: Implement**

`src/nimio-transport.js`, in `_onAudioCodecDataReceived()`, replace the main-track `else` block:

```js
      } else {
        this._decoderFlows["audio"].destroy();
        this._decoderFlows["audio"] = null;
        this._sldpManager.cancelStream(data.trackId);
        this._context.resetCurrentStream("audio");
        if (this._nextRenditionData) {
          // the main flow's destroy already unpaired the next flow; without
          // a main flow the switch can never finalize, so fail it now
          const next = this._nextRenditionData;
          next.decoderFlow?.destroy();
          this._sldpManager.cancelStream(next.trackId);
          this._onRenditionSwitchResult("audio", false);
        }
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-transport-switch.test.js tests/flow-audio.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-transport.js tests/nimio-transport-switch.test.js
git add src/nimio-transport.js tests/nimio-transport-switch.test.js
```

---

### Task 7: Full verification and the single commit

- [ ] **Step 1: Full suite and formatting**

Run: `npx prettier --check src tests && npx vitest run`
Expected: prettier clean; all files pass (PR 2a's 29 plus `tests/nimio-live-audio.test.js`, `tests/metrics-manager.test.js`, `tests/audio-graph-controller.test.js`, `tests/vumeter-service.test.js`).

- [ ] **Step 2: Confirm the staged set**

Run: `git status --short`
Expected staged: `src/nimio-live.js`, `src/nimio-transport.js`, `src/nimio-sync-mode.js`, `src/metrics/manager.js`, `src/audio/graph-controller.js`, `src/vumeter/base.js`, `src/vumeter/audio-worklet.js`, `src/vumeter/service.js`, `tests/nimio-live-audio.test.js`, `tests/nimio-live.test.js`, `tests/nimio-transport-switch.test.js`, `tests/metrics-manager.test.js`, `tests/audio-graph-controller.test.js`, `tests/vumeter-service.test.js`. Nothing under `docs/`.

- [ ] **Step 3: Commit (the one code commit of this PR)**

```bash
git commit -F - <<'MSG'
Guard the live engine after stop and release its services on destroy

Asynchronous work of the live engine started before a stop could still act
afterwards, the engine left a listener behind on destroy, and three
per-instance services kept timers, graph connections or a pending worklet
load after the player was released.

- Audio initialisation generation: _stopAudio() bumps it; _initAudioProcessor()
  and the first-audio-frame handler return quietly when it changed, so a
  worklet module or sync-clock handshake that completes after a stop creates
  no node and records no timestamps. A failed load after a stop logs nothing.
- No-audio mode on top of an existing node keeps that node: it drives the
  playback clock and _setNoAudio() already silenced it. Re-initialising
  closed the running context and froze video.
- The advertizer eval-ready handler posts to the node it registered on.
- Video and audio setups received while stopped are ignored, as codec data
  already was.
- The nimio:sync-mode-params handler is stored and removed in destroy().
- MetricsManager.destroy() stops every store's interval;
  AudioGraphController.destroy() dismantles the graph; VUMeterService.clear()
  disposes the meter so a worklet module still loading creates nothing and
  calls nobody back, and the service gains destroy() for releaseInstances().
- detach() keeps a session alive only when its status committed
  (sessionReady); otherwise it closes it through the manager, since attach()
  would handshake again anyway.
- An incompatible main-track audio header mid-switch also destroys the
  pending next flow, cancels its stream and fails the switch, so ABR is not
  left in progress forever.

Tests: audio init cancelled, cancelled-and-restarted, failed after stop,
stale start-ts, sync reply after stop, no-audio keeps node, advertizer node;
setups while stopped; sync-mode listener removal; detach keep-alive vs close;
main-track incompatible update with and without a pending rendition;
MetricsManager, AudioGraphController and VUMeterService release.
MSG
```

- [ ] **Step 4: PR hand-off**

PR title: "Guard the live engine after stop and release its services on destroy". Depends on PR 2a and PR 1. PR 3 (facade and UI) remains.

---

## Self-review

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 3; §4 → Task 4; §5 → Task 5; §6 → Task 6; Error handling → Task 1 (no error log after stop), Task 4 (disposed callbacks, idempotent destroy); Testing → Tasks 1–6; Delivery → Task 7.
- **Placeholder scan:** none; "unchanged" only elides code that stays byte-identical and is named.
- **Type consistency:** `_audioInitGen` named identically across Task 1 code, fixture and spec; `sessionReady`, `keepAliveConnection()`, `stop({ closeConnection })` match PR 2a / PR 90; `dispose()` on `BaseMeter` is what `VUMeterService.clear()` calls; `_onSyncModeParams` identical in Task 3 code and test.
- **Review Focus:** each line has its test in the named task.
