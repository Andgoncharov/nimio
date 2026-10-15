# Live Engine After Destroy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A destroyed `NimioLive` is inert: public methods are no-ops, listeners that destroy or stop the player from `nimio:play`, `nimio:connection-started` or `nimio:playback-start` leave nothing running, the autoplay timers die with the engine, a failed constructor releases its transport worker; plus three leak fixes found alongside (reconnect after detach, late audio header for a dropped main flow, native PiP grant after cleanup, VU meter loop per resize).

**Architecture:** A `_destroyed` flag on the engine, set first in `destroy()` and by `_rollbackInit()`, gates `play()`, `pause()`, `attach()` and the render loop; every emit that an application listener can answer by stopping or destroying the player is followed by a `_destroyed || _state.isStopped()` re-check. The first-frame emit moves into `_startPlaybackOutput(frame)` so the popped frame is closed on that path. Autoplay timers are tracked. The constructor body moves into `_init()` under a try; `_rollbackInit()` runs isolated cleanup steps through `runCleanupSteps()`. The PiP mixin reuses `_pipRequestGen` for the native path; the meter UI gets a `_drawGen`.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom (`npx vitest run`), vitest browser config (`npm run test:browser`).

**Spec:** `docs/superpowers/specs/2026-10-14-live-after-destroy-design.md`

> **Post-review note:** the spec was revised after the branch review and
> supersedes this plan where they differ: `attach()` returns `false` only
> when a listener destroyed the player (a stopping listener leaves it
> attached and stopped); a playback generation (`_playGen`,
> `_isInterrupted()`, `_startRenderLoop()`) replaces the plain state
> re-checks and gives each render loop an identity; `setParameters()` and
> `setCurrentRendition()` are guarded, the latter also after its emit and
> at entry on a stopped engine. The PR 92 coverage check (spec section 8)
> added `src/media/decoders/flow.js` (isolated destroy steps),
> `src/nimio-renditions.js`, README text and three test files beyond the
> Global Constraints below.

## Global Constraints

- Branch `fix/live-after-destroy`, stacked on PR 3a's code branch `fix/lifecycle-hardening-pr` (`1ac05c2`). Only `src/nimio-live.js`, `src/nimio-transport.js`, `src/ui/ui-pip.js`, `src/vumeter/ui.js` and tests change. No facade, SLDP manager, decoder flow or service registry changes.
- Project rule: **one code commit at the end** (Task 8). Earlier tasks only `git add`. Spec/plan commits stay local; the code-only PR branch `fix/live-after-destroy-pr` is cut afterwards.
- `npx prettier --check src tests` and `npx vitest run` must be clean before the commit; `npm run test:browser` must be clean too (UI and meter suites run there).
- Engines in tests are built with `Object.create(NimioLive.prototype)` and only the collaborators the method under test touches; `vi.spyOn` on service-registry instances is not possible (their `constructor` is nulled), override methods directly.
- `_renderVideoFrame()` keeps returning `true` on its early exits (current behaviour); the only new return value is `false` when the first frame was closed instead of drawn.

## Review Focus

- `play()` from a `nimio:play` listener that stops the player while the engine was paused (not an initial play): no `resume()` on the audio context → Task 1 test "a nimio:play listener that stops the player prevents the resume".
- `attach()` with `params.pbError` on a destroyed engine: must return `false` before touching the UI → Task 1 test "attach on a destroyed engine".
- `_startPlaybackOutput()` when the listener throws AND stopped the player before throwing: the frame is closed, nothing drawn → Task 2 test "a throwing listener that also stopped the player".
- `_rollbackInit()` when the throw happened before `_initTransport()`: no transport, no reconnector, no SLDP manager; must not throw itself → Task 4 test "rollback before the transport exists".
- `_cleanupPip()` when `document.exitPictureInPicture()` rejects (no element in PiP by the time it runs): the rejection is swallowed and cleanup continues → Task 6 test "cleanup tolerates an exit rejection".

---

### Task 1: Destroyed flag, idempotent destroy, guards in `play()`, `pause()`, `attach()`

**Files:**

- Modify: `src/nimio-live.js` (`play()` ~120, `pause()` ~146, `attach()` ~193, `destroy()` ~298)
- Create: `tests/nimio-live-after-destroy.test.js`

**Interfaces:**

- Produces: `this._destroyed` (boolean, set in `destroy()` first; Task 4's `_rollbackInit()` also sets it; Task 2's render loop reads it). `attach()` returns `false` when a `nimio:connection-started` listener destroyed or stopped the engine.

- [ ] **Step 1: Write the failing tests**

Create `tests/nimio-live-after-destroy.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NimioLive } from "@/nimio-live";
import { MODE } from "@/shared/values";

// A live engine with the real play(), pause(), attach() and destroy() and
// every collaborator those touch stubbed. `stopped` mirrors what a stop()
// from an application listener does to the state.
function createEngine() {
  const live = Object.create(NimioLive.prototype);
  const flags = { stopped: false, paused: false };
  live._instName = "Guards";
  live._config = { streamUrl: "wss://example.test/live", startOffset: 0 };
  live._logger = { error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  live._state = {
    start: vi.fn(() => (flags.stopped = false)),
    stop: vi.fn(() => (flags.stopped = true)),
    pause: vi.fn(() => (flags.paused = true)),
    isPlaying: () => false,
    isPaused: () => flags.paused,
    isStopped: () => flags.stopped,
  };
  live._latencyCtrl = { start: vi.fn(), pause: vi.fn() };
  live._isAutoAbr = () => false;
  live._cancelPauseTimeout = vi.fn();
  live._eventBus = { emit: vi.fn() };
  live._sldpManager = {
    start: vi.fn(),
    requestCurrentStreams: vi.fn(),
    sessionReady: false,
    destroy: vi.fn(),
  };
  live._transport = { connected: false, destroy: vi.fn() };
  live._debugView = { start: vi.fn(), stop: vi.fn() };
  live._renderVideoFrame = () => {};
  live._audioCtxProvider = {
    isSuspended: () => true,
    get: () => ({ resume: vi.fn() }),
  };
  live._reconnect = { stop: vi.fn(), destroy: vi.fn(), reset: vi.fn() };
  live._attachUI = vi.fn();
  // destroy() stages
  live.stop = vi.fn(() => (flags.stopped = true));
  live._decoderFlows = { video: null, audio: null };
  live._nextRenditionData = null;
  live._autoplayTimers = [];
  live._stopAudio = vi.fn();
  live._removeUIEventHandlers = vi.fn();
  live._deinitTransport = vi.fn();
  return { live, flags };
}

describe("NimioLive after destroy()", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("destroy() twice runs the stages once", () => {
    const { live } = createEngine();

    live.destroy();
    live.destroy();

    expect(live._destroyed).toBe(true);
    expect(live.stop).toHaveBeenCalledTimes(1);
    expect(live._transport.destroy).toHaveBeenCalledTimes(1);
  });

  it("play() on a destroyed engine does nothing", () => {
    const { live } = createEngine();
    live.destroy();

    live.play();

    expect(live._state.start).not.toHaveBeenCalled();
    expect(live._eventBus.emit).not.toHaveBeenCalled();
    expect(live._sldpManager.start).not.toHaveBeenCalled();
  });

  it("pause() on a destroyed engine does nothing", () => {
    const { live } = createEngine();
    live.destroy();

    live.pause();

    expect(live._state.pause).not.toHaveBeenCalled();
    expect(live._latencyCtrl.pause).not.toHaveBeenCalled();
  });

  it("attach() on a destroyed engine returns false without touching the UI", () => {
    const { live } = createEngine();
    live.destroy();
    const callback = vi.fn();

    expect(live.attach({}, { latency: 0, pbError: true }, callback)).toBe(
      false,
    );

    expect(live._attachUI).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("NimioLive.play() with a listener that ends playback", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a nimio:play listener that destroys the player prevents the connection start", () => {
    const { live } = createEngine();
    live._eventBus.emit = vi.fn((name) => {
      if (name === "nimio:play") live.destroy();
    });

    live.play();

    expect(live._eventBus.emit).toHaveBeenCalledWith("nimio:play", {
      mode: MODE.LIVE,
    });
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(live._sldpManager.start).not.toHaveBeenCalled();
    expect(live._debugView.start).not.toHaveBeenCalled();
  });

  it("a nimio:play listener that stops the player prevents the connection start", () => {
    const { live, flags } = createEngine();
    live._eventBus.emit = vi.fn((name) => {
      if (name === "nimio:play") flags.stopped = true;
    });

    live.play();

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(live._sldpManager.start).not.toHaveBeenCalled();
    expect(live._debugView.start).not.toHaveBeenCalled();
  });

  it("a nimio:play listener that stops the player prevents the resume", () => {
    const { live, flags } = createEngine();
    flags.paused = true; // play() after pause(): not an initial play
    const ctx = { resume: vi.fn() };
    live._audioCtxProvider = { isSuspended: () => true, get: () => ctx };
    live._eventBus.emit = vi.fn((name) => {
      if (name === "nimio:play") flags.stopped = true;
    });

    live.play();

    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("a nimio:connection-started listener that stops the player prevents the overlay start", () => {
    const { live, flags } = createEngine();
    // SLDPManager.start() emits nimio:connection-started synchronously
    live._sldpManager.start = vi.fn(() => (flags.stopped = true));

    live.play();

    expect(live._sldpManager.start).toHaveBeenCalledTimes(1);
    expect(live._debugView.start).not.toHaveBeenCalled();
  });

  it("without such a listener play() starts the overlay as before", () => {
    const { live } = createEngine();

    live.play();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.start).toHaveBeenCalledWith(
      "wss://example.test/live",
      0,
    );
    expect(live._debugView.start).toHaveBeenCalledTimes(1);
  });
});

describe("NimioLive.attach() with a listener that ends playback", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a nimio:connection-started listener that stops the player leaves the engine attached and stopped", () => {
    // like the pbError path: attached-and-stopped is a legitimate outcome the
    // application asked for; returning false would make the facade believe
    // the engine never took the UI, leaving it un-attachable afterwards
    const { live, flags } = createEngine();
    delete live._attachUI; // the real one: records the UI
    const ui = { toggleMode: vi.fn(), setDetached: vi.fn() };
    live._sldpManager.start = vi.fn(() => (flags.stopped = true));
    const callback = vi.fn();

    expect(live.attach(ui, { latency: 0 }, callback)).toBe(true);

    expect(live._ui).toBe(ui);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(live._debugView.start).not.toHaveBeenCalled();
    expect(live.attach(ui, { latency: 0 })).toBe(false); // already attached
  });

  it("a nimio:connection-started listener that destroys the player makes attach() return false", () => {
    const { live } = createEngine();
    live._sldpManager.start = vi.fn(() => live.destroy());

    expect(live.attach({}, { latency: 0 })).toBe(false);

    expect(live._debugView.start).not.toHaveBeenCalled();
  });

  it("without such a listener attach() returns true and starts the overlay", () => {
    const { live } = createEngine();
    const callback = vi.fn();

    expect(live.attach({}, { latency: 0 }, callback)).toBe(true);

    expect(live._debugView.start).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js`
Expected: FAIL. "destroy() twice" fails on `stop` called twice; the "destroyed engine" tests fail because `play()`/`pause()`/`attach()` still act; the listener tests fail on `start`/`debugView.start`/`requestAnimationFrame` being called and on `attach()` returning `true`. ("without such a listener" tests pass already.) Note: `destroy()` on the fixture needs `_cancelAutoplay()` only after Task 3; until then the stub list above is complete for the current `_releaseMediaResources()`.

- [ ] **Step 3: Implement the flag and guards**

In `src/nimio-live.js`:

`play()`:

```js
  play() {
    if (this._destroyed || this._state.isPlaying()) return;

    const initialPlay = !this._state.isPaused();
    this._cancelPauseTimeout();

    this._state.start();
    this._latencyCtrl.start();
    if (this._isAutoAbr()) {
      this._startAbrController();
    }
    this._eventBus.emit("nimio:play", { mode: MODE.LIVE });
    // a listener may have destroyed or stopped the player
    if (this._destroyed || this._state.isStopped()) return;

    this._playbackStarted = false;
    requestAnimationFrame(this._renderVideoFrame);

    if (initialPlay) {
      this._sldpManager.start(this._config.streamUrl, this._config.startOffset);
      // start() emits nimio:connection-started: same possibility
      if (this._destroyed || this._state.isStopped()) return;
      if (this._debugView) {
        this._debugView.start();
      }
    } else if (this._audioCtxProvider.isSuspended()) {
      this._audioCtxProvider.get().resume();
    }
  }
```

`pause()`: change the first line to `if (this._destroyed || this._state.isPaused()) return;`.

`attach()`: change the first line to `if (this._ui || this._destroyed) return false;` and replace the tail after the start/requestCurrentStreams ternary with:

```js
// start() emits nimio:connection-started; a listener may have destroyed
// or stopped the player, in which case the attach did not take
if (this._destroyed || this._state.isStopped()) return false;
if (this._debugView) this._debugView.start();
if (callback) callback();
return true;
```

`destroy()`: insert at the top, before the `runCleanupSteps` call:

```js
if (this._destroyed) return; // the facade and a rollback may both call it
this._destroyed = true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js tests/nimio-live-attach.test.js`
Expected: PASS, all tests in the three files.

- [ ] **Step 5: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-after-destroy.test.js
```

---

### Task 2: First-frame output helper and the render loop guard

**Files:**

- Modify: `src/nimio-live.js` (`_renderVideoFrame()` ~460)
- Create: `tests/nimio-live-render.test.js`

**Interfaces:**

- Consumes: `this._destroyed` from Task 1.
- Produces: `_startPlaybackOutput(frame) → boolean` (true: continue drawing; false: frame closed, stop).

- [ ] **Step 1: Write the failing tests**

Create `tests/nimio-live-render.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NimioLive } from "@/nimio-live";
import { MODE } from "@/shared/values";

// The render loop's first drawn frame emits nimio:playback-start. An
// application listener may stop or destroy the player from there, or throw;
// the popped frame must still be closed and nothing must touch a cleared UI.
function createRenderer() {
  const live = Object.create(NimioLive.prototype);
  const flags = { stopped: false };
  const frame = { close: vi.fn() };
  live._logger = { error: vi.fn(), debug: vi.fn() };
  live._noVideo = false;
  live._state = {
    isPlaying: () => !flags.stopped,
    isStopped: () => flags.stopped,
  };
  live._audioWorkletReady = true;
  live._playbackStartTsUs = 1;
  live._speed = 1;
  live._audioCtxProvider = { isSuspended: () => true };
  live._latencyCtrl = {
    incCurrentVideoTime: () => 1000,
    isPending: () => false,
  };
  live._updateBufferLevelMetrics = vi.fn();
  live._videoBuffer = { popFrameForTime: () => frame };
  live._playbackStarted = false;
  live._eventBus = { emit: vi.fn() };
  live._grabber = {
    start: vi.fn(),
    isNeedFrame: () => false,
    handleLiveFrame: vi.fn(),
  };
  live._offscreenCanvas = false;
  live._ui = { drawFrame: vi.fn() };
  return { live, flags, frame };
}

describe("NimioLive first rendered frame", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits nimio:playback-start, starts the grabber once and draws the frame", () => {
    const { live, frame } = createRenderer();

    live._renderVideoFrame();
    live._renderVideoFrame();

    expect(live._eventBus.emit).toHaveBeenCalledTimes(1);
    expect(live._eventBus.emit).toHaveBeenCalledWith("nimio:playback-start", {
      mode: MODE.LIVE,
    });
    expect(live._grabber.start).toHaveBeenCalledTimes(1);
    expect(live._grabber.start).toHaveBeenCalledWith(MODE.LIVE);
    expect(live._ui.drawFrame).toHaveBeenCalledTimes(2);
    expect(frame.close).toHaveBeenCalledTimes(2);
  });

  it("a listener that destroys the player: the frame is closed, nothing drawn, no grabber", () => {
    const { live, flags, frame } = createRenderer();
    live._eventBus.emit = vi.fn(() => {
      live._destroyed = true; // what destroy() does first
      flags.stopped = true;
    });

    expect(live._renderVideoFrame()).toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(live._ui.drawFrame).not.toHaveBeenCalled();
    expect(live._grabber.start).not.toHaveBeenCalled();
  });

  it("a listener that stops the player: the frame is closed, nothing drawn, no grabber", () => {
    const { live, flags, frame } = createRenderer();
    live._eventBus.emit = vi.fn(() => (flags.stopped = true));

    expect(live._renderVideoFrame()).toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(live._ui.drawFrame).not.toHaveBeenCalled();
    expect(live._grabber.start).not.toHaveBeenCalled();
  });

  it("a throwing listener is logged and the frame is still drawn and closed", () => {
    const { live, frame } = createRenderer();
    live._eventBus.emit = vi.fn(() => {
      throw new Error("listener boom");
    });

    expect(() => live._renderVideoFrame()).not.toThrow();

    expect(live._logger.error).toHaveBeenCalledTimes(1);
    expect(live._logger.error.mock.calls[0][1].message).toBe("listener boom");
    expect(live._ui.drawFrame).toHaveBeenCalledTimes(1);
    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(live._grabber.start).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener that also stopped the player: the frame is closed, nothing drawn", () => {
    const { live, flags, frame } = createRenderer();
    live._eventBus.emit = vi.fn(() => {
      flags.stopped = true;
      throw new Error("listener boom");
    });

    expect(live._renderVideoFrame()).toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(live._ui.drawFrame).not.toHaveBeenCalled();
  });

  it("the loop ends on a destroyed engine without scheduling another frame", () => {
    const { live } = createRenderer();
    live._destroyed = true;

    expect(live._renderVideoFrame()).toBe(true);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(live._ui.drawFrame).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-render.test.js`
Expected: FAIL. The listener tests fail on `drawFrame` being called (or on `frame.close` count 0 for the throwing cases: the throw escapes `_renderVideoFrame`); the "destroyed engine" test fails on `drawFrame` being called. The first test passes already.

- [ ] **Step 3: Implement the helper and the guard**

In `src/nimio-live.js`, `_renderVideoFrame()`: change the first line to

```js
if (this._destroyed || this._noVideo || !this._state.isPlaying()) return true;
```

and replace the block

```js
if (!this._playbackStarted) {
  this._eventBus.emit("nimio:playback-start", { mode: MODE.LIVE });
  this._playbackStarted = true;
  this._grabber?.start(MODE.LIVE);
}
```

with

```js
if (!this._playbackStarted && !this._startPlaybackOutput(frame)) {
  return false;
}
```

Add the helper right after `_renderVideoFrame()`:

```js
  // First rendered frame: notify the application, then start the grabber.
  // Returns false (and closes the frame) when a listener destroyed or stopped
  // the player meanwhile: the buffer the frame came from is already cleared.
  _startPlaybackOutput(frame) {
    this._playbackStarted = true;
    try {
      this._eventBus.emit("nimio:playback-start", { mode: MODE.LIVE });
    } catch (err) {
      // an application listener failed; the popped frame must still be
      // handled below
      this._logger.error("nimio:playback-start listener failed", err);
    }
    if (this._destroyed || this._state.isStopped()) {
      frame.close();
      return false;
    }
    this._grabber?.start(MODE.LIVE);
    return true;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-render.test.js tests/nimio-live-after-destroy.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-render.test.js
```

---

### Task 3: Autoplay timers and the reconnector on detach

**Files:**

- Modify: `src/nimio-live.js` (constructor autoplay block ~106, `detach()` ~250, `_releaseMediaResources()` ~666)
- Modify: `tests/nimio-live-after-destroy.test.js` (append)
- Modify: `tests/nimio-live.test.js` (`createDetachable()` fixture ~377 and a new test)

**Interfaces:**

- Produces: `_scheduleAutoplay()`, `_cancelAutoplay()`, `this._autoplayTimers` (array). Task 4's `_rollbackInit()` consumes `_cancelAutoplay()`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/nimio-live-after-destroy.test.js`:

```js
describe("NimioLive autoplay timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fire play and hide the controls when nothing cancels them", () => {
    const { live } = createEngine();
    live._playCb = vi.fn();
    live._ui = { hideControls: vi.fn() };

    live._scheduleAutoplay();
    vi.advanceTimersByTime(1000);

    expect(live._playCb).toHaveBeenCalledTimes(1);
    expect(live._ui.hideControls).toHaveBeenCalledWith(true);
  });

  it("are cancelled by destroy()", () => {
    const { live } = createEngine();
    live._playCb = vi.fn();
    live._ui = { hideControls: vi.fn() };

    live._scheduleAutoplay();
    live.destroy();
    vi.advanceTimersByTime(1000);

    expect(live._playCb).not.toHaveBeenCalled();
    expect(live._ui.hideControls).not.toHaveBeenCalled();
    expect(live._autoplayTimers).toEqual([]);
  });
});
```

In `tests/nimio-live.test.js`, add `live._reconnect = { stop: vi.fn() };` to `createDetachable()` (after `live._detachUI = vi.fn();`) and append to the `"NimioLive.detach() and the kept-alive session"` describe:

```js
it("stops a reconnect the disconnect handler scheduled", () => {
  // _onDisconnect() stopped the engine and scheduled play(); the stop()
  // inside detach() returns early on a stopped engine and never resets it
  const live = createDetachable(true);

  live.detach();

  expect(live._reconnect.stop).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js`
Expected: FAIL. "fire play" fails with `_scheduleAutoplay is not a function`; "cancelled by destroy()" the same; "stops a reconnect" fails on `stop` called 0 times.

- [ ] **Step 3: Implement**

In `src/nimio-live.js` constructor, replace

```js
this._playCb = this.play.bind(this);
if (this._config.autoplay) {
  setTimeout(this._playCb, 0);
  setTimeout(() => {
    if (this._ui) this._ui.hideControls(true);
  }, 1000);
}
```

with

```js
this._playCb = this.play.bind(this);
this._autoplayTimers = [];
if (this._config.autoplay) this._scheduleAutoplay();
```

Add next to `_cancelPauseTimeout()`:

```js
  _scheduleAutoplay() {
    this._autoplayTimers = [
      setTimeout(this._playCb, 0),
      setTimeout(() => {
        if (this._ui) this._ui.hideControls(true);
      }, 1000),
    ];
  }

  // a destroyed (or rolled back) engine must not autoplay afterwards
  _cancelAutoplay() {
    for (const id of this._autoplayTimers) clearTimeout(id);
    this._autoplayTimers = [];
  }
```

In `_releaseMediaResources()`, add `this._cancelAutoplay();` right after `this._cancelPauseTimeout();`.

In `detach()`, right after `this.stop({ keepConnection: true });` add:

```js
// stop() returns early on an engine _onDisconnect() already stopped, so
// the reconnect it scheduled would play() on a detached engine
this._reconnect.stop();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js`
Expected: PASS. (The two existing `destroy()` fixtures in `tests/nimio-live.test.js` lack `_autoplayTimers`: if `_cancelAutoplay()` throws there, add `live._autoplayTimers = [];` to those fixtures; ruling: test-only.)

- [ ] **Step 5: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js
```

---

### Task 4: Constructor rollback

**Files:**

- Modify: `src/nimio-live.js` (constructor ~35-118)
- Create: `tests/nimio-live-init.test.js`

**Interfaces:**

- Consumes: `_cancelAutoplay()` (Task 3), `_destroyed` (Task 1), `runCleanupSteps` (already imported).
- Produces: `_init()`, `_rollbackInit()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/nimio-live-init.test.js`:

```js
import { describe, it, expect, vi, afterEach } from "vitest";
import { releaseInstances } from "@/shared/service";
import { EventBus } from "@/event-bus";

// The real constructor runs under jsdom with a stubbed Worker. The media
// grabber is the last thing the constructor creates, after the transport
// worker, the SLDP manager, the reconnector and the autoplay timers: making
// it throw reproduces a failure that would otherwise leak all of those.
const probe = vi.hoisted(() => ({ fail: false }));
vi.mock("@/grabber", () => ({
  MediaGrabber: {
    getInstance() {
      if (probe.fail) throw new Error("grabber boom");
      return { setRate() {}, onScreenshotReady() {}, start() {}, stop() {} };
    },
  },
}));

class FakeWorker {
  constructor() {
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    FakeWorker.instances.push(this);
  }
}
FakeWorker.instances = [];

import { NimioLive } from "@/nimio-live";

const config = {
  streamUrl: "wss://example.test/live",
  fullBufferMs: 1000,
  latency: 500,
  latencyTolerance: 0,
  reconnects: 0,
  startOffset: 0,
  workletLogs: false,
  autoplay: true,
  screenshots: { rate: 1 },
};

describe("NimioLive constructor failure", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    probe.fail = false;
    FakeWorker.instances.length = 0;
    releaseInstances("Init");
  });

  it("releases the transport worker, unsubscribes and rethrows", () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    probe.fail = true;
    const ui = { hideControls: vi.fn(), clear: vi.fn() };

    expect(() => new NimioLive("Init", ui, config)).toThrow("grabber boom");

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].postMessage).toHaveBeenCalledWith({
      type: "terminate",
    });
    vi.advanceTimersByTime(1000);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(ui.hideControls).not.toHaveBeenCalled(); // autoplay cancelled
    const bus = EventBus.getInstance("Init");
    expect(bus.hasListeners("ui:play-pause-click")).toBe(false);
    expect(bus.hasListeners("transp:track-action")).toBe(false);
    expect(bus.hasListeners("nimio:connection-established")).toBe(false); // reconnector
  });

  it("a successful construction leaves the worker alive", () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const ui = { hideControls: vi.fn(), clear: vi.fn() };

    const live = new NimioLive("Init", ui, {
      ...config,
      autoplay: false,
      screenshots: undefined,
    });

    expect(live._destroyed).toBeFalsy();
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalledWith({
      type: "terminate",
    });
    live.destroy();
  });
});

describe("NimioLive._rollbackInit()", () => {
  it("rollback before the transport exists releases what is there and does not throw", () => {
    const live = Object.create(NimioLive.prototype);
    live._logger = { error: vi.fn(), debug: vi.fn() };
    live._eventBus = { off: vi.fn() };
    live._autoplayTimers = [];
    live._removeUIEventHandlers = vi.fn();
    live._deinitTransport = vi.fn();

    expect(() => live._rollbackInit()).not.toThrow();

    expect(live._destroyed).toBe(true);
    expect(live._removeUIEventHandlers).toHaveBeenCalledTimes(1);
    expect(live._deinitTransport).not.toHaveBeenCalled();
    expect(live._logger.error).not.toHaveBeenCalled();
  });

  it("a failing step is logged and the others still run", () => {
    const live = Object.create(NimioLive.prototype);
    live._logger = { error: vi.fn(), debug: vi.fn() };
    live._eventBus = { off: vi.fn() };
    live._autoplayTimers = [];
    live._removeUIEventHandlers = vi.fn();
    live._deinitTransport = vi.fn();
    live._transport = { destroy: vi.fn() };
    live._sldpManager = {
      destroy: vi.fn(() => {
        throw new Error("manager boom");
      }),
    };
    live._reconnect = { destroy: vi.fn() };
    live._debugView = { stop: vi.fn() };

    expect(() => live._rollbackInit()).not.toThrow();

    expect(live._deinitTransport).toHaveBeenCalledTimes(1);
    expect(live._reconnect.destroy).toHaveBeenCalledTimes(1);
    expect(live._debugView.stop).toHaveBeenCalledTimes(1);
    expect(live._transport.destroy).toHaveBeenCalledTimes(1);
    expect(live._logger.error).toHaveBeenCalledTimes(1);
    expect(live._logger.error.mock.calls[0][0]).toBe(
      "init rollback: SLDP manager failed",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-init.test.js`
Expected: FAIL. "releases the transport worker" fails on `postMessage` not called with terminate (the worker leaks today); the `_rollbackInit` tests fail with `_rollbackInit is not a function`; "successful construction" passes.

- [ ] **Step 3: Implement**

In `src/nimio-live.js`, the constructor keeps everything through

```js
this._logger = LoggersFactory.create(this._instName, "Nimio Live");
this._workletLogReceiver = new WorkletLogReceiver(this._config.workletLogs);
this._eventBus = EventBus.getInstance(this._instName);
```

then continues with

```js
    try {
      this._init();
    } catch (err) {
      this._rollbackInit();
      throw err;
    }
  }

  _init() {
    const idxCount = Object.values(IDX).reduce((total, val) => {
```

i.e. the remainder of today's constructor body (from `const idxCount` to `this._offscreenCanvas = ...`) becomes `_init()`. Add after `_init()`:

```js
  // Undo a partially built engine: the same releases destroy() would do for
  // the parts that exist, each isolated, nothing rethrown (the constructor
  // rethrows the original error). The UI handler removal needs no guard: the
  // bus ignores a handler that was never registered.
  _rollbackInit() {
    this._destroyed = true;
    runCleanupSteps(this._logger, "init rollback", [
      ["autoplay", () => this._cancelAutoplay()],
      ["UI handlers", () => this._removeUIEventHandlers()],
      ["transport handlers", () => this._transport && this._deinitTransport()],
      [
        "sync-mode handler",
        () =>
          this._onSyncModeParams &&
          this._eventBus.off("nimio:sync-mode-params", this._onSyncModeParams),
      ],
      ["reconnector", () => this._reconnect?.destroy()],
      ["SLDP manager", () => this._sldpManager?.destroy()],
      ["overlay", () => this._debugView?.stop()],
      ["transport", () => this._transport?.destroy()],
    ]);
  }
```

`_cancelAutoplay()` must tolerate `_autoplayTimers` being undefined (a throw before `_init()` reached it): change its loop to `for (const id of this._autoplayTimers || []) clearTimeout(id);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-init.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js`
Expected: PASS. If `_removeUIEventHandlers()` throws on the never-bound prototype handler, the spec's claim about the bus is wrong: guard the step with `Object.hasOwn(this, "_onPlayPauseClick")` and ledger the ruling.

- [ ] **Step 5: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-init.test.js
```

---

### Task 5: Null main audio flow guard

**Files:**

- Modify: `src/nimio-transport.js` (`_onAudioCodecDataReceived()` main-track branch ~215)
- Modify: `tests/nimio-transport-switch.test.js` (append a describe)

**Interfaces:** none shared.

- [ ] **Step 1: Write the failing tests**

Append to `tests/nimio-transport-switch.test.js`:

```js
describe("main-track audio header after the main flow was dropped", () => {
  // an incompatible update destroyed the main flow and cancelled the next
  // track; the next track's header may still be in flight and lands here
  function createDroppedEngine(compatible) {
    const { live } = createMainTrackEngine({ paired: false });
    live._decoderFlows.audio = null;
    live._nextRenditionData = null;
    live._audioConfig.isCompatible = () => compatible;
    live._prepareAudioOutput = vi.fn(() => true);
    return live;
  }

  it("is ignored on the incompatible path", () => {
    const live = createDroppedEngine(false);

    expect(() => live._onAudioCodecDataReceived(mainCodecData)).not.toThrow();

    expect(live._sldpManager.cancelStream).not.toHaveBeenCalled();
    expect(live._context.resetCurrentStream).not.toHaveBeenCalled();
    expect(live._onRenditionSwitchResult).not.toHaveBeenCalled();
  });

  it("is ignored on the compatible path", () => {
    const live = createDroppedEngine(true);

    expect(() => live._onAudioCodecDataReceived(mainCodecData)).not.toThrow();

    expect(live._prepareAudioOutput).not.toHaveBeenCalled();
    expect(live._audioConfig.updateFrom).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-transport-switch.test.js`
Expected: FAIL. Both new tests throw `Cannot read properties of null (reading 'destroy')` / `(reading 'setCodecData')`.

- [ ] **Step 3: Implement**

In `src/nimio-transport.js`, the `else` branch of `_onAudioCodecDataReceived()` starts with:

```js
    } else {
      if (!this._decoderFlows["audio"]) {
        // the main audio stream was dropped (incompatible update): a late
        // header, e.g. for the cancelled next track, means nothing now
        return;
      }
      if (!this._audioBuffer || this._audioConfig.isCompatible(newCfg)) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-transport-switch.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/nimio-transport.js tests/nimio-transport-switch.test.js
```

---

### Task 6: Native Picture-in-Picture after cleanup

**Files:**

- Modify: `src/ui/ui-pip.js` (`_cleanupPip()` ~57, `_toggieVideoPip()` ~286)
- Modify: `tests/ui-pip-lifecycle.test.js` (append a describe)

**Interfaces:** none shared.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui-pip-lifecycle.test.js`:

```js
// Native PiP: requestPictureInPicture() resolves asynchronously too. A grant
// after the UI was torn down must exit the PiP window instead of leaving a
// detached video in it, and must not run the leave handling (which plays the
// element and arms a layout timer). Cleanup exits an active window itself.
function createNativePipUi() {
  const ui = createPipUi();
  let grant, reject;
  ui._mediaElement = {
    style: {},
    pause: vi.fn(),
    play: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestPictureInPicture: () =>
      new Promise((res, rej) => {
        grant = res;
        reject = rej;
      }),
  };
  ui._getFrameSizePip = (rect) => rect;
  ui._handleLeavePip = vi.fn();
  return { ui, grant: () => grant({}), reject: (e) => reject(e) };
}

function setPipElement(element) {
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => element,
  });
}

describe("UI native PiP pending request", () => {
  afterEach(() => {
    setPipElement(null);
    delete document.exitPictureInPicture;
  });

  it("a grant after cleanup exits PiP and skips the leave handling", async () => {
    const { ui, grant } = createNativePipUi();
    document.exitPictureInPicture = vi.fn(() => Promise.resolve());

    const pending = ui._toggieVideoPip();
    ui._cleanupPip();
    setPipElement(ui._mediaElement); // the browser entered PiP meanwhile
    document.exitPictureInPicture.mockClear();
    grant();
    await pending;

    expect(document.exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(ui._handleLeavePip).not.toHaveBeenCalled();
    expect(ui._mediaElement.play).not.toHaveBeenCalled();
  });

  it("a rejection after cleanup runs no leave handling", async () => {
    const { ui, reject } = createNativePipUi();

    const pending = ui._toggieVideoPip();
    ui._cleanupPip();
    reject(new Error("denied"));
    await pending;

    expect(ui._handleLeavePip).not.toHaveBeenCalled();
    expect(ui._logger.error).not.toHaveBeenCalled();
  });

  it("a grant while the UI is alive re-enables the button and exits nothing", async () => {
    const { ui, grant } = createNativePipUi();
    document.exitPictureInPicture = vi.fn(() => Promise.resolve());

    const pending = ui._toggieVideoPip();
    expect(ui._buttonPictureInPicture.disabled).toBe(true);
    grant();
    await pending;

    expect(ui._buttonPictureInPicture.disabled).toBe(false);
    expect(document.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it("cleanup exits an active native PiP window", () => {
    const { ui } = createNativePipUi();
    setPipElement(ui._mediaElement);
    document.exitPictureInPicture = vi.fn(() => Promise.resolve());

    ui._cleanupPip();

    expect(document.exitPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it("cleanup tolerates an exit rejection", async () => {
    const { ui } = createNativePipUi();
    setPipElement(ui._mediaElement);
    document.exitPictureInPicture = vi.fn(() =>
      Promise.reject(new Error("not in PiP")),
    );

    expect(() => ui._cleanupPip()).not.toThrow();
    await Promise.resolve(); // the rejection settles; nothing unhandled
    expect(ui._pipMessage).toBeUndefined(); // cleanup ran to its end
  });

  it("cleanup leaves another element's PiP window alone", () => {
    const { ui } = createNativePipUi();
    setPipElement({});
    document.exitPictureInPicture = vi.fn(() => Promise.resolve());

    ui._cleanupPip();

    expect(document.exitPictureInPicture).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ui-pip-lifecycle.test.js`
Expected: FAIL. "a grant after cleanup" fails on `exitPictureInPicture` called 0 times; "a rejection after cleanup" fails on `_handleLeavePip` being called; "cleanup exits an active native PiP window" fails on 0 calls. "cleanup leaves another element's PiP window alone", "a grant while the UI is alive" and "cleanup tolerates an exit rejection" pass already (the last two are regression guards: the exit call does not exist yet, so nothing can reject). After Step 3 vitest must report no unhandled rejection.

- [ ] **Step 3: Implement**

In `src/ui/ui-pip.js`, `_cleanupPip()`: right after the generation bump add

```js
// a native PiP window would keep showing a detached video
if (
  this._mediaElement &&
  document.pictureInPictureElement === this._mediaElement
) {
  document.exitPictureInPicture().catch(() => {});
}
```

`_toggieVideoPip()`: replace the tail from `await this._mediaElement.requestPictureInPicture()` with

```js
const gen = (this._pipRequestGen = this._pipRequestGen || 0);
await this._mediaElement.requestPictureInPicture().catch((err) => {
  if (gen !== this._pipRequestGen) return; // torn down meanwhile
  this._logger.error("Failed to enter PiP mode", err);
  this._handleLeavePip();
});
if (gen !== this._pipRequestGen) {
  // the UI was torn down while the request was pending: the window
  // shows a detached video, close it; the button is gone
  if (document.pictureInPictureElement === this._mediaElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  return;
}
this._buttonPictureInPicture.disabled = false;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ui-pip-lifecycle.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Stage**

```bash
git add src/ui/ui-pip.js tests/ui-pip-lifecycle.test.js
```

---

### Task 7: VU meter UI animation loop generation

**Files:**

- Modify: `src/vumeter/ui.js` (constructor ~2, `create()` ~50, `destroy()` ~69, `_drawMeter()` ~239)
- Modify: `tests/vumeter-ui.test.js` (append a describe)

**Interfaces:** none shared.

- [ ] **Step 1: Write the failing test**

Append to `tests/vumeter-ui.test.js`:

```js
describe("VUMeterUI.refresh()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("with a changed size leaves one animation loop running", () => {
    const frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
    const container = document.createElement("div");
    let width = 100;
    Object.defineProperty(container, "clientWidth", { get: () => width });
    Object.defineProperty(container, "clientHeight", { get: () => 40 });
    document.body.appendChild(container);
    const ui = new VUMeterUI(container, 60);
    ui.create(2);
    expect(frames).toHaveLength(1); // the first loop is running

    width = 200;
    ui.refresh(2); // destroy(true) + create(): the old loop's frame is still queued

    // fire every queued frame once: only the current loop may continue
    const queued = frames.splice(0);
    queued.forEach((cb) => cb());
    expect(frames).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/vumeter-ui.test.js`
Expected: FAIL with `expected [ …, … ] to have a length of 1 but got 2`.

- [ ] **Step 3: Implement**

In `src/vumeter/ui.js`: in the constructor add `this._drawGen = 0;` after `this._levelTransition = "0.1s";`. In `create()` change the last line to `this._drawMeter(this._drawGen);`. In `destroy()`, right after `this._fullValue = false;` add `this._drawGen++; // a frame the old loop already scheduled must not continue`. Replace `_drawMeter()`:

```js
  _drawMeter(gen) {
    if (!this._fullValue || gen !== this._drawGen) return;

    for (let i = 0; i < this._channels; i++) {
      if (this._vertical) {
        this._channelLevels[i].style.height = this._levelValues[i] + "px";
      } else {
        this._channelLevels[i].style.width = this._levelValues[i] + "px";
      }
    }
    window.requestAnimationFrame(() => this._drawMeter(gen));
  }
```

The existing test "stops the animation loop even when the host already removed the meter's children" calls `ui._drawMeter()` without a generation; after the change that call returns at once. Both of its calls model frames the running loop scheduled, so capture the generation before `destroy(true)` and pass it:

```js
const gen = ui._drawGen;
ui._drawMeter(gen);
expect(raf).toHaveBeenCalled(); // the loop is running

container.querySelector("*").innerHTML = ""; // host cleared the inner DOM
expect(() => ui.destroy(true)).not.toThrow();

raf.mockClear();
ui._drawMeter(gen); // a frame that was already scheduled fires
expect(raf).not.toHaveBeenCalled();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/vumeter-ui.test.js tests/vumeter-service.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/vumeter/ui.js tests/vumeter-ui.test.js
```

---

### Task 8: Whole-suite verification, spec sync and the single commit

**Files:**

- Possibly modify: `docs/superpowers/specs/2026-10-14-live-after-destroy-design.md` (only if implementation deviated)

- [ ] **Step 1: Format and run everything**

Run: `npx prettier --write src tests && npx prettier --check src tests`
Expected: "All matched files use Prettier code style!"

Run: `npx vitest run > .superpowers/sdd/2026-10-14-live-after-destroy/vitest.txt 2>&1; tail -8 .superpowers/sdd/2026-10-14-live-after-destroy/vitest.txt`
Expected: all test files pass, 0 failed.

Run: `npm run test:browser > .superpowers/sdd/2026-10-14-live-after-destroy/browser.txt 2>&1; tail -8 .superpowers/sdd/2026-10-14-live-after-destroy/browser.txt`
Expected: all browser test files pass, 0 failed.

- [ ] **Step 2: Sync the spec**

Compare the spec's code blocks with the implementation (`_rollbackInit()` step list, `_cancelAutoplay()` tolerance, `_cleanupPip()` guard, test file names: `tests/nimio-live-after-destroy.test.js`, `tests/nimio-live-init.test.js`). Edit the spec where it drifted and commit the spec change separately: `git commit -m "Sync the live-after-destroy spec with the implementation" -- docs/superpowers/specs/2026-10-14-live-after-destroy-design.md`.

- [ ] **Step 3: Commit the code**

```bash
git status --short   # only src/ and tests/ files staged; no docs
git commit -m "Keep a destroyed live engine inert

A destroyed NimioLive ignores play(), pause() and attach(); the
listeners of nimio:play, nimio:connection-started and
nimio:playback-start may destroy or stop the player without leaving a
started state, a connection request, a running overlay or an unclosed
frame behind; a throwing playback-start listener is logged. destroy()
is idempotent and cancels the autoplay timers. A constructor that fails
after the transport worker exists rolls back and releases it.

Also: detach() stops a reconnect scheduled by the disconnect handler;
a late main-track audio header after the main flow was dropped is
ignored; a native Picture-in-Picture grant after the UI was torn down
exits the window and skips the leave handling, and cleanup exits an
active native window; the VU meter UI leaves one animation loop per
refresh."
```

Expected: one commit on `fix/live-after-destroy` with only `src/` and `tests/` changes.
