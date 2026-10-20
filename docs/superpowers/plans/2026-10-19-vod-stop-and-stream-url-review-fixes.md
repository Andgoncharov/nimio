# Stop and Stream URL Change — Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One stopped state whatever was playing before, and a URL change that never shows the old stream's archive: the fixes for the maintainer's six findings on PR #104 and the design review's additions (spec sections 1–5 and the scenario matrix).

**Architecture:** The facade (`src/nimio.js`) replaces the switch-based URL change with stop-then-play, routes every VOD start from a non-running engine through `_runVodFromStart()` (seek bar and `seekVod()` alike), guards re-entrant calls with `_stopping`, voids stale VOD starts with `_vodStartGen`, and resets the playback context in `stop()`. The live engine refuses `pause()` while stopped, cancels its autoplay and reconnect timers in every `stop()`, attaches idle without a capture stream, and loses the detached `setStreamURL()` branch. The VOD engine resumes hls.js buffering in `play()` and re-enters SYNC when it reloads a new URL. The UI's `toggleMode()` takes a `capture` option. The README documents the contract.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom (`npx vitest run`), vitest browser config (`npm run test:browser`), prettier.

**Spec:** `docs/superpowers/specs/2026-10-16-vod-stop-and-stream-url-design.md` (revised 2026-10-19; sections "Design" 1–5, "Scenario matrix", "Error handling", "Testing").

## Global Constraints

- Working branch `fix/vod-stop-and-stream-url` (HEAD `41588fd`, spec committed). Only `src/nimio.js`, `src/nimio-live.js`, `src/nimio-vod.js`, `src/ui/ui.js`, `README.md` and tests change. `_switchMode()`'s detach/attach sequence, timeout and error reporting stay as they are; `src/sldp/manager.js` is unchanged.
- Project rule: **one code commit at the end** (Task 5). Earlier tasks only `git add`. The plan commit follows the code commit. The PR branch `fix/vod-stop-and-stream-url-pr` gets the same code as a **second commit** on top of `9e20450` after the final review (spec "Delivery"), not in this plan.
- `npx prettier --check src tests`, `npx vitest run` and `npm run test:browser` (exit 0, no "Unhandled") must be clean before the commit.
- Facade tests use the fake engines of `tests/nimio-mode-switch.test.js`; engine tests build engines with `Object.create(NimioLive.prototype)` / `new NimioVod(name, config)` and stub collaborators, as the existing files do.
- `VOD_STATE` values (`src/nimio-vod.js:19`): `NULL 0, INIT 1, SYNC 2, PLAY 3, STOP 4`. `STATE` (`@/shared/values`): `STOPPED 0, PLAYING 2, PAUSED 1` — import it rather than hard-coding where a test compares values.
- Spec rows every task must keep true: the facade's `stop()` resets the context in every start state; `setStreamURL()` stops a running VOD engine only when the VOD URL changed; nested calls from a stop's listeners are ignored, except `setStreamURL()` which records the URL.

## Review Focus

- `setStreamURL({ live, vod })` in live mode with a **cold** VOD engine (never initialised, `isLoaded()` false, `isRunning()` false): nothing to stop, no throw, the live engine still restarts → Task 4 test "in live mode with a cold VOD engine a changed VOD URL stops nothing".
- A seek-bar position change into VOD on a player **without a VOD engine** (`vod` disabled): `_onPlaybackPositionChange(VOD, pos)` returns false and throws nothing → Task 4 test "a position change into VOD without a VOD engine returns false".
- `setStreamURL()` called from the **`nimio:play LIVE` listener** during the facade's own `play()` after the stop (re-entrant during the play, where `_stopping` is already false): the live-mode path runs once, no second facade-level play → Task 4 test "a setStreamURL() from the nimio:play listener of the restart takes the live-mode path once".
- `pause()` on a live engine that is **already paused**: still a no-op after the new guard (the guard must not reorder the existing one) → Task 2 test "pause() on a paused engine is a no-op".
- `stop()` on a live engine whose **reconnect timer is pending** while the transport reports connected (the drop notice has not arrived yet): the reconnect is cancelled and the closing stop is still sent → Task 2 test "stop() on a stopped engine cancels a pending reconnect and the autoplay timers".

---

### Task 1: UI `toggleMode()` capture option

**Files:**

- Modify: `src/ui/ui.js:259-283` (`toggleMode`)
- Test: `tests/browser/ui-integration.test.js` (describe "UI lifecycle")

**Interfaces:**

- Consumes: nothing new.
- Produces: `UI.prototype.toggleMode(mode, { capture = true } = {})` — `capture: false` skips `_createCaptureStream()` on the switch to LIVE; everything else unchanged. Task 2's `_attachUI()` calls it.

- [ ] **Step 1: Write the failing browser test**

Add to `describe("UI lifecycle", ...)` in `tests/browser/ui-integration.test.js`, right after the `showStopped()` test:

```js
it("toggleMode(LIVE, { capture: false }) creates no capture stream; the playback start does", async () => {
  // the idle attach of a stopped player: nothing to show, so nothing to
  // capture; a later live start creates the stream as for any live start
  const parent = newParent();
  const ui = new UI("life-idle-capture", parent, { ...opts, vod: {} }, stubBus);
  uis.push(ui);
  ui._pipCaptureStreamMode = true; // native video PiP (no Document PiP)
  ui._mediaElement.play = () => Promise.resolve();
  ui.toggleMode(MODE.VOD);

  ui.toggleMode(MODE.LIVE, { capture: false });

  expect(ui._mode).toBe(MODE.LIVE);
  expect(ui._captureStream).toBeUndefined();
  expect(ui._mediaElement.srcObject).toBeNull();

  ui._onPlaybackStarted({ mode: MODE.LIVE });
  expect(ui._captureStream).toBeDefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:browser 2>&1 | tail -30`
Expected: FAIL in "toggleMode(LIVE, { capture: false }) creates no capture stream" — `expected MediaStream to be undefined` (the option is ignored and the stream is created).

- [ ] **Step 3: Implement the option**

In `src/ui/ui.js`, change the signature and the LIVE branch:

```js
  toggleMode(mode, { capture = true } = {}) {
    if (mode === this._mode) return;
    const updatePlayer = this._toggleModePip(mode);
    if (mode === MODE.LIVE) {
      if (updatePlayer) {
        this._mediaElement.style.display = "none";
        this._canvas.style.display = "block";
      }
      this._liveSign.style.display = "inline-grid";
      if (this._captionCtrl) {
        this._captionList.refresh();
      }
      // an idle attach (stopped player) has nothing to capture; the
      // playback start creates the stream when live actually plays
      if (capture) this._createCaptureStream();
    } else {
```

The rest of the method is unchanged.

- [ ] **Step 4: Run the browser suite to verify it passes**

Run: `npm run test:browser > .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-t1.txt 2>&1; echo exit=$?; tail -5 .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-t1.txt; grep -c Unhandled .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-t1.txt`
Expected: `exit=0`, all tests passed, `0` Unhandled.

- [ ] **Step 5: Stage**

```bash
git add src/ui/ui.js tests/browser/ui-integration.test.js
```

---

### Task 2: Live engine — idle attach without capture, `pause()` guard, timers cancelled on every `stop()`, detached `setStreamURL()` branch removed

**Files:**

- Modify: `src/nimio-live.js:182-195` (`pause`), `:197-219` (`stop`), `:221-236` (`setStreamURL`), `:257` (`_attachUI(ui)` call in `attach`), `:516-519` (`_attachUI`)
- Test: `tests/nimio-live-attach.test.js`, `tests/nimio-live-after-destroy.test.js`, `tests/nimio-live.test.js:446-495`

**Interfaces:**

- Consumes: `UI.toggleMode(mode, { capture })` from Task 1 (stubbed in these tests).
- Produces: `NimioLive.prototype._attachUI(ui, { idle = false } = {})`; `pause()` no-op when `_state.isStopped()`; `stop()` calls `_cancelAutoplay()` and `_reconnect.stop()` before its early return; `setStreamURL()` has no `!this._ui` branch (the facade calls it only in live mode). Task 4 relies on the `stop()` and `setStreamURL()` behaviour.

- [ ] **Step 1: Write the failing tests for the idle attach**

In `tests/nimio-live-attach.test.js`, inside `describe("NimioLive.attach() idle", ...)`, replace the first test's `_attachUI` stub assertions and add a capture test:

```js
it("takes the UI, calls back and starts nothing", () => {
  const live = createLive({ connected: true, savedState: STATE.PLAYING });
  live._attachUI = vi.fn(function (ui) {
    this._ui = ui;
  });
  const ui = { showStopped: vi.fn() };
  const cb = vi.fn();

  expect(live.attach(ui, { latency: 0, idle: true }, cb)).toBe(true);

  expect(live._attachUI).toHaveBeenCalledWith(ui, { idle: true });
  expect(ui.showStopped).toHaveBeenCalledTimes(1); // the live stopped look
  expect(cb).toHaveBeenCalledTimes(1);
  expect(live._state.start).not.toHaveBeenCalled();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(live._sldpManager.start).not.toHaveBeenCalled();
  expect(live._sldpManager.requestCurrentStreams).not.toHaveBeenCalled();
});

it("an idle attach takes the UI without a capture stream; a normal attach with one", () => {
  const idleLive = createLive({ connected: false, savedState: STATE.PLAYING });
  idleLive._attachUI = NimioLive.prototype._attachUI;
  const idleUi = { toggleMode: vi.fn(), showStopped: vi.fn() };

  idleLive.attach(idleUi, { latency: 0, idle: true });

  expect(idleUi.toggleMode).toHaveBeenCalledWith(MODE.LIVE, { capture: false });
  expect(idleLive._ui).toBe(idleUi);

  const live = createLive({ connected: false, savedState: STATE.PLAYING });
  live._attachUI = NimioLive.prototype._attachUI;
  const ui = { toggleMode: vi.fn() };

  live.attach(ui, { latency: 0 });

  expect(ui.toggleMode).toHaveBeenCalledWith(MODE.LIVE, { capture: true });
});
```

Add `MODE` to the import: `import { STATE, MODE } from "@/shared/values";`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/nimio-live-attach.test.js 2>&1 | tail -25`
Expected: 2 FAIL — `toHaveBeenCalledWith(ui, { idle: true })` got `(ui)`; `toggleMode` called with `("live")` not `("live", { capture: false })`.

- [ ] **Step 3: Implement the idle attach**

In `src/nimio-live.js`:

```js
this._attachUI(ui, { idle: !!params.idle });
```

replaces `this._attachUI(ui);` at line 257, and

```js
  _attachUI(ui, { idle = false } = {}) {
    this._ui = ui;
    // an idle attach shows the stopped look; no capture stream for it
    this._ui.toggleMode(MODE.LIVE, { capture: !idle });
  }
```

replaces `_attachUI(ui)` at line 516.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/nimio-live-attach.test.js 2>&1 | tail -8`
Expected: all tests in the file pass.

- [ ] **Step 5: Write the failing `pause()` tests**

In `tests/nimio-live-after-destroy.test.js`, after "pause() on a destroyed engine does nothing":

```js
it("pause() on a stopped engine is a no-op", () => {
  // marking a stopped engine paused would make the next play() skip the
  // connection start and run a render loop with no stream
  const { live, flags } = createEngine();
  flags.stopped = true;

  live.pause();

  expect(live._state.pause).not.toHaveBeenCalled();
  expect(live._eventBus.emit).not.toHaveBeenCalled();
  expect(live._pauseTimeoutId).toBeUndefined();

  live.play();
  expect(live._sldpManager.start).toHaveBeenCalledTimes(1); // initial play
});

it("pause() on a paused engine is a no-op", () => {
  const { live, flags } = createEngine();
  flags.paused = true;

  live.pause();

  expect(live._state.pause).not.toHaveBeenCalled();
  expect(live._eventBus.emit).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run them to verify the first fails**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js -t "pause\(\) on a" 2>&1 | tail -20`
Expected: "pause() on a stopped engine is a no-op" FAIL — `_state.pause` called once; "pause() on a paused engine" PASS (existing guard).

- [ ] **Step 7: Implement the guard**

In `src/nimio-live.js` `pause()`:

```js
  pause() {
    // a stopped engine has nothing to pause; marking it paused would make
    // the next play() skip the connection start
    if (this._destroyed || this._state.isPaused() || this._state.isStopped())
      return;
```

- [ ] **Step 8: Run them to verify they pass**

Run: `npx vitest run tests/nimio-live-after-destroy.test.js 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 9: Write the failing `stop()` timer test**

In `tests/nimio-live-attach.test.js`, add a new describe at the end of the file:

```js
describe("NimioLive.stop() on a stopped engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // a just-constructed autoplay player and a dropped connection both leave
  // the engine stopped with a timer that would start playback later; a
  // stop() must cancel them even though it has nothing else to do
  it("cancels a pending reconnect and the autoplay timers", () => {
    const live = Object.create(NimioLive.prototype);
    live._state = { isStopped: () => true };
    live._transport = { connected: true }; // the drop notice is still in flight
    live._sldpManager = { stop: vi.fn() };
    live._reconnect = { stop: vi.fn(), reset: vi.fn() };
    live._autoplayTimers = [
      setTimeout(() => {}, 0),
      setTimeout(() => {}, 1000),
    ];

    live.stop();

    expect(live._reconnect.stop).toHaveBeenCalledTimes(1);
    expect(live._autoplayTimers).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(live._sldpManager.stop).toHaveBeenCalledWith({
      closeConnection: true,
    });
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run tests/nimio-live-attach.test.js -t "cancels a pending reconnect" 2>&1 | tail -20`
Expected: FAIL — `_reconnect.stop` not called (the early return runs first).

- [ ] **Step 11: Implement**

In `src/nimio-live.js` `stop()`:

```js
  stop(opts = {}) {
    // timers that would start playback after the stop: the autoplay of a
    // just-constructed player and a reconnect attempt. Cancelled before the
    // early return, since both run while the engine is already stopped.
    this._cancelAutoplay();
    this._reconnect.stop();
    const isStopped = this._state.isStopped();
```

`this._reconnect.reset()` later in the method stays (it also resets the attempt count).

- [ ] **Step 12: Run it to verify it passes, with the other live suites**

Run: `npx vitest run tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js 2>&1 | tail -8`
Expected: all pass. If a fixture lacks `_reconnect` or `_autoplayTimers` for a `stop()` path, add `_reconnect: { stop: vi.fn(), reset: vi.fn() }` / `_autoplayTimers: []` to that fixture and ledger it as a ruling.

- [ ] **Step 13: Replace the detached `setStreamURL()` tests**

In `tests/nimio-live.test.js`, replace the describe "NimioLive.setStreamURL() while detached" (lines 446–495) with:

```js
describe("NimioLive.setStreamURL() while stopped", () => {
  // the facade calls this only when the engine holds the UI (live mode);
  // a stopped engine picks the new URL up on its next play()
  function createStopped() {
    const live = Object.create(NimioLive.prototype);
    live._ui = {};
    live._transport = { connected: true };
    live._sldpManager = { stop: vi.fn() };
    live._state = { isStopped: () => true, isPlaying: () => false };
    live.stop = vi.fn();
    live.play = vi.fn();
    return live;
  }

  it("returns without stopping, playing or touching the session", () => {
    const live = createStopped();

    live.setStreamURL();

    expect(live._sldpManager.stop).not.toHaveBeenCalled();
    expect(live.stop).not.toHaveBeenCalled();
    expect(live.play).not.toHaveBeenCalled();
  });

  it("detached and stopped: the same, the session is the facade's business", () => {
    const live = createStopped();
    live._ui = undefined;

    live.setStreamURL();

    expect(live._sldpManager.stop).not.toHaveBeenCalled();
    expect(live.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 14: Run it to verify the detached test fails**

Run: `npx vitest run tests/nimio-live.test.js -t "setStreamURL\(\) while stopped" 2>&1 | tail -20`
Expected: "detached and stopped" FAIL — `_sldpManager.stop` called with `{ closeConnection: true }`.

- [ ] **Step 15: Remove the branch**

In `src/nimio-live.js` `setStreamURL()`, delete the `if (!this._ui) { ... return; }` block so the method reads:

```js
  // The URL is already updated in the config
  setStreamURL() {
    if (this._state.isStopped()) return;

    const playing = this._state.isPlaying();
    this.stop();
    if (playing) this.play();
  }
```

- [ ] **Step 16: Run the live suites**

Run: `npx vitest run tests/nimio-live.test.js tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 17: Stage**

```bash
git add src/nimio-live.js tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js
```

---

### Task 3: VOD engine — `play()` resumes buffering, `initialize()` from STOP re-enters SYNC

**Files:**

- Modify: `src/nimio-vod.js:90-135` (`initialize`), `:211-217` (`play`)
- Test: `tests/nimio-vod-lifecycle.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `NimioVod.prototype.play()` calls `this._pHandler.resumeBuffering()` before `handlePlay()`; `initialize()` sets `_state = VOD_STATE.SYNC` when it reloads from `STOP`, so `isRunning()` is true while the new playlist loads. Task 4's `stop()` relies on the latter.

- [ ] **Step 1: Write the failing tests**

Add `import { MODE } from "@/shared/values";` to the imports of
`tests/nimio-vod-lifecycle.test.js`, then append:

```js
describe("NimioVod.play() after an attach", () => {
  const NAME = "vod-play-buffering";

  afterEach(() => {
    releaseInstances(NAME);
  });

  // attach() pauses hls.js buffering and only the autoplay branch of
  // _onLevelLoaded resumed it: a VOD attached paused (a seek on a stopped
  // or paused player) could not be started by play()
  it("resumes buffering before playing", () => {
    const vod = new NimioVod(NAME, undefined);
    vod._state = 3; // PLAY, attached
    vod._ui = {};
    vod._pHandler = { resumeBuffering: vi.fn() };
    vod._playbackService = { handlePlay: vi.fn() };
    vod._eventBus = { emit: vi.fn() };

    vod.play();

    expect(vod._pHandler.resumeBuffering).toHaveBeenCalledTimes(1);
    expect(vod._playbackService.handlePlay).toHaveBeenCalledTimes(1);
    expect(
      vod._pHandler.resumeBuffering.mock.invocationCallOrder[0],
    ).toBeLessThan(vod._playbackService.handlePlay.mock.invocationCallOrder[0]);
    expect(vod._eventBus.emit).toHaveBeenCalledWith("nimio:play", {
      mode: MODE.VOD,
    });
  });
});

describe("NimioVod.initialize() from the stopped state", () => {
  const NAME = "vod-init-from-stop";

  afterEach(() => {
    releaseInstances(NAME);
  });

  function stoppedEngine(url) {
    const vod = new NimioVod(NAME, undefined);
    vod._loadSourcePromise = Promise.resolve();
    vod._state = 4; // STOP
    vod._url = "https://example.test/old.m3u8";
    vod._config = { url };
    vod._pHandler = { loadSource: vi.fn() };
    vod._fullUrl = () => vod._url;
    return vod;
  }

  // a URL change re-initialises a stopped engine; while the new playlist
  // loads the engine is running again (detached), so a later stop() stops
  // the background loading instead of ignoring it
  it("with a new URL reloads the source and is running again", async () => {
    const vod = stoppedEngine("https://example.test/new.m3u8");

    await vod.initialize();

    expect(vod._pHandler.loadSource).toHaveBeenCalledWith(
      "https://example.test/new.m3u8",
    );
    expect(vod._state).toBe(2); // SYNC
    expect(vod.isRunning()).toBe(true);
  });

  it("with the same URL does nothing and stays stopped", async () => {
    const vod = stoppedEngine("https://example.test/old.m3u8");

    await vod.initialize();

    expect(vod._pHandler.loadSource).not.toHaveBeenCalled();
    expect(vod._state).toBe(4);
    expect(vod.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify two fail**

Run: `npx vitest run tests/nimio-vod-lifecycle.test.js 2>&1 | tail -30`
Expected: "resumes buffering before playing" FAIL — `resumeBuffering` called 0 times; "with a new URL reloads the source and is running again" FAIL — `_state` is 4; "with the same URL" PASS (existing early return).

If `new NimioVod(NAME, undefined)` adds a script tag or creates services the test leaves behind, follow the stop-test fixture above it (it uses the same constructor) and ledger any extra stub as a ruling.

- [ ] **Step 3: Implement**

In `src/nimio-vod.js` `play()`:

```js
  play() {
    if (this._state !== VOD_STATE.PLAY || !this._ui) return;

    // attach() paused buffering; only the autoplay path resumed it. A VOD
    // attached paused (a seek on a stopped or paused player) starts here.
    // hls.js ignores the call when buffering is already enabled.
    this._pHandler.resumeBuffering();
    this._playbackService.handlePlay();
    this._eventBus.emit("nimio:play", { mode: MODE.VOD });
    this._grabber?.start(MODE.VOD);
  }
```

In `initialize()`, after the `INIT` block and before `this._url = this._config.url;`:

```js
if (this._state === VOD_STATE.STOP) {
  // a URL change reloads a stopped engine: it is loading again,
  // detached, which is what SYNC means; isRunning() is true so a
  // later stop() stops the background loading
  this._state = VOD_STATE.SYNC;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/nimio-vod-lifecycle.test.js tests/nimio-vod*.test.js tests/nimio-mode-switch.test.js 2>&1 | tail -8`
Expected: all pass (the mode-switch real-VOD-engine tests must keep passing: they attach from SYNC/PLAY, not from a reload).

- [ ] **Step 5: Stage**

```bash
git add src/nimio-vod.js tests/nimio-vod-lifecycle.test.js
```

---

### Task 4: Facade — stop-then-play URL change, one VOD start path, re-entrancy guard, stale-start generation, context reset

**Files:**

- Modify: `src/nimio.js:183-241` (`play`, `setStreamURL`, `pause`, `stop`, `seekVod`, `seekLive`), `:262-276` (`_runVodFromStart`), `:397-429` (`_onLivePlaybackError`, the `vodStarted = this._runVodFromStart();` call), `:465-476` (`_onPlaybackPositionChange`)
- Test: `tests/nimio-mode-switch.test.js`

**Interfaces:**

- Consumes: `NimioLive.stop()`/`play()`/`setStreamURL()` (Task 2), `NimioVod.stop()`/`isRunning()`/`isLoaded()`/`initialize()` (Task 3), `PlaybackContext.resetState()`/`setState()`/`state` (`src/playback/context.js`, existing).
- Produces: `Nimio.prototype._runVodFromStart(pos, { initial = false } = {})`; `_vodStartGen` (number) and `_stopping` (boolean) instance fields, initialised in `_init()` next to `_mode` (`this._vodStartGen = 0; this._stopping = false;`).

- [ ] **Step 1: Extend the fixtures**

In `tests/nimio-mode-switch.test.js`:

Import `STATE`: `import { MODE, ERROR, STATE } from "@/shared/values";`

In `fakeVod()`, add after `hasPlaybackErrors`:

```js
    isLoaded: () => true,
    initialize: vi.fn(() => Promise.resolve()),
```

In `createFacade()`, replace the `_ui` and `_context` lines with:

```js
n._ui = { id: "ui", destroy: vi.fn(), mediaElement: { id: "media" } };
n._context = {
  state: { value: STATE.STOPPED, initial: false },
  setState: vi.fn(function (value, initial) {
    this.state.value = value;
    if (initial !== undefined) this.state.initial = initial;
  }),
  resetState: vi.fn(function () {
    this.state.value = STATE.STOPPED;
    this.state.initial = false;
  }),
};
n._vodStartGen = 0;
n._stopping = false;
```

Add a helper after `createFacade`:

```js
async function microtasks(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
```

Run: `npx vitest run tests/nimio-mode-switch.test.js 2>&1 | tail -5`
Expected: all existing tests still pass (fixture-only change).

- [ ] **Step 2: Write the failing `stop()` tests**

In `describe("Nimio.stop()", ...)`:

Extend "in VOD mode returns to live, stopped, and a later play() starts live" with, before `n.play();`:

```js
expect(n._context.resetState).toHaveBeenCalledTimes(1);
```

Rewrite "a play() from the VOD playback-end listener is a no-op":

```js
it("play(), stop() and seekVod() from the VOD playback-end listener are ignored", () => {
  const n = createFacade({ mode: MODE.VOD });
  n._vodPlayer.stop = vi.fn(function (cb) {
    // application listeners of nimio:playback-end
    n.play();
    n.stop();
    n.seekVod(1);
    this.attached = false;
    this.running = false;
    if (cb) cb();
  });

  n.stop();

  expect(n._vodPlayer.play).not.toHaveBeenCalled();
  expect(n._livePlayer.play).not.toHaveBeenCalled();
  expect(n._vodPlayer.initialize).not.toHaveBeenCalled();
  expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1); // the nested stop was ignored
  expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
  expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
  expect(n._mode).toBe(MODE.LIVE);
  expect(n._actPlayer).toBe(n._livePlayer);
  expect(n._stopping).toBe(false); // released for the next call
});
```

Add:

```js
it("in live mode resets the context too", () => {
  const n = createFacade();
  n._context.state.value = STATE.PLAYING; // left by an earlier VOD detach

  n.stop();

  expect(n._context.resetState).toHaveBeenCalledTimes(1);
  expect(n._context.state).toEqual({ value: STATE.STOPPED, initial: false });
});

it("voids a VOD start still waiting for hls.js", async () => {
  const n = createFacade();
  n._vodPlayer.running = false;
  expect(n._runVodFromStart(5)).toBe(true);

  n.stop(); // before the initialize() promise resolves
  await microtasks();

  expect(n._vodPlayer.attach).not.toHaveBeenCalled();
  expect(n._mode).toBe(MODE.LIVE);
  expect(n._actPlayer).toBe(n._livePlayer);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/nimio-mode-switch.test.js -t "Nimio.stop\(\)" 2>&1 | tail -30`
Expected: 4 FAIL — `resetState` called 0 times (twice); the listener test: `_vodPlayer.play` called once / `_vodPlayer.stop` called twice; the pending start: `attach` called once.

- [ ] **Step 4: Implement `stop()`, the guards and `_runVodFromStart()`**

In `src/nimio.js`:

```js
  play() {
    if (this._destroyed || this._stopping) return;
    this._actPlayer?.play();
  }

  pause() {
    if (this._destroyed || this._stopping) return;
    this._actPlayer?.pause();
  }

  stop() {
    if (this._destroyed || this._stopping) return;
    this._stopping = true;
    try {
      // a switch in flight cannot complete into a stopped player; settle it
      // silently (no error: the stop is what the application asked for)
      this._cancelModeSwitch();
      // a VOD start still waiting for hls.js must not switch to VOD later
      this._vodStartGen++;
      // running covers the attached VOD engine (VOD mode), the warm detached
      // one (live mode) and one re-initialising after a URL change
      if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
      // a nimio:playback-end listener may have destroyed the player: the
      // engines are gone and the session closed, nothing left to hand over
      if (this._destroyed) return;
      // the VOD stop released the UI synchronously (before detaching media):
      // give it back to the live engine without starting it. A no-op when
      // the live engine already holds it.
      this._livePlayer.attach(this._ui, { latency: 0, idle: true });
      this._activate(this._livePlayer, MODE.LIVE);
      this._livePlayer.stop(); // also closes a kept-alive session
      // a stopped player presents a stopped context: the next VOD start
      // (a seek) opens paused, whatever the VOD detach recorded
      this._context.resetState();
    } finally {
      this._stopping = false;
    }
  }

  seekVod(position) {
    if (this._destroyed || this._stopping) return false;
    if (this._vodPlayer && this._vodPlayer.isRunning()) {
      return this._playProgressProxy.seekVod(position);
    }

    return this._runVodFromStart(position);
  }

  seekLive(buffer) {
    if (this._destroyed || this._stopping) return false;
    if (!this._playProgressProxy) return false;
    if (buffer === undefined || buffer === null) buffer = 0;
    return this._playProgressProxy.seekLive(buffer);
  }
```

```js
  // Start VOD from a non-running engine (stopped, or loaded but never
  // attached): the seek bar and seekVod() on a stopped or cold engine, and
  // the startup VOD failover. The engine re-initialises when its URL is
  // stale. `initial` marks the failover, where the autoplay setting decides;
  // everywhere else the VOD plays when the live engine was playing and
  // opens paused otherwise: the live detach records the engine's state in
  // the context and the VOD engine's _onLevelLoaded reads it.
  _runVodFromStart(pos, { initial = false } = {}) {
    if (!this._vodPlayer?.isLoaded() || this._vodPlayer.isRunning()) {
      return false;
    }
    const gen = ++this._vodStartGen;
    this._vodPlayer.initialize(this._ui.mediaElement).then(() => {
      // destroyed, stopped or re-targeted meanwhile: the start is void
      if (this._destroyed || gen !== this._vodStartGen) return;
      this._switchToVod(pos);
      this._context.setState(this._context.state.value, initial);
      this._context.autoAbr = !!this._config.adaptiveBitrate;
    });

    return true;
  }
```

In `_init()`, next to the `_mode` initialisation: `this._vodStartGen = 0; this._stopping = false;`.

- [ ] **Step 5: Run the stop tests to verify they pass**

Run: `npx vitest run tests/nimio-mode-switch.test.js -t "Nimio.stop\(\)" 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Write the failing `setStreamURL()` tests**

Replace the body of `describe("Nimio.setStreamURL()", ...)` with:

```js
describe("Nimio.setStreamURL()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const order = (fn) => fn.mock.invocationCallOrder[0];
  const idle = { latency: 0, idle: true };

  it("in VOD mode stops and starts live with the new URL, no switch", () => {
    const n = createFacade({ mode: MODE.VOD });

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/new");
    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._vodPlayer.detach).not.toHaveBeenCalled();
    expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.attach).toHaveBeenCalledWith(n._ui, idle);
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
    expect(order(n._livePlayer.stop)).toBeLessThan(order(n._livePlayer.play));
    expect(n._livePlayer.setStreamURL).not.toHaveBeenCalled();
    expect(n._context.resetState).toHaveBeenCalledTimes(1);
    expect(n._modeSwitch ?? null).toBeNull();
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
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in VOD mode a destroy() from the playback-end listener leaves it silent", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._instName = "sw-url-destroy";
    n._removeVolumeEventHandlers = vi.fn();
    n._livePlayer.destroy = vi.fn();
    n._vodPlayer.destroy = vi.fn();
    const livePlay = n._livePlayer.play;
    n._vodPlayer.stop = vi.fn(function () {
      n.destroy();
      this.attached = false;
      this.running = false;
    });

    expect(() => n.setStreamURL("wss://example.test/new")).not.toThrow();

    expect(n._destroyed).toBe(true);
    expect(livePlay).not.toHaveBeenCalled();
  });

  it("during a pending switch settles it silently and starts live with the new URL", () => {
    const n = createFacade();
    n._switchToVod(1);
    expect(n._mode).toBe(MODE.PEND);
    const late = n._vodPlayer.pendingAttach;

    n.setStreamURL("wss://example.test/new");

    expect(n._modeSwitch).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1); // it held the UI
    expect(n._livePlayer.attach).toHaveBeenLastCalledWith(n._ui, idle);
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
    expect(n._logger.warn).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
    expect(n._actPlayer).toBe(n._livePlayer);
    expect(n._eventBus.emit).not.toHaveBeenCalled();

    late(); // the settled switch ignores its late completion
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("re-entrant from the VOD playback-end listener: the newest URL is recorded and played once", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._vodPlayer.stop = vi.fn(function (cb) {
      n.setStreamURL("wss://example.test/newer"); // an application listener
      this.attached = false;
      this.running = false;
      if (cb) cb();
    });

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/newer");
    expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("a setStreamURL() from the nimio:play listener of the restart takes the live-mode path once", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._livePlayer.play = vi.fn(() => {
      n.setStreamURL("wss://example.test/newer"); // a listener of nimio:play LIVE
    });

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/newer");
    expect(n._livePlayer.play).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1); // live mode by then
    expect(n._livePlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in live mode with an unchanged VOD URL only tells the live engine", () => {
    const n = createFacade();
    n._config.vod = { url: "https://example.test/archive.m3u8" };
    n._vodPlayer.running = true; // warm

    n.setStreamURL("wss://example.test/new");

    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
    expect(n._vodPlayer.stop).not.toHaveBeenCalled();
    expect(n._livePlayer.attach).not.toHaveBeenCalled();
    expect(n._livePlayer.play).not.toHaveBeenCalled();
    expect(n._vodPlayer.detach).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in live mode stops a running VOD engine whose URL changed", () => {
    const n = createFacade();
    n._config.vod = { url: "https://example.test/old.m3u8" };
    n._vodPlayer.running = true; // warm, or reloading

    n.setStreamURL({
      live: "wss://example.test/new",
      vod: "https://example.test/new.m3u8",
    });

    expect(n._vodPlayer.stop).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
    expect(n._livePlayer.play).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in live mode with a cold VOD engine a changed VOD URL stops nothing", () => {
    const n = createFacade();
    n._config.vod = { url: "https://example.test/old.m3u8" };
    n._vodPlayer.running = false;
    n._vodPlayer.isLoaded = () => false;

    expect(() =>
      n.setStreamURL({
        live: "wss://example.test/new",
        vod: "https://example.test/new.m3u8",
      }),
    ).not.toThrow();

    expect(n._vodPlayer.stop).not.toHaveBeenCalled();
    expect(n._livePlayer.setStreamURL).toHaveBeenCalledTimes(1);
  });

  it("in live mode a changed VOD URL voids a pending VOD start", async () => {
    const n = createFacade();
    n._config.vod = { url: "https://example.test/old.m3u8" };
    n._vodPlayer.running = false;
    expect(n._runVodFromStart(5)).toBe(true);

    n.setStreamURL({
      live: "wss://example.test/new",
      vod: "https://example.test/new.m3u8",
    });
    await microtasks();

    expect(n._vodPlayer.attach).not.toHaveBeenCalled();
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("in live mode an unchanged VOD URL keeps a pending VOD start", async () => {
    const n = createFacade();
    n._config.vod = { url: "https://example.test/archive.m3u8" };
    n._vodPlayer.running = false;
    expect(n._runVodFromStart(5)).toBe(true);

    n.setStreamURL("wss://example.test/new");
    await microtasks();

    expect(n._vodPlayer.attach).toHaveBeenCalledWith(
      n._ui,
      5,
      expect.any(Function),
    );
  });

  it("on a destroyed player does nothing", () => {
    const n = createFacade({ mode: MODE.VOD });
    n._destroyed = true;

    n.setStreamURL("wss://example.test/new");

    expect(n._config.streamUrl).toBe("wss://example.test/old");
    expect(n._livePlayer.setStreamURL).not.toHaveBeenCalled();
    expect(n._livePlayer.play).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run tests/nimio-mode-switch.test.js -t "Nimio.setStreamURL\(\)" 2>&1 | tail -40`
Expected: FAIL for the VOD-mode, object-form, destroy, pending-switch, re-entrant, play-listener, changed-VOD-URL, cold-engine and pending-start tests (the old code switches or warns, never calls `play()`, never stops the VOD engine in live mode); PASS for "unchanged VOD URL only tells the live engine", "keeps a pending VOD start" and "destroyed".

- [ ] **Step 8: Implement `setStreamURL()`**

```js
  setStreamURL(url) {
    if (this._destroyed) return;
    const prevVodUrl = this._config.vod?.url;
    updateConfigStreamURL(this._config, url);
    // re-entrant from a listener of a stop in progress: the outer call
    // continues with the newest config
    if (this._stopping) return;
    if (this._mode === MODE.LIVE) {
      if (this._config.vod?.url !== prevVodUrl) {
        // a pending VOD start would attach the old URL; a running engine
        // re-initialises with the new URL on the next
        // nimio:connection-established and must not be attachable before
        this._vodStartGen++;
        if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
      }
      // playing: stop + play; paused: stop; stopped: nothing (#98)
      this._livePlayer.setStreamURL();
      return;
    }
    // VOD mode or a pending switch: stop (VOD stopped, live idle with the
    // UI, kept-alive session closed, context reset), then an initial live
    // play with the new URL. One connection; no path back to the old
    // archive.
    this.stop();
    if (this._destroyed) return;
    this._livePlayer.play();
  }
```

- [ ] **Step 9: Run them to verify they pass**

Run: `npx vitest run tests/nimio-mode-switch.test.js -t "Nimio.setStreamURL\(\)" 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 10: Write the failing VOD-start tests**

Add a new describe after "Nimio.setStreamURL()":

```js
describe("Nimio VOD start from a non-running engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function liveDetachRecording(n, value) {
    // the real live detach writes the engine's state into the context
    n._livePlayer.detach = vi.fn(function (cb) {
      this.attached = false;
      n._context.setState(value, false);
      if (cb) cb();
      return true;
    });
  }

  it("a position change into a non-running VOD engine re-initialises and starts it", async () => {
    const n = createFacade();
    n._vodPlayer.running = false; // stopped: attachable with a stale URL otherwise

    expect(n._onPlaybackPositionChange(MODE.VOD, 7)).toBe(true);
    await microtasks();

    expect(n._vodPlayer.initialize).toHaveBeenCalledWith(n._ui.mediaElement);
    expect(n._vodPlayer.attach).toHaveBeenCalledWith(
      n._ui,
      7,
      expect.any(Function),
    );
  });

  it("a position change into a running VOD engine switches directly", () => {
    const n = createFacade();
    n._vodPlayer.running = true;

    expect(n._onPlaybackPositionChange(MODE.VOD, 7)).toBe(true);

    expect(n._vodPlayer.initialize).not.toHaveBeenCalled();
    expect(n._vodPlayer.attach).toHaveBeenCalledWith(
      n._ui,
      7,
      expect.any(Function),
    );
  });

  it("a position change into VOD without a VOD engine returns false", () => {
    const n = createFacade();
    n._vodPlayer = undefined;

    expect(n._onPlaybackPositionChange(MODE.VOD, 7)).toBe(false);
    expect(n._mode).toBe(MODE.LIVE);
  });

  it("keeps the context value the live detach wrote: stopped player → paused VOD", async () => {
    const n = createFacade();
    n._vodPlayer.running = false;
    liveDetachRecording(n, STATE.STOPPED);

    n._runVodFromStart(3);
    await microtasks();

    expect(n._context.state).toEqual({ value: STATE.STOPPED, initial: false });
  });

  it("keeps the context value the live detach wrote: playing player → playing VOD", async () => {
    const n = createFacade();
    n._vodPlayer.running = false;
    liveDetachRecording(n, STATE.PLAYING);

    n._runVodFromStart(3);
    await microtasks();

    expect(n._context.state).toEqual({ value: STATE.PLAYING, initial: false });
  });

  it("marks the startup failover as initial, so the autoplay setting decides", async () => {
    const n = createFacade();
    n._vodPlayer.running = false;
    liveDetachRecording(n, STATE.STOPPED);

    n._runVodFromStart(undefined, { initial: true });
    await microtasks();

    expect(n._context.state).toEqual({ value: STATE.STOPPED, initial: true });
  });

  it("the NO_SRC startup failover starts VOD as initial", () => {
    const n = createFacade();
    n._config.vod = { startupVodFailover: true };
    n._runVodFromStart = vi.fn(() => true);

    n._onLivePlaybackError("NO_SRC", true);

    expect(n._runVodFromStart).toHaveBeenCalledWith(undefined, {
      initial: true,
    });
    expect(n._eventBus.emit).not.toHaveBeenCalled();
  });

  it("a newer start supersedes a pending one", async () => {
    const n = createFacade();
    n._vodPlayer.running = false;

    n._runVodFromStart(1);
    n._runVodFromStart(2);
    await microtasks();

    expect(n._vodPlayer.attach).toHaveBeenCalledTimes(1);
    expect(n._vodPlayer.attach).toHaveBeenCalledWith(
      n._ui,
      2,
      expect.any(Function),
    );
  });

  it("returns false for a cold engine and for a running one", () => {
    const cold = createFacade();
    cold._vodPlayer.isLoaded = () => false;
    expect(cold._runVodFromStart(1)).toBe(false);

    const running = createFacade();
    running._vodPlayer.running = true;
    expect(running._runVodFromStart(1)).toBe(false);
  });
});
```

- [ ] **Step 11: Run them to verify the right ones fail**

Run: `npx vitest run tests/nimio-mode-switch.test.js -t "VOD start from a non-running engine" 2>&1 | tail -40`
Expected: FAIL — "position change into a non-running VOD engine" (`initialize` not called: the old code switches directly); "stopped player → paused VOD" (`initial` is true); "playing player → playing VOD" (value restored to STOPPED, initial true); "failover as initial" passes only if Step 4 already set `initial`; "NO_SRC startup failover" (`called with ()`); "newer start supersedes" (attach called twice). PASS — "running engine switches directly", "without a VOD engine", "returns false".

- [ ] **Step 12: Implement the routing and the failover call**

```js
_onPlaybackPositionChange = (mode, val) => {
  this._logger.debug(
    `_onPlaybackPositionChange new mode = ${mode}, value = ${val}, cur mode = ${this._mode}`,
  );
  if (this._destroyed || this._stopping || this._mode === MODE.PEND) {
    return false;
  }

  if (mode === this._mode) {
    return this._actPlayer.goto(val);
  }

  if (mode === MODE.VOD && !this._vodPlayer?.isRunning()) {
    // the seek bar and seekVod() share one path into a non-running
    // engine: a stopped engine is attachable as-is and would play the
    // URL it was stopped with
    return this._runVodFromStart(val);
  }

  return mode === MODE.VOD ? this._switchToVod(val) : this._switchToLive(val);
};
```

In `_onLivePlaybackError()`:

```js
vodStarted = this._runVodFromStart(undefined, { initial: true });
```

- [ ] **Step 13: Run the whole facade file, then the suite**

Run: `npx vitest run tests/nimio-mode-switch.test.js 2>&1 | tail -8 && npx vitest run 2>&1 | tail -6`
Expected: all pass in the file; the full suite green. A failure in another file that stubs the facade (e.g. a fixture without `_context.resetState` or `_stopping`) is a fixture gap: add the stub and ledger it.

- [ ] **Step 14: Stage**

```bash
git add src/nimio.js tests/nimio-mode-switch.test.js
```

---

### Task 5: README, full verification, the code commit

**Files:**

- Modify: `README.md:230-231` (`stop()`), `:237-238` (`seekVod`), `:249-250` (`setStreamURL`), `:377-378` (`nimio:playback-end`)

**Interfaces:**

- Consumes: the behaviour of Tasks 1–4.
- Produces: the committed code; the plan commit follows.

- [ ] **Step 1: README**

Replace line 231 (`  Stop and reset the player.`) with:

```
  Stops playback and resets the player. Emits `nimio:playback-end` with the mode that was playing. Afterwards the player is in live mode, stopped: `play()` starts the live stream, `seekVod()` opens the VOD at the position, paused.
```

Append to line 238 (the `seekVod` description, before the trailing `\`):

```
 On a stopped or paused player the VOD opens paused at the position; during live playback it continues playing.
```

Replace line 250 with:

```
  Switches the player to another stream without recreating it. A playing player reconnects to the new stream right away; a player in VOD mode, playing or paused, switches to live and plays the new stream. A paused or stopped live player uses the new URL on the next `play()`. Switching emits `nimio:playback-end` (with the mode that was playing) followed by `nimio:play`, as with `stop()` and `play()`.
```

Replace line 378 (`  Playback reached the end of the media.  `) with:

```
  Playback ended: the media reached its end, or `stop()` / `setStreamURL()` ended it. `mode` is the mode that was playing.
```

Run: `git diff --stat README.md && grep -n "Stops playback and resets\|opens paused at the position\|playing or paused, switches to live\|or \`stop()\` / \`setStreamURL()\` ended it" README.md`
Expected: 4 matching lines, 1 file changed.

- [ ] **Step 2: Full verification**

Run: `npx prettier --check src tests 2>&1 | tail -2; npx vitest run > .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/vitest-final.txt 2>&1; tail -6 .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/vitest-final.txt; npm run test:browser > .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-final.txt 2>&1; echo exit=$?; tail -5 .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-final.txt; grep -c Unhandled .superpowers/sdd/2026-10-19-vod-stop-and-stream-url-review-fixes/browser-final.txt`
Expected: prettier "All matched files use Prettier code style!", vitest all passed, browser `exit=0`, `0` Unhandled. Fix anything red before the commit (prettier: `npx prettier --write` on the offending file).

- [ ] **Step 3: Matrix check against the tests**

Run: `grep -c "  it(" tests/nimio-mode-switch.test.js tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-vod-lifecycle.test.js tests/nimio-live.test.js tests/browser/ui-integration.test.js`
Then walk spec tables A and B row by row and confirm each row the fakes can express has a test from Tasks 1–4 (the rows "LIVE reconnecting" and "VOD paused" are covered by the engine-level `stop()`/`setStreamURL()` behaviour and the facade's VOD-mode test respectively; note that in the ledger). Any row without a test gets one now, RED→GREEN, in the owning file.

- [ ] **Step 4: Commit the code**

```bash
git add src/nimio.js src/nimio-live.js src/nimio-vod.js src/ui/ui.js README.md tests/nimio-mode-switch.test.js tests/nimio-live-attach.test.js tests/nimio-live-after-destroy.test.js tests/nimio-live.test.js tests/nimio-vod-lifecycle.test.js tests/browser/ui-integration.test.js
git reset -q -- docs
git commit -F - <<'MSG'
Stop and restart live on a stream URL change in VOD mode; one stopped state

Changes after the review of PR #104.

Facade: a URL change in VOD mode or during a pending switch stops the
player and starts live with the new URL (no mode switch, no path back to
the old archive); in live mode it stops a running VOD engine when the VOD
URL changed, so the next VOD start re-initialises with the new one. The
seek bar and seekVod() share one path into a non-running VOD engine, which
re-initialises a stopped engine instead of attaching it with the URL it
was stopped with. stop() resets the playback context, so a later seek
opens the VOD paused; a VOD start still waiting for hls.js is dropped by a
generation check; calls from listeners of a stop in progress are ignored
(setStreamURL() records the URL for the outer call).

Live engine: pause() refuses a stopped engine; stop() cancels the autoplay
and reconnect timers before its early return; an idle attach creates no
capture stream; the detached setStreamURL() branch is gone.

VOD engine: play() resumes hls.js buffering (an attach without autoplay
could not be started); initialize() from the stopped state re-enters SYNC
while the new playlist loads, so a later stop() sees it.

UI: toggleMode(mode, { capture }).

README: stop(), setStreamURL(), seekVod() and nimio:playback-end describe
the stopped state and the events.
MSG
git log --oneline -1
```

Expected: one commit with exactly the eleven files above; `git status --short | grep -v '^??'` shows only the plan file (modified/untracked) afterwards.

- [ ] **Step 5: Plan commit**

```bash
git add docs/superpowers/plans/2026-10-19-vod-stop-and-stream-url-review-fixes.md
git commit -q -m "Add implementation plan for the PR #104 review fixes"
```
