# Stop and Stream URL Change in VOD Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Nimio.stop()` in VOD mode leaves the player in live mode, stopped; `Nimio.setStreamURL()` in VOD mode switches to live and plays the new URL with one connection through the mode-switch routine; the facade's active player and mode have one writer.

**Architecture:** The live engine's `attach()` gains an `idle` option (take the UI, start nothing) and its `setStreamURL()` a detached branch (close a connected kept-alive session). The SLDP manager clears `sessionReady` on a closing stop. The facade gets `_activate(player, mode)`, used by the switch's finish and restore paths, by the switch's detach callback and by the rewritten `stop()`; `setStreamURL()` tells the engine first and then runs `_switchMode(LIVE)` in VOD mode.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom (`npx vitest run`), vitest browser config (`npm run test:browser`), prettier.

**Spec:** `docs/superpowers/specs/2026-10-16-vod-stop-and-stream-url-design.md`

## Global Constraints

- Branch `fix/vod-stop-and-stream-url` from upstream `main` (`0fcce53`). Only `src/nimio.js`, `src/nimio-live.js`, `src/sldp/manager.js` and tests change. `_switchMode()`'s detach/attach sequence, timeout and error reporting stay as they are.
- Project rule: **one code commit at the end** (Task 4). Earlier tasks only `git add`. Spec/plan commits stay local; the code-only PR branch `fix/vod-stop-and-stream-url-pr` is cut afterwards.
- `npx prettier --check src tests`, `npx vitest run` and `npm run test:browser` must be clean before the commit.
- Facade tests use the fake engines of `tests/nimio-mode-switch.test.js`; engine tests build engines with `Object.create(NimioLive.prototype)`.

## Review Focus

- `stop()` twice in a row from VOD mode: the second call finds no running VOD engine, an already attached live engine and a stopped live engine; nothing may throw or emit → Task 3 test "a second stop() is a no-op".
- `play()` from a `nimio:playback-end` listener while the VOD engine stops: the facade still points at VOD, so the call is a no-op and the player still ends in live, stopped → Task 3 test "a play() from the VOD playback-end listener is a no-op".
- `setStreamURL({ live, vod })` object form in VOD mode: both URLs recorded, the switch still runs once → Task 3 test "accepts the object form".
- `stop()` while the live engine is attached and playing during a pending switch to live (VOD detached, warm): the VOD engine is stopped, live is not re-attached, live is stopped → Task 3 test "during a pending switch to live".
- An idle attach followed by `play()`: an initial play (connection started once, state started once by the play) → Task 2 test "an idle attach followed by play() is an initial play".

---

### Task 1: Closing stop clears `sessionReady`

**Files:**

- Modify: `src/sldp/manager.js` (`stop()` ~64)
- Modify: `tests/sldp-manager.test.js` (append to the `"SLDPManager closing stop"` describe)

**Interfaces:**

- Produces: after `stop({ closeConnection: true })`, `sessionReady === false`. Task 2's detached `setStreamURL()` and Task 3's facade rely on it so that the next `attach()` handshakes.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("SLDPManager closing stop", ...)` in `tests/sldp-manager.test.js`, after the last `it(...)`:

```js
it("a closing stop ends the session: sessionReady turns false", () => {
  // a committed session (status processed for the current run)
  mgr._sessionReady = true;

  mgr.stop({ closeConnection: true });

  expect(mgr.sessionReady).toBe(false);
});

it("a keep-connection stop leaves sessionReady alone (detach reuses it)", () => {
  mgr._sessionReady = true;

  mgr.stop();

  expect(mgr.sessionReady).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sldp-manager.test.js`
Expected: FAIL, "a closing stop ends the session" with `expected true to be false`; the keep-connection test passes already.

- [ ] **Step 3: Implement**

In `src/sldp/manager.js`:

```js
  stop(opts = {}) {
    const sns = this.resetRequestedStreams();
    const close = !!opts.closeConnection;
    if (close) this._sessionReady = false; // the session ends with the socket
    if (sns.length === 0 && !close) return;
    this._sendRequest("stop", { sns, close });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sldp-manager.test.js tests/sldp-manager-run.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/sldp/manager.js tests/sldp-manager.test.js
```

---

### Task 2: Idle attach and detached `setStreamURL()` in the live engine

**Files:**

- Modify: `src/nimio-live.js` (`setStreamURL()` ~221, `attach()` ~230-290)
- Modify: `tests/nimio-live-attach.test.js` (append a describe)
- Modify: `tests/nimio-live-after-destroy.test.js` (append one test to the `"NimioLive restart from a listener"` describe or a new describe)
- Modify: `tests/nimio-live.test.js` (append a describe)

**Interfaces:**

- Produces: `attach(ui, { latency: 0, idle: true }, cb)` takes the UI, calls `cb`, returns `true`, starts nothing; `setStreamURL()` on a detached engine closes a connected session through `_sldpManager.stop({ closeConnection: true })` and returns. Task 3 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/nimio-live-attach.test.js`:

```js
describe("NimioLive.attach() idle", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The facade's stop() in VOD mode gives the UI back to the live engine
  // without starting it: the player ends in live mode, stopped.
  it("takes the UI, calls back and starts nothing", () => {
    const live = createLive({ connected: true, savedState: STATE.PLAYING });
    live._attachUI = vi.fn(function (ui) {
      this._ui = ui;
    });
    const ui = {};
    const cb = vi.fn();

    expect(live.attach(ui, { latency: 0, idle: true }, cb)).toBe(true);

    expect(live._attachUI).toHaveBeenCalledWith(ui);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(live._state.start).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(live._sldpManager.start).not.toHaveBeenCalled();
    expect(live._sldpManager.requestCurrentStreams).not.toHaveBeenCalled();
  });

  it("holds the UI afterwards: a second attach is refused", () => {
    const live = createLive({ connected: false, savedState: STATE.PLAYING });
    live._attachUI = vi.fn(function (ui) {
      this._ui = ui;
    });

    live.attach({}, { latency: 0, idle: true });

    expect(live.attach({}, { latency: 0 })).toBe(false);
  });
});
```

Append to `tests/nimio-live-after-destroy.test.js` (new describe at the end; `createEngine()` has everything `play()` touches):

```js
describe("NimioLive idle attach then play()", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an idle attach followed by play() is an initial play", () => {
    const { live } = createEngine();
    delete live._attachUI; // the real one
    const ui = { toggleMode: vi.fn(), setDetached: vi.fn() };

    expect(live.attach(ui, { latency: 0, idle: true })).toBe(true);
    live.play();

    expect(live._ui).toBe(ui);
    expect(live._state.start).toHaveBeenCalledTimes(1); // by play() only
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.start).toHaveBeenCalledTimes(1);
    expect(live._debugView.start).toHaveBeenCalledTimes(1);
  });
});
```

Append to `tests/nimio-live.test.js`:

```js
describe("NimioLive.setStreamURL() while detached", () => {
  // VOD mode: the live engine holds no UI; a kept-alive session belongs to
  // the old URL, so the next attach() must handshake instead of reusing it
  function createDetached(connected) {
    const live = Object.create(NimioLive.prototype);
    live._ui = undefined;
    live._transport = { connected };
    live._sldpManager = { stop: vi.fn() };
    live._state = { isStopped: () => true, isPlaying: () => false };
    live.stop = vi.fn();
    live.play = vi.fn();
    return live;
  }

  it("closes a connected kept-alive session", () => {
    const live = createDetached(true);

    live.setStreamURL();

    expect(live._sldpManager.stop).toHaveBeenCalledWith({
      closeConnection: true,
    });
    expect(live.stop).not.toHaveBeenCalled();
    expect(live.play).not.toHaveBeenCalled();
  });

  it("does nothing when the transport is disconnected", () => {
    const live = createDetached(false);

    live.setStreamURL();

    expect(live._sldpManager.stop).not.toHaveBeenCalled();
  });

  it("attached and stopped: returns without stopping or playing", () => {
    const live = createDetached(true);
    live._ui = {};

    live.setStreamURL();

    expect(live._sldpManager.stop).not.toHaveBeenCalled();
    expect(live.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js`
Expected: FAIL. "takes the UI, calls back and starts nothing" fails on `_state.start` being called; "an idle attach followed by play()" fails on `_state.start` called 2 times; "closes a connected kept-alive session" fails on `stop` not called with the close option. The other new tests pass already.

- [ ] **Step 3: Implement**

In `src/nimio-live.js`, `attach()`: right after the `pbError` branch (which ends with `return true;`) and before `this._state.start();`, add:

```js
if (params.idle) {
  // take the UI without starting anything: the caller keeps us stopped
  // (the facade's stop() in VOD mode); a later play() is an initial play
  if (callback) callback();
  return true;
}
```

`setStreamURL()`:

```js
  // The URL is already updated in the config
  setStreamURL() {
    if (!this._ui) {
      // detached (VOD mode): a kept-alive session belongs to the old URL,
      // the next attach() must handshake. Nothing to close when the
      // transport is not connected (the worker's close needs a socket).
      if (this._transport.connected) {
        this._sldpManager.stop({ closeConnection: true });
      }
      return;
    }
    if (this._state.isStopped()) return;

    const playing = this._state.isPlaying();
    this.stop();
    if (playing) this.play();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js
```

---

### Task 3: Facade `_activate()`, `stop()` and `setStreamURL()`

**Files:**

- Modify: `src/nimio.js` (`setStreamURL()` ~187, `stop()` ~205, `_switchMode()` detach callback ~320, `_finishModeSwitch()` ~341, `_restoreMode()` ~360)
- Modify: `tests/nimio-mode-switch.test.js` (fakes and `createFacade()` extended; two new describes)

**Interfaces:**

- Consumes: `attach(ui, { latency: 0, idle: true })` and the detached `setStreamURL()` from Task 2; `updateConfigStreamURL` from `src/player-config.js` (already imported in `src/nimio.js`).
- Produces: `_activate(player, mode)`, the only writer of `_actPlayer`/`_mode` outside the constructor and `destroy()`.

- [ ] **Step 1: Extend the fakes and write the failing tests**

In `tests/nimio-mode-switch.test.js`, replace `fakeLive()` and `fakeVod()` with:

```js
function fakeLive() {
  return {
    attached: true,
    play: vi.fn(),
    stop: vi.fn(),
    setStreamURL: vi.fn(),
    detach: vi.fn(function (cb) {
      this.attached = false;
      if (cb) cb();
      return true;
    }),
    attach: vi.fn(function (ui, params, cb) {
      if (this.attached) return false;
      this.attached = true;
      if (cb) cb();
      return true;
    }),
  };
}

// running: SYNC or PLAY in the real engine (attached, or detached and warm);
// false after stop()
function fakeVod({ attach = "async" } = {}) {
  return {
    attached: false,
    running: false,
    pendingAttach: null,
    hasPlaybackErrors: () => false,
    isRunning: vi.fn(function () {
      return this.running;
    }),
    play: vi.fn(),
    stop: vi.fn(function (cb) {
      this.attached = false;
      this.running = false;
      this.pendingAttach = null;
      if (cb) cb();
    }),
    detach: vi.fn(function (cb) {
      if (!this.attached) return false;
      this.attached = false;
      this.pendingAttach = null;
      if (cb) cb();
      return true;
    }),
    attach: vi.fn(function (ui, position, cb) {
      if (attach === false) return false;
      this.attached = true;
      this.running = true;
      if (attach === "sync") {
        if (cb) cb();
      } else {
        this.pendingAttach = cb;
      }
      return true;
    }),
  };
}
```

In `createFacade()`, inside `if (mode === MODE.VOD) {` add `n._vodPlayer.running = true;`, and after `n._vuMeterSvc = ...` add `n._config = { streamUrl: "wss://example.test/old" };`.

Append two describes at the end of the file:

```js
describe("Nimio.stop()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const idle = { latency: 0, idle: true };

  it("in VOD mode returns to live, stopped, and a later play() starts live", () => {
    const n = createFacade({ mode: MODE.VOD });

    n.stop();

    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).toHaveBeenCalledWith(n._ui, idle);
    expect(n._livePlayer.attached).toBe(true);
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
    expect(n._eventBus.emit).not.toHaveBeenCalled();

    n.play();
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
  });

  it("a second stop() is a no-op", () => {
    const n = createFacade({ mode: MODE.VOD });
    n.stop();
    n._vodPlayer.stop.mockClear();
    n._livePlayer.attach.mockClear();

    expect(() => n.stop()).not.toThrow();

    expect(n._vodPlayer.stop).not.toHaveBeenCalled(); // not running any more
    expect(n._livePlayer.attach.mock.results[0].value).toBe(false); // held
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(2);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("a play() from the VOD playback-end listener is a no-op", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._vodPlayer.stop = vi.fn(function (cb) {
      n.play(); // an application listener of nimio:playback-end
      this.attached = false;
      this.running = false;
      if (cb) cb();
    });

    n.stop();

    expect(n._vodPlayer.play).toHaveBeenCalledTimes(1); // the stopping engine
    expect(n._livePlayer.play).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
  });

  it("during a pending switch to VOD cancels the switch without an error", () => {
    const n = createFacade();
    n._switchToVod(3);
    expect(n._mode).toBe(MODE.PEND);
    const late = n._vodPlayer.pendingAttach;

    n.stop();

    expect(n._modeSwitch).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1); // it held the UI
    expect(n._livePlayer.attach).toHaveBeenLastCalledWith(n._ui, idle);
    expect(n._livePlayer.attached).toBe(true);
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
    expect(n._eventBus.emit).not.toHaveBeenCalled();

    late(); // the settled switch ignores its late completion
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("during a pending switch to live stops the warm VOD engine and live", () => {
    // VOD detached (warm), live attached and playing, switch not settled
    const n = createFacade({ mode: MODE.VOD });
    n._mode = MODE.PEND;
    n._modeSwitch = { settled: false, timer: setTimeout(() => {}, 5000) };
    n._vodPlayer.attached = false;
    n._livePlayer.attached = true;

    n.stop();

    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach.mock.results[0].value).toBe(false); // held
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("in live mode with a warm VOD engine stops it and live", () => {
    const n = createFacade();
    n._vodPlayer.running = true; // detached, reloading levels in the background

    n.stop();

    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attached).toBe(true);
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("with no VOD engine stops live only", () => {
    const n = createFacade();
    n._vodPlayer = undefined;

    n.stop();

    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
  });

  it("on a destroyed player does nothing", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._destroyed = true;

    n.stop();

    expect(n._vodPlayer.stop).not.toHaveBeenCalled();
    expect(n._livePlayer.stop).not.toHaveBeenCalled();
  });
});

describe("Nimio.setStreamURL()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const order = (fn) => fn.mock.invocationCallOrder[0];

  it("in VOD mode tells the live engine first, then switches to live with one attach", () => {
    const n = createFacade({ mode: MODE.VOD });

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/new");
    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
    expect(n._vodPlayer.detach).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).toHaveBeenCalledWith(
      n._ui,
      { latency: 0 },
      expect.any(Function),
    );
    expect(order(n._livePlayer.setStreamURL)).toBeLessThan(
      order(n._livePlayer.attach),
    );
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
    expect(n._eventBus.emit).not.toHaveBeenCalled();
  });

  it("accepts the object form and records both URLs", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._config.vod = { url: "https://example.test/old.m3u8" };

    n.setStreamURL({
      live: "wss://example.test/new",
      vod: "https://example.test/new.m3u8",
    });

    expect(n._config.streamUrl).toBe("wss://example.test/new");
    expect(n._config.vod.url).toBe("https://example.test/new.m3u8");
    expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in VOD mode with a refused live attach restores VOD and reports the error", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._livePlayer.attach = vi.fn(() => false);

    n.setStreamURL("wss://example.test/new");

    expect(n._mode).toBe(MODE.VOD);
    expect(n._actPlayer).toBe(n._vodPlayer);
    expect(n._vodPlayer.attach).toHaveBeenCalledTimes(1); // restored
    expect(n._eventBus.emit).toHaveBeenCalledWith(...errorEvent(MODE.LIVE));
    expect(n._config.streamUrl).toBe("wss://example.test/new"); // kept
  });

  it("during a pending switch applies only the engine-level change and warns", () => {
    const n = createFacade();
    n._switchToVod(1);
    expect(n._mode).toBe(MODE.PEND);

    n.setStreamURL("wss://example.test/new");

    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).not.toHaveBeenCalled();
    expect(n._logger.warn).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.PEND);

    n._vodPlayer.pendingAttach(); // the switch completes as it would have
    expect(n._mode).toBe(MODE.VOD);
  });

  it("in live mode only tells the live engine", () => {
    const n = createFacade();

    n.setStreamURL("wss://example.test/new");

    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).not.toHaveBeenCalled();
    expect(n._vodPlayer.detach).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("on a destroyed player does nothing", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._destroyed = true;

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/old");
    expect(n._livePlayer.setStreamURL).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-mode-switch.test.js`
Expected: FAIL. In `Nimio.stop()`: "in VOD mode returns to live" fails on `attach` called with `undefined` params (the old call) and `_mode` still VOD; "a play() from the VOD playback-end listener" fails on `_mode`; "during a pending switch to VOD" fails on `_modeSwitch` not null; "during a pending switch to live" fails on `_mode`; "in live mode with a warm VOD" passes already (old code stopped a running VOD too); "with no VOD engine" passes; "on a destroyed player" passes. In `Nimio.setStreamURL()`: the VOD-mode tests fail on `attach` being called with `undefined` params / mode still VOD; "during a pending switch" fails on `warn` not called; "in live mode" and "destroyed" pass. The existing switch tests keep passing.

- [ ] **Step 3: Implement**

In `src/nimio.js`:

```js
  setStreamURL(url) {
    if (this._destroyed) return;
    updateConfigStreamURL(this._config, url);
    // detached (VOD mode or a pending switch): closes the kept-alive
    // session of the old URL so the next attach handshakes; attached:
    // stop + play with the new URL
    this._livePlayer.setStreamURL();
    if (this._mode === MODE.VOD) {
      // the switch's attach handshakes with the new URL: one connection,
      // and a failure restores VOD and is reported
      this._switchMode(MODE.LIVE, { latency: 0 });
    } else if (this._mode === MODE.PEND) {
      this._logger.warn(
        "Stream URL changed during a mode switch; applied on the next attach",
      );
    }
  }

  pause() {
    this._actPlayer?.pause();
  }

  stop() {
    if (this._destroyed) return;
    // a switch in flight cannot complete into a stopped player; settle it
    // silently (no error: the stop is what the application asked for)
    this._cancelModeSwitch();
    // running covers the attached VOD engine (VOD mode) and the warm,
    // detached one that reloads levels in the background (live mode)
    if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
    // the VOD stop released the UI synchronously (before detaching media):
    // give it back to the live engine without starting it. A no-op when
    // the live engine already holds it.
    this._livePlayer.attach(this._ui, { latency: 0, idle: true });
    this._activate(this._livePlayer, MODE.LIVE);
    this._livePlayer.stop(); // also closes a kept-alive session
  }
```

In `_switchMode()`'s detach callback replace `this._actPlayer = sw.nextPlayer;` with `this._activate(sw.nextPlayer, MODE.PEND);`. In `_finishModeSwitch()` replace `this._mode = sw.target;` with `this._activate(sw.target === MODE.VOD ? this._vodPlayer : this._livePlayer, sw.target);` — or, simpler and equivalent since the detach callback already activated `sw.nextPlayer`, `this._activate(this._actPlayer, sw.target);`. Use the latter. In `_restoreMode()` replace the two assignments with `this._activate(sw.prevPlayer, sw.prevMode);`. Add after `_cancelModeSwitch()`:

```js
  // The only writer of the active player and the mode (besides the
  // constructor and destroy()): a mode change is never half applied.
  _activate(player, mode) {
    this._actPlayer = player;
    this._mode = mode;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-mode-switch.test.js tests/nimio.test.js tests/nimio-live-failover.test.js`
Expected: PASS, all tests in the three files. (`tests/nimio.test.js` module-mocks the engines: if its `NimioLive` mock lacks `attach`/`stop`/`setStreamURL` for the facade's `stop()`/`setStreamURL()` "destroyed no-op" tests, those tests return early on `_destroyed` and need nothing; if a non-destroyed path is exercised there, add the missing stubs to the mock and ledger it as test-only.)

- [ ] **Step 5: Stage**

```bash
git add src/nimio.js tests/nimio-mode-switch.test.js
```

---

### Task 4: Whole-suite verification, spec sync and the single commit

- [ ] **Step 1: Format and run everything**

Run: `npx prettier --write src tests && npx prettier --check src tests`
Expected: "All matched files use Prettier code style!"

Run: `npx vitest run > .superpowers/sdd/2026-10-16-vod-stop-and-stream-url/vitest.txt 2>&1; tail -6 .superpowers/sdd/2026-10-16-vod-stop-and-stream-url/vitest.txt`
Expected: all test files pass, 0 failed.

Run: `npm run test:browser > .superpowers/sdd/2026-10-16-vod-stop-and-stream-url/browser.txt 2>&1; tail -6 .superpowers/sdd/2026-10-16-vod-stop-and-stream-url/browser.txt`
Expected: all browser test files pass, 0 failed.

- [ ] **Step 2: Sync the spec**

Compare the spec's code blocks with the implementation (`stop()`, `setStreamURL()`, `_activate()` call sites, the idle branch, the detached branch, the manager's `stop()`). Edit the spec where it drifted and commit that separately: `git commit -m "Sync the VOD stop/stream URL spec with the implementation" -- docs/superpowers/specs/2026-10-16-vod-stop-and-stream-url-design.md`.

- [ ] **Step 3: Commit the code**

```bash
git status --short   # only src/ and tests/ files staged; no docs
git commit -F - <<'MSG'
Return to live when stopping or changing the stream URL in VOD mode

Nimio.stop() while watching VOD left the facade pointing at the stopped
VOD engine: play() did nothing, setStreamURL() reached a stopped live
engine, seekLive() failed, and the server saw a Play followed by Cancel
because the live engine's attach() always starts playback. The player
now ends in live mode, stopped: a pending mode switch is settled
silently, the VOD engine stops, the live engine takes the UI through a
new idle attach that starts nothing, and is stopped, which also closes
a kept-alive session.

Nimio.setStreamURL() while watching VOD opened two connections and left
the facade in VOD mode while live played. It now tells the live engine
first (detached, it closes the kept-alive session of the old URL) and
runs the normal switch to live, whose attach handshakes with the new
URL; a failed switch restores VOD and is reported as before.

The facade's active player and mode have one writer, _activate(), used
by the switch's finish and restore paths too. A closing SLDP stop clears
sessionReady, so an attach right after a close handshakes instead of
reusing a closing socket.
MSG
```

Expected: one commit on `fix/vod-stop-and-stream-url` with only `src/` and `tests/` changes.
