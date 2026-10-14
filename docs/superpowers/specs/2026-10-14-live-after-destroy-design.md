# Live engine after destroy — Design

**Date:** 2026-10-14
**Branch:** `fix/live-after-destroy`, stacked on PR 3a's code branch
`fix/lifecycle-hardening-pr` (`1ac05c2`) → PR 2b (`9ae6ca5`) → PR 2a
(`2e7a7da`) → PR 1 (`efe8964`) → upstream `main` (`f2d6eea`).
**Status:** Approved design, awaiting implementation plan
**Origin:** PR 3b, the last of the series replacing PR #92.

## Goal

A destroyed live engine does nothing afterwards: no public method acts on it,
no timer or listener restarts it, no render frame leaks, and a constructor
that fails after the transport worker exists releases that worker. Three
small gaps found while reviewing the earlier PRs are closed with it: a
reconnect surviving a detach, a late audio header for a dropped main flow, a
native Picture-in-Picture grant after the UI was torn down, and the VU meter
UI starting a new animation loop per `create()`.

## Problems (verified in the code at `1ac05c2`)

- `NimioLive` has no destroyed flag. `play()` and `pause()` run on a destroyed
  engine. `play()` emits `nimio:play` and then calls `sldpManager.start()`,
  which emits `nimio:connection-started`; `attach()` does the same after its
  start. A listener that destroys or stops the player from either event
  leaves a started state, a connection request and a running overlay behind.
  `destroy()` is not idempotent on its own; only the facade guards it.
- `_renderVideoFrame()` emits `nimio:playback-start` on the first frame and
  then draws it. A listener that destroys or stops the player makes the draw
  hit a cleared UI, and a listener that throws leaves the popped frame open.
- The autoplay `play()` and hide-controls timers are untracked: they fire
  after a destroy, including after a facade constructor rollback.
- `detach()` calls `stop({ keepConnection: true })`, which returns early on an
  engine that `_onDisconnect()` already stopped, so the reconnect that
  `_onDisconnect()` scheduled still fires `play()` on a detached engine whose
  UI is gone.
- `_onAudioCodecDataReceived()`, main-track branch: after the main audio flow
  was dropped (incompatible update, PR 2b), a late header for the cancelled
  next track lands in this branch with `_decoderFlows.audio === null` and
  throws, on both the incompatible path (`destroy()` on null) and the
  compatible one (`setCodecData()` on null).
- The constructor creates the transport worker in `_initTransport()` and then
  the SLDP manager, reconnector, audio services, ABR, latency controller,
  grabber. A throw in any of those leaves the worker, the bus subscriptions
  and the reconnector behind; the facade's rollback never sees the engine.
- `_toggieVideoPip()` awaits `requestPictureInPicture()` with no generation
  guard: a grant after the UI was destroyed leaves a PiP window of the
  detached video open, and a rejection runs `_handleLeavePip()`, which calls
  `play()` on an element whose capture stream is gone and arms a 250 ms
  layout timer. `_cleanupPip()` does not exit an active native PiP window.
- `VUMeterUI.create()` starts `_drawMeter()`, which reschedules itself while
  `_fullValue` is set; `refresh()` calls `destroy(true)` then `create()` in
  the same frame, so the old loop's next callback finds the flag set again
  and continues: one more loop per resize.

## Non-goals

- Anything in the facade, the service registry, the SLDP manager, the
  transport or the decoder flows beyond what the earlier PRs shipped.
- Re-architecting the render loop or the event emission order.

## Design

### 1. Engine flag and guards (`src/nimio-live.js`)

```js
play() {
  if (this._destroyed || this._state.isPlaying()) return;
  // ... unchanged up to the emit
  this._eventBus.emit("nimio:play", { mode: MODE.LIVE });
  // a listener may have destroyed or stopped the player
  if (this._destroyed || this._state.isStopped()) return;
  this._playbackStarted = false;
  requestAnimationFrame(this._renderVideoFrame);
  if (initialPlay) {
    this._sldpManager.start(this._config.streamUrl, this._config.startOffset);
    // start() emits nimio:connection-started; a listener may destroy/stop us
    if (this._destroyed || this._state.isStopped()) return;
    if (this._debugView) this._debugView.start();
  } else if (this._audioCtxProvider.isSuspended()) {
    this._audioCtxProvider.get().resume();
  }
}

pause() {
  if (this._destroyed || this._state.isPaused()) return;
  // ... unchanged
}

attach(ui, params, callback) {
  if (this._ui || this._destroyed) return false;
  // ... unchanged through the start/requestCurrentStreams call
  // start() emits nimio:connection-started; a listener may destroy/stop us
  if (this._destroyed || this._state.isStopped()) return false;
  if (this._debugView) this._debugView.start();
  if (callback) callback();
  return true;
}

destroy() {
  if (this._destroyed) return; // the facade and a rollback may both call it
  this._destroyed = true;
  // ... stages as today; the "media resources" stage also cancels autoplay
}

_renderVideoFrame() {
  if (this._destroyed || this._noVideo || !this._state.isPlaying()) return true;
  // ...
  if (!this._playbackStarted && !this._startPlaybackOutput(frame)) return false;
  // ... draw as today
}

// First rendered frame: notify the application, then start the grabber.
// Returns false (and closes the frame) when a listener destroyed or stopped
// the player meanwhile.
_startPlaybackOutput(frame) {
  this._playbackStarted = true;
  try {
    this._eventBus.emit("nimio:playback-start", { mode: MODE.LIVE });
  } catch (err) {
    // an application listener failed (possibly while destroying us); the
    // popped frame must still be handled below
    this._logger.error("nimio:playback-start listener failed", err);
  }
  if (this._destroyed || this._state.isStopped()) {
    frame.close(); // the buffer it came from was cleared by the stop
    return false;
  }
  this._grabber?.start(MODE.LIVE);
  return true;
}
```

`attach()` returning `false` after a listener stopped it tells PR 91's mode
switch that the attach did not start, which it handles as "attach refused".

### 2. Autoplay timers

```js
// constructor
this._playCb = this.play.bind(this);
this._autoplayTimers = [];
if (this._config.autoplay) this._scheduleAutoplay();

_scheduleAutoplay() {
  this._autoplayTimers = [
    setTimeout(this._playCb, 0),
    setTimeout(() => {
      if (this._ui) this._ui.hideControls(true);
    }, 1000),
  ];
}

_cancelAutoplay() {
  // tolerates a rollback from before _init() reached the timers
  for (const id of this._autoplayTimers || []) clearTimeout(id);
  this._autoplayTimers = [];
}
```

`_releaseMediaResources()` calls `_cancelAutoplay()` next to
`_cancelPauseTimeout()`.

### 3. Reconnector on detach

`detach()` calls `this._reconnect.stop();` right after
`this.stop({ keepConnection: true });`. The count is left alone: a later
`attach()` reconnects with the budget it had.

### 4. Null main audio flow (`src/nimio-transport.js`)

The main-track `else` branch of `_onAudioCodecDataReceived()` starts with:

```js
if (!this._decoderFlows["audio"]) {
  // the main audio stream was dropped: a late header (e.g. for a cancelled
  // next track) means nothing now
  return;
}
```

### 5. Constructor rollback (`src/nimio-live.js`)

The constructor keeps its field setup through `this._ui = ui` and the
logger, then:

```js
try {
  this._init();
} catch (err) {
  this._rollbackInit();
  throw err;
}

_rollbackInit() {
  this._destroyed = true;
  runCleanupSteps(this._logger, "init rollback", [
    ["autoplay", () => this._cancelAutoplay()],
    ["UI handlers", () => this._removeUIEventHandlers()],
    ["transport handlers", () => this._transport && this._deinitTransport()],
    ["sync-mode handler", () => this._onSyncModeParams && this._eventBus.off("nimio:sync-mode-params", this._onSyncModeParams)],
    ["reconnector", () => this._reconnect?.destroy()],
    ["SLDP manager", () => this._sldpManager?.destroy()],
    ["overlay", () => this._debugView?.stop()],
    ["transport", () => this._transport?.destroy()],
  ]);
}
```

`_init()` is today's constructor body from the shared buffer on. Fields
created later in `_init()` are tested for existence because the throw can
come from any point. The UI handler removal needs no guard: the bus's `off()`
(tseep) ignores a handler that was never registered, and `_addUIEventHandlers()`
runs before anything that can throw.

### 6. Native Picture-in-Picture (`src/ui/ui-pip.js`)

```js
async _toggieVideoPip(ev) {
  // ... unchanged
  const gen = (this._pipRequestGen = this._pipRequestGen || 0);
  await this._mediaElement.requestPictureInPicture().catch((err) => {
    if (gen !== this._pipRequestGen) return; // torn down meanwhile
    this._logger.error("Failed to enter PiP mode", err);
    this._handleLeavePip();
  });
  if (gen !== this._pipRequestGen) {
    // the UI was torn down while the request was pending
    if (document.pictureInPictureElement === this._mediaElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    return;
  }
  this._buttonPictureInPicture.disabled = false;
}
```

`_cleanupPip()`, after bumping the generation: if the media element exists
and `document.pictureInPictureElement === this._mediaElement`, call
`document.exitPictureInPicture().catch(() => {})`, so a destroyed player's
native PiP window closes instead of showing a dead video.

### 7. VU meter UI animation loop (`src/vumeter/ui.js`)

`_drawGen` starts at 0 in the constructor; `destroy()` increments it next to
clearing `_fullValue`. `create()` calls `_drawMeter(this._drawGen)`; the
scheduled callback passes the generation it was started with and returns when
it is stale:

```js
_drawMeter(gen) {
  if (!this._fullValue || gen !== this._drawGen) return;
  // ... level updates
  window.requestAnimationFrame(() => this._drawMeter(gen));
}
```

## Error handling

- A throwing `nimio:playback-start` listener is logged; the frame is still
  closed or drawn.
- `_rollbackInit()` never throws: isolated steps, existence-guarded.
- Stale PiP completions swallow `exitPictureInPicture()` rejections.

## Testing (vitest, jsdom; engines built from the prototype)

- `tests/nimio-live-after-destroy.test.js` (new): `play()` and `pause()`
  are no-ops on a destroyed engine; `destroy()` twice runs the stages once; a `nimio:play`
  listener that destroys (and one that stops) prevents the connection start
  and the overlay; a `nimio:connection-started` listener that stops prevents
  the overlay start on `play()` and makes `attach()` return `false` without
  starting the overlay; `_releaseMediaResources()` cancels the autoplay
  timers; `detach()` stops a scheduled reconnect (in `tests/nimio-live.test.js`).
- `tests/nimio-live-init.test.js` (new): a constructor failure after
  `_initTransport()` and the autoplay scheduling (the media grabber module
  mocked to throw, `Worker` stubbed) terminates the worker, cancels autoplay,
  unsubscribes everything and rethrows; `_rollbackInit()` before the
  transport exists does not throw; a failing rollback step is logged and the
  others still run.
- `tests/nimio-live-render.test.js` (new): first frame with a listener that
  destroys the player closes the frame, starts no grabber and draws nothing;
  with a listener that throws, the frame is drawn and the error logged; a
  normal first frame starts the grabber once.
- `tests/nimio-transport-switch.test.js`: a main-track header with a null
  audio flow is ignored on both the compatible and the incompatible path.
- `tests/ui-pip-lifecycle.test.js`: a native grant after cleanup exits PiP
  and skips the leave handling; a rejection after cleanup runs no leave
  handling; cleanup with an active native PiP element exits it.
- `tests/vumeter-ui.test.js`: `refresh()` with a changed size leaves one
  animation loop.

Suite-level: `npx vitest run`, `npm run prettier:check`; `npm run
test:browser` to confirm nothing in the UI suites regressed.

## Delivery

- One code commit on a code-only branch `fix/live-after-destroy-pr` stacked
  on `fix/lifecycle-hardening-pr`; spec and plan local.
- PR title: "Keep a destroyed live engine inert".
