# Stop and stream URL change in VOD mode — Design

**Date:** 2026-10-16
**Branch:** `fix/vod-stop-and-stream-url`, from upstream `main` (`0fcce53`).
**Status:** Approved design, awaiting implementation plan
**Origin:** design review H2, the part left after #98 added
`NimioLive.setStreamURL()`.

## Goal

`Nimio.stop()` while watching VOD leaves the player in live mode, stopped,
exactly like a player stopped in live mode: `play()` starts live again,
`seekVod()` restarts VOD. `Nimio.setStreamURL()` while watching VOD switches
to live and plays the new URL with one connection, through the mode-switch
routine #91 added, so a failure restores VOD and is reported. The facade's
active player and mode are written in one place.

## Problems (verified in the code at `0fcce53`)

- `Nimio.stop()` in VOD mode (`src/nimio.js:205`) stops the VOD engine and,
  in the callback, calls `this._livePlayer.attach(this._ui)` and
  `this._livePlayer.stop()`. `NimioLive.attach()` always starts playback
  (state, render loop, a server Play request), so the server sees Play then
  Cancel and close. `_actPlayer` and `_mode` are never updated: the VOD
  engine is in its STOP state (not running, its `play()` a no-op), so a
  later `play()` does nothing, `setStreamURL()` reaches a stopped live
  engine and returns, and `seekLive()` runs a switch whose VOD detach is
  refused (the engine is not in PLAY). The player is dead until reload.
- `Nimio.setStreamURL()` in VOD mode (`src/nimio.js:187`) has the same
  shape: the config is updated first, the live attach connects to the new
  URL, and the engine's `setStreamURL()` then stops and reconnects a second
  time. The facade stays in VOD mode with the VOD engine active while live
  plays: `play()`/`pause()` go to the stopped VOD engine, `seekVod()` returns
  false, `seekLive()` fails with a mode-switch error.
- A kept-alive live session belongs to the URL it was started with. After a
  URL change, `attach()`'s reuse path (`transport.connected &&
sessionReady`) would request the old URL's streams. `SLDPManager.stop({
closeConnection: true })` does not clear `_sessionReady`, and the adapter
  reports `connected` false only when the worker's close notification
  arrives, so an attach right after a close would still take the reuse path.
- The mode-switch routine writes `_actPlayer`/`_mode` in `_finishModeSwitch()`
  and `_restoreMode()`; the constructor and `destroy()` write them too. The
  two broken methods wrote neither.

## Non-goals

- Changing how `_switchMode()` detaches and attaches, its timeout, or its
  error reporting.
- `setStreamURL()` in live mode (handled by the engine since #98) and the
  VOD URL update inside `updateConfigStreamURL()`.
- The engine's coupled attach for the normal switch; only an `idle` option
  is added.

## Design

### 1. Facade (`src/nimio.js`)

```js
stop() {
  if (this._destroyed) return;
  // a switch in flight cannot complete into a stopped player; settle it
  // silently (no error: the stop is what the application asked for)
  this._cancelModeSwitch();
  // running covers both the attached VOD engine (VOD mode) and the warm,
  // detached one that reloads levels in the background (live mode)
  if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
  // the VOD stop released the UI synchronously (before detaching media);
  // give it back to the live engine without starting it. A no-op when the
  // live engine already holds it.
  this._livePlayer.attach(this._ui, { latency: 0, idle: true });
  this._activate(this._livePlayer, MODE.LIVE);
  this._livePlayer.stop(); // also closes a kept-alive session
}

setStreamURL(url) {
  if (this._destroyed) return;
  updateConfigStreamURL(this._config, url);
  // detached (VOD mode or a pending switch): closes the kept-alive session
  // of the old URL so the next attach handshakes; attached: stop + play
  this._livePlayer.setStreamURL();
  if (this._mode === MODE.VOD) {
    this._switchMode(MODE.LIVE, { latency: 0 });
  } else if (this._mode === MODE.PEND) {
    this._logger.warn("Stream URL changed during a mode switch; applied on the next attach");
  }
}

// The only writer of the active player and the mode.
_activate(player, mode) {
  this._actPlayer = player;
  this._mode = mode;
}
```

`_finishModeSwitch()` (`this._mode = sw.target`) and `_restoreMode()`
(`this._actPlayer = sw.prevPlayer; this._mode = sw.prevMode`) call
`_activate()`; the switch's detach callback (`this._actPlayer =
sw.nextPlayer`) sets the active player through it too, with the mode kept
at `PEND` (`_activate(sw.nextPlayer, MODE.PEND)`). The constructor and
`destroy()` keep their direct assignments: the constructor runs before the
helper matters, `destroy()` clears the reference on purpose.

`setStreamURL()` while a switch is pending (`_mode === PEND`): the config
and the engine-level change are applied, `_switchMode()` is not called (it
would refuse anyway), and the pending switch completes as it would have.
When it completes into live, that attach already ran with the old URL's
session closed, so it handshakes with the new URL; when it completes into
VOD, the next switch to live does.

In VOD mode, `_switchMode(LIVE)` runs the normal path: the VOD engine
detaches (stays warm), the live engine attaches and, since its session was
closed, starts a new connection to the new URL. One connection, no second
`setStreamURL()` call. A failure restores VOD and emits the mode-switch
error as today; the URL change stays recorded.

`stop()` in live mode with no VOD or a VOD that is not running behaves as
today: the live engine stops. `stop()` in live mode with a warm VOD now
also stops the VOD engine's background loading, which the old code did too
(it called `stop()` on any running VOD engine).

### 2. Live engine (`src/nimio-live.js`)

```js
attach(ui, params, callback) {
  if (this._ui || this._destroyed) return false;
  // ... latency params, _attachUI(ui), the pbError branch as today
  if (params.idle) {
    // take the UI without starting anything: the caller keeps us stopped
    if (callback) callback();
    return true;
  }
  // ... start as today
}

setStreamURL() {
  if (!this._ui) {
    // detached: a kept-alive session belongs to the old URL; the next
    // attach() must handshake. Nothing to close when not connected (the
    // worker's close needs a socket).
    if (this._transport.connected) {
      this._sldpManager.stop({ closeConnection: true });
    }
    return;
  }
  if (this._state.isStopped()) return;
  // ... stop + play as today
}
```

An idle attach leaves the engine stopped with the UI attached: the same
state as after a live `stop()`. The pause timer, the playback generation
and the render loop are untouched; a later `play()` is an initial play.

### 3. SLDP manager (`src/sldp/manager.js`)

```js
stop(opts = {}) {
  const sns = this.resetRequestedStreams();
  const close = !!opts.closeConnection;
  if (close) this._sessionReady = false; // the session ends with the socket
  if (sns.length === 0 && !close) return;
  this._sendRequest("stop", { sns, close });
}
```

A keep-connection stop (`detach()`) leaves the flag, so a VOD detach still
reuses the session; `destroy()` already clears it.

## Error handling

- `stop()` does not depend on the VOD engine's detach callback: the engine
  releases the UI synchronously before `detachMedia()`, so the live idle
  attach always finds the UI free. A late or missing hls.js detach event
  cannot leave the player without an owner.
- `nimio:playback-end` listeners: the VOD stop emits it while the VOD
  engine still holds the UI and is still the active player, so a `play()`
  from that listener reaches the stopping VOD engine and is a no-op, as
  today; the facade activates live only once the UI is free. When the live
  engine was playing (a stop during a pending switch), its own stop emits
  the event with the facade already pointing at live, so a `play()` from
  there starts live, as a live-mode stop would.
- `setStreamURL()` with a failing switch: `_restoreMode()` re-attaches VOD,
  the mode-switch error is emitted, the new URL is kept in the config.
- Both methods return early on a destroyed player, as today.

## Testing (vitest, jsdom)

- `tests/nimio-mode-switch.test.js` (existing fake-engine fixtures, extended
  with `stop`, `setStreamURL`, `isRunning` on the fakes and a config with
  `updateConfigStreamURL` applied): `stop()` in VOD mode stops the VOD
  engine, attaches live idle, activates live, stops live; `play()` afterwards
  reaches the live engine; `stop()` during a pending switch to VOD cancels
  the switch (timer cleared, no error emitted) and ends live and stopped;
  `stop()` in live mode with a warm VOD stops it without re-attaching live;
  `stop()` with no VOD engine stops live only; `setStreamURL()` in VOD mode
  calls the engine's `setStreamURL()` before the switch and attaches live
  once with `{ latency: 0 }`, ending in live mode; a refused attach restores
  VOD and emits the error; during a pending switch only the engine call runs
  and a warning is logged; in live mode only the engine call runs.
- `tests/nimio-live-attach.test.js`: an idle attach takes the UI, calls back,
  returns true, starts no state, no render loop and no connection; a later
  `play()` starts normally.
- `tests/nimio-live.test.js`: a detached `setStreamURL()` closes a connected
  session and does nothing when disconnected; an attached stopped engine
  returns early as before.
- `tests/sldp-manager.test.js`: a closing stop clears `sessionReady`; a
  keep-connection stop keeps it.

Suite-level: `npx vitest run`, `npx prettier --check src tests`,
`npm run test:browser`.

## Delivery

- One code commit on a code-only branch `fix/vod-stop-and-stream-url-pr`
  from `main`; spec and plan stay on the working branch.
- PR title: "Return to live when stopping or changing the stream URL in VOD
  mode".
