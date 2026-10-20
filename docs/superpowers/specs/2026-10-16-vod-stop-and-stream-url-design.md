# Stop and stream URL change in VOD mode — Design

**Date:** 2026-10-16, revised 2026-10-19 after the review of PR #104
**Branch:** `fix/vod-stop-and-stream-url`, from upstream `main` (`0fcce53`).
PR branch `fix/vod-stop-and-stream-url-pr` (PR #104, `9e20450`).
**Status:** Approved and implemented (PR #104, second commit)
**Origin:** design review H2, the part left after #98 added
`NimioLive.setStreamURL()`; the maintainer's findings on PR #104; the
design review of the scenario matrix (2026-10-19).

## Goal

A stopped player is one state, whatever was playing before: live mode, the
live engine stopped with the UI, the VOD engine stopped, the server session
closed, the playback context reset, no timer left that could start playback
again. `play()` starts live, `seekVod()` or a drag into the DVR opens the
VOD paused at that position, and `play()` from there plays it.

`setStreamURL()` reaches the new URL from every state with one connection
and never shows the old stream's archive again: the VOD engine is stopped
whenever its URL changed and re-initialises with the new one; in VOD mode
or during a pending switch the player stops and starts live with the new
URL, with no path back to the old archive.

The facade's active player and mode are written in one place.

## Problems

Verified in the code at `0fcce53` (the original design):

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
  plays.
- A kept-alive live session belongs to the URL it was started with. After a
  URL change, `attach()`'s reuse path (`transport.connected &&
sessionReady`) would request the old URL's streams. `SLDPManager.stop({
closeConnection: true })` does not clear `_sessionReady`.
- The mode-switch routine writes `_actPlayer`/`_mode` in `_finishModeSwitch()`
  and `_restoreMode()`; the constructor and `destroy()` write them too. The
  two broken methods wrote neither.

Found by the maintainer in PR #104 (`9e20450`):

- `setStreamURL()` no longer stops a running VOD engine, so a warm engine
  keeps the old `_url` and `isRunning()`; a drag into the DVR before the new
  connection is established plays the old archive, and if the new URL never
  connects the engine stays on the old stream.
- A URL change during a pending switch to VOD completes into the old
  archive with a warning.
- A URL change in VOD mode whose live attach fails restores the old
  stream's VOD through `_restoreMode()`.
- After a stop from VOD, `PlaybackContext.state` stays PLAYING (written by
  the VOD detach), so a later `seekVod()` autoplays.
- A stop from VOD emits the VOD `nimio:playback-end` only; `main` emitted
  the LIVE one too. Intentional, undocumented.
- The idle attach creates a native-PiP capture stream that `showStopped()`
  destroys right away.

Found by the design review of the scenario matrix (2026-10-19, code at
`c356f61`):

- A drag on the seek bar reaches the VOD engine through
  `_onPlaybackPositionChange()` → `_switchToVod()` → `NimioVod.attach()`,
  whose only guard (`_state < SYNC`) lets a stopped engine (`STOP = 4`)
  through with its stale `_url`. Only the public `seekVod()` goes through
  `_runVodFromStart()`, which re-initialises. Stopping the engine does not
  fix the maintainer's scenario on the UI path.
- `NimioVod.attach()` pauses hls.js buffering; the only `resumeBuffering()`
  is in the autoplay branch of `_onLevelLoaded`. A VOD attached without
  autoplay cannot be started by `play()` (pre-existing for a never-played
  player with `autoplay: false`).
- `_runVodFromStart()` forces `context.state.initial = true`, so the
  autoplay setting decides every VOD start from a non-running engine, and
  nothing distinguishes a stopped player from a playing one.
- `NimioLive.pause()` on a stopped engine sets PAUSED and arms the pause
  timeout; the next `play()` within that window skips the connection start
  and runs a render loop with no stream.
- `_runVodFromStart()`'s `.then` checks only `_destroyed`: a `stop()` or
  URL change while hls.js is still loading is overridden by the switch to
  VOD when the promise resolves.
- Re-entrant calls from the VOD `nimio:playback-end` listener during the
  new stop-then-play path: a `destroy()` leaves `_livePlayer` undefined for
  the following `play()`; a nested `setStreamURL()` opens a second
  connection.
- `NimioVod.initialize()` from STOP reloads the source but keeps `STOP`, so
  `isRunning()` is false while playlists load and a later `stop()` ignores
  the engine.
- `NimioLive.stop()` returns early on a stopped engine before cancelling the
  autoplay timers of a just-constructed player and a pending reconnect; a
  `stop()` right after construction or during a reconnect wait is followed
  by a `play()` the user did not ask for.
- A socket that never opens reports `NO_SRC` with `stop: true` after the
  reconnect attempts, which disables the startup VOD failover; only a
  server rejection (invalid status) runs it. The original matrix cell
  promised a failover for both.

Found by the review of the fix commit (2026-10-19, `c41a2e4`):

- A queued `NimioVod.initialize()` survives the facade's cancellation: a
  `seekVod()` followed at once by `stop()` voids the facade's `.then`, but
  the engine's own `.then` still reloads the new URL in the background.
- An engine re-initialised into SYNC counted as running before its new
  playlist arrived, so a `seekVod(600)` went through the progress proxy and
  was clamped to the old archive's duration.
- A live socket still connecting when the player entered VOD survived a
  `stop()`: the engine was already stopped and the transport not yet
  connected, so no closing command was sent and the socket opened later.
- A failed or timed-out switch to VOD restored the live engine with a full
  attach, which starts playback even when live was stopped or paused
  before the seek (inherited from #91).

Found by the review of the second round (2026-10-19, `8cebc00`):

- The rollback read the context after detaching the replacement engine,
  whose detach had overwritten it with its own (never started) state, so
  a timed-out seek into VOD restored a playing live engine idle.
- After the first seek attached the reloading engine, a second seek before
  the new playlist arrived went through the progress proxy and was clamped
  to the old archive's duration.
- With the levels of a previously played archive still in the context, the
  new source's master manifest took the "level update" branch of
  `_onManifestParsed()` and republished the old variant's cached duration
  right after the reset.
- With a higher rendition selected on the old archive, a URL change in
  live mode and a seek into the DVR before the new connection completed, a
  new archive with fewer renditions kept the old selection index: the live
  metadata of the previous stream suppressed the VOD-only fallback, and
  reading the missing level's session threw inside `_onManifestParsed()`.

Found by the final review with two lenses (contract/regression and
adversarial scenarios, 2026-10-20, `39b1220`):

- A `play()` from the listener of the VOD `nimio:playback-end` emitted by
  `stop()` was dropped by the re-entrancy guard, while the same restart
  pattern from the live end event worked; no later event told the
  application that nothing had happened.
- A `stop()` during a reconnect wait found a stopped engine and emitted
  nothing: the drop had emitted nothing either, so the application and the
  UI kept a playing player that a second click had to stop.
- `NimioVod.destroy()` keyed its teardown on `_url`, which the interrupted
  reload's `stop()` now clears, so a destroy after such a stop skipped the
  hls.js listeners and the UI handlers; the same stop kept `_sessionParam`.
- `pause()` on a never-played `autoplay` player emitted the pause and let
  the automatic start play over it.
- An idle restore of a paused live engine after a failed switch closed its
  session with no event: the application kept a paused player that could
  not be resumed.
- Found by the final inspection of the branch: a `pause()` during a
  reconnect wait cancelled the retry, so a later `stop()` found no retry
  pending and emitted nothing, while a `stop()` without the pause emitted
  the live end event; a failed or timed-out seek into VOD from a
  reconnecting live player restored silently (the drop had left the engine
  stopped), so the application kept a playing player under the splash;
  the first fix snapshotted the pending retry only, so a `pause()` that
  had cancelled it before the seek lost the notification again; the flag
  survived a new `play()`, so a later exhausted reconnect and a `stop()`
  emitted a spurious end; a seek into the DVR during a reconnect wait
  opened the archive paused with no event (the detach recorded the engine's
  own stopped state, not the playing player the application saw), and a
  rollback left live stopped where the base restarted it; that fix read
  the pending retry alone, so a player paused before the drop had its
  archive start on a seek with `autoplay: false` (the base kept it paused).
- Pre-existing, postponed to the to-do list: `getMinimumLevelIdx()`
  returns the first level with a height, not the smallest (its caller in
  the initial rendition selection predates this change);
  `updateConfigStreamURL()` never clears `vod.isDefault` on an explicit
  `vod`, so a later string URL overwrites it (the matrix's "explicit `vod`
  field" rule describes what the code does today).

## Non-goals

- Changing how `_switchMode()` detaches and attaches, its timeout, or its
  error reporting.
- The VOD URL update inside `updateConfigStreamURL()`.
- Skipping the live restart when a URL change touches only the VOD URL
  (to-do list).
- Exiting native or document PiP during a stop (to-do list).
- The engine's coupled attach for the normal switch; only an `idle` option
  is added.

## Design

### 1. Facade (`src/nimio.js`)

```js
stop() {
  if (this._destroyed || this._stopping) return;
  this._stopping = true;
  try {
    // a switch in flight cannot complete into a stopped player; settle it
    // silently (no error: the stop is what the application asked for)
    this._cancelModeSwitch();
    // a VOD start still waiting for hls.js must not switch to VOD later
    this._vodStartGen++;
    // unconditional: the attached engine (VOD mode), the warm detached one
    // (live mode), a stopped one reloading a new URL and a queued
    // initialize() a seek left behind are all ended by it
    this._vodPlayer?.stop();
    // a nimio:playback-end listener may have destroyed the player
    if (this._destroyed) return;
    // the VOD stop released the UI synchronously (before detaching media):
    // give it back to the live engine without starting it. A no-op when
    // the live engine already holds it.
    this._livePlayer.attach(this._ui, { latency: 0, idle: true });
    this._activate(this._livePlayer, MODE.LIVE);
    // the live stop emits its playback-end last: an application that
    // restarts from that event gets a clean initial play, as in the base
    this._stopping = false;
    this._livePlayer.stop(); // also closes a kept-alive session
    // the live playback-end listener may have destroyed the player too
    if (this._destroyed) return;
    // a stopped player presents a stopped context: the next VOD start
    // (seek) opens paused, whatever the VOD detach recorded
    this._context.resetState();
    // a URL change, or a play() from the VOD end-event listener: an
    // initial live play from the stopped player
    if (this._playAfterStop) {
      this._playAfterStop = false;
      this._livePlayer.play();
    }
  } finally {
    this._stopping = false;
  }
}

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
      this._vodPlayer?.stop(); // also cancels a queued reload
    }
    this._livePlayer.setStreamURL(); // playing: stop + play; paused: stop; stopped: nothing
    return;
  }
  // VOD mode or a pending switch: stop (VOD stopped, live idle with the UI,
  // kept-alive session closed, context reset), then an initial live play
  // with the new URL, performed by the stop as its last step. One
  // connection; no path back to the old archive.
  this._playAfterStop = true;
  this.stop();
}

play() {
  if (this._destroyed) return;
  if (this._stopping) {
    // from a listener of the VOD end event of a stop in progress: the VOD
    // engine still holds the UI, so the play runs as the stop's last step
    this._playAfterStop = true;
    return;
  }
  this._actPlayer?.play();
}
// pause(), seekVod(), seekLive(), _onPlaybackPositionChange(): the same
// `_stopping` guard; a call from inside a stop's listener is a no-op.

// The only writer of the active player and the mode.
_activate(player, mode) {
  this._actPlayer = player;
  this._mode = mode;
}

// Start VOD from a non-running engine (stopped, or loaded but never
// attached). The engine re-initialises when its URL is stale. `initial`
// marks the startup VOD failover: there the autoplay setting decides;
// everywhere else the VOD plays when the live engine was playing and
// opens paused otherwise (the live detach records the engine's state in
// the context, and _onLevelLoaded reads it).
_runVodFromStart(pos, { initial = false } = {}) {
  if (!this._vodPlayer?.isLoaded() || this._vodPlayer.isRunning()) return false;
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

_onPlaybackPositionChange = (mode, val) => {
  if (this._destroyed || this._stopping || this._mode === MODE.PEND) return false;
  if (mode === this._mode) return this._actPlayer.goto(val);
  if (mode === MODE.VOD && !this._vodPlayer?.isRunning()) {
    // the seek bar and seekVod() share one path into a non-running engine
    return this._runVodFromStart(val);
  }
  return mode === MODE.VOD ? this._switchToVod(val) : this._switchToLive(val);
};
```

`_onLivePlaybackError()` calls `_runVodFromStart(undefined, { initial:
true })` for the startup VOD failover. `seekVod()` is unchanged: a running
engine goes through the progress proxy, a non-running one through
`_runVodFromStart(position)` (the proxy would clamp the position to a
duration it does not know yet).

`_runVodFromStart()` no longer restores the context value captured before
the switch: the value the live detach writes is the live engine's state at
the time of the seek, which is the right autoplay input. Behaviour change
against the base: a drag into the DVR during live playback with a cold VOD
engine now continues playing regardless of the `autoplay` setting (the
base paused unless `autoplay` was on).

`_switchMode()` snapshots the previous engine's playback state right after
its detach recorded it in the context (`sw.prevState`). `_restoreMode()`
puts that snapshot back into the context after detaching the replacement
engine (whose detach overwrote it) and re-attaches a live engine
accordingly: playing → the normal attach (restart); stopped or paused → the
idle attach, followed by the engine's `stop()`, which closes the session a
paused engine's detach kept alive, and, for a paused engine, or one whose
retry a `pause()` cancelled during a reconnect wait, or one that dropped
while paused and waits for its retry (`_switchMode()` snapshots
`hasUnreportedEnd()` before the detach, which consumes that state; a
retry pending for a drop during playback makes the detach record
`PLAYING`, so that case takes the restart branch and never reaches here),
by `nimio:playback-end LIVE`: its detach stopped it without an event, the
engine's stop finds it stopped, and the application still holds a paused
player (a stopped engine never played: nothing to end). So a failed or
timed-out seek into VOD on a stopped or paused player neither starts live
playback nor keeps a server session for a player showing the splash, and
the application hears that a paused player ended. `_finishModeSwitch()`
re-checks `_destroyed` after the restore before it emits the `MODE_SWITCH`
error. A restored VOD engine reads the context itself.

`_finishModeSwitch()`, `_restoreMode()` and the switch's detach callback set
the active player through `_activate()`, as in #104. The constructor and
`destroy()` keep their direct assignments.

`setStreamURL()` in live mode is the engine's own restart (#98); the
`_switchMode(LIVE)` path and the engine's detached `setStreamURL()` branch of
#104 are removed: the facade calls the engine's `setStreamURL()` only when
the engine holds the UI.

### 2. Live engine (`src/nimio-live.js`)

```js
attach(ui, params, callback) {
  if (this._ui || this._destroyed) return false;
  // ... latency params as today
  // idle and error attaches show the stopped look: no capture stream
  this._attachUI(ui, { idle: !!(params.idle || params.pbError) });
  // ... the pbError branch: showStopped(), then the error event as today
  if (params.idle) {
    // take the UI without starting anything: the caller keeps us stopped;
    // no live playback-end follows, so give the UI the stopped look here
    this._ui.showStopped();
    if (callback) callback();
    return true;
  }
  // ... start as today
}

_attachUI(ui, { idle = false } = {}) {
  this._ui = ui;
  // an idle attach shows the stopped look; no capture stream for it
  this._ui.toggleMode(MODE.LIVE, { capture: !idle });
}

pause() {
  if (this._destroyed || this._state.isPaused()) return;
  if (this._state.isStopped()) {
    // a stopped engine has nothing to pause; marking it paused would make
    // the next play() skip the connection start. During a reconnect wait
    // the user asked for playback to stop: cancel the retry. The event is
    // emitted either way: after an engine-internal stop the UI still shows
    // the pause glyph and this click must flip it; the next play() is an
    // initial play. The autoplay of a just-constructed player must not play
    // over the pause either. A cancelled retry ends the playback the
    // application still sees: the next closing stop() reports it.
    this._cancelAutoplay();
    if (this._reconnect.pending) this._retryCancelled = true;
    this._reconnect.stop();
    this._eventBus.emit("nimio:pause", { mode: MODE.LIVE });
    return;
  }
  // ... as today
}

stop(opts = {}) {
  // timers that would start playback after the stop: the autoplay of a
  // just-constructed player and a reconnect attempt. Cancelled before the
  // early return, since both run while the engine is already stopped. The
  // autoplay start's one-second controls fade is a separate timer that
  // only destroy() cancels; when it fires on a stopped player (an early
  // stop, an immediate rejection) it leaves the controls visible.
  const retryPending = this._reconnect.pending || this._retryCancelled;
  this._retryCancelled = false;
  this._cancelAutoplay();
  this._reconnect.stop();
  const isStopped = this._state.isStopped();
  // a socket still connecting may open after the stop: close it as well
  const hasSocket = this._transport.connected || this._transport.connecting;
  if (!isStopped || (closeConnection && hasSocket)) this._sldpManager.stop(...);
  if (isStopped) {
    // the drop stopped the engine silently because a retry was coming;
    // cancelling the retry (here, or by an earlier pause) ends the
    // playback the application still sees (a detach, keepConnection,
    // keeps it for a restart)
    if (retryPending && closeConnection) {
      this._eventBus.emit("nimio:playback-end", { mode: MODE.LIVE });
    }
    return;
  }
  // ... as today
}

// true while the application still sees a player whose live playback
// ended silently: a retry pending (a playing player, or a paused one that
// dropped), or a pause() cancelled it
// (paused); the next closing stop() reports the end, a detach() consumes
// the state, so the facade snapshots it before a switch
hasUnreportedEnd() {
  return !!(this._reconnect.pending || this._retryCancelled);
}
// _beginPlayback() (play() and attach()) clears _retryCancelled: the new
// playback is what the application sees; an end the pause left unreported
// belongs to the previous one

detach(callback) {
  // the state the application sees: a connection that dropped during
  // playback and waits for its retry is still a playing player (the engine
  // is stopped), so a seek into VOD plays the archive and a rollback
  // restarts live; one that dropped while paused keeps the pause
  // (_onDisconnect() records _playingBeforeDrop before it stops the engine;
  // _beginPlayback() clears it)
  this._context.setState(
    this._reconnect.pending && this._playingBeforeDrop
      ? STATE.PLAYING
      : this._state.value,
    false,
  );
  // ... as today; the "nothing to reuse" branch closes a connected OR a
  // connecting socket (one that opens while detached would hold an idle
  // server session until the next start)
}

// play() and attach() share _beginPlayback(): state start, the
// _retryCancelled clear, latency controller and ABR start

setStreamURL() {
  // as #98: stopped → nothing; paused → stop; playing → stop + play
}
```

An idle attach leaves the engine stopped with the UI attached: the same
state as after a live `stop()`. A later `play()` is an initial play and
`_onPlaybackStarted(LIVE)` creates the capture stream then, as for any
live start.

### 2b. VOD engine (`src/nimio-vod.js`)

- `stop()` emits `nimio:playback-end` while it still holds the UI and the
  hls.js handler, and returns right after the emit when a listener
  destroyed the engine (#104).
- `play()` calls `this._pHandler.resumeBuffering()` before
  `handlePlay()`: `attach()` pauses buffering and only the autoplay branch
  of `_onLevelLoaded` resumed it, so a VOD attached paused (every seek on a
  stopped or paused player) could not be started. hls.js ignores a resume
  while buffering is already enabled. The UI's play button goes through
  `_onPlayPause` → `play()`, so one place covers both paths.
- `initialize()` is cancellable: it captures `_initGen` and its `.then`
  returns when `stop()` bumped it meanwhile, so a `seekVod()` followed by a
  `stop()` reloads nothing in the background. A reload from `STOP` keeps
  the engine in `STOP` (not running): a seek on it goes through the
  facade's `_runVodFromStart()` and attaches at the requested position
  instead of through the progress proxy, whose duration still belongs to
  the old archive; the facade's `stop()` calls the engine's `stop()`
  unconditionally, which stops the loading (`stopLoad()`) and voids a
  queued reload. A reload that changes the source also calls
  `PlaybackProgressService.resetVodDuration()`, so a seek after the first
  one attached the engine, and before the new playlist arrived, is not
  clamped to the old archive's duration either. The engine tracks whether
  the current source's metadata is usable (`_metadataReady`: cleared by
  every load `initialize()` starts, set when the variant playlist loads);
  a `stop()` before that forgets `_url`, so the next `initialize()` (the
  next `nimio:connection-established`) loads the archive again, however
  many times the load was interrupted. The duration reset notifies the
  application synchronously; `initialize()` re-checks its generation and
  the destroyed flag after it, so a `stop()` or `destroy()` from that
  listener ends the reload before it loads. `stop()` bumps the initialize generation only from
  SYNC upwards: the warm-up `initialize()` of an engine still setting up
  hls.js is not voided by a stop in the same tick. `_onManifestParsed()`
  treats a manifest whose source differs from the context's
  `levelsSourceUrl` like a first manifest: the levels are replaced, the
  session parameter and the UI layout come from the new current level, the
  configured `initialRendition` is applied as for a first manifest when
  the live configuration is empty (the previous stream's metadata with the
  configuration reset by the URL change) while fresh live metadata keeps
  the level that maps to the playing stream, and the new
  variant is loaded; the old variant's cached details are never
  republished. A master manifest of the current source whose variant never
  loaded (`_metadataReady` false: a stop interrupted the load and the next
  connection requested the master again) is treated as a first manifest
  as well, so the session parameter is re-read and the variant requested;
  a level update of a loaded source republishes the cached details as
  before. A reload of a new source drops the old archive's session
  parameter before the request, and `detach()` reloads the current variant
  in the background only when the context's levels belong to the engine's
  current URL: during the reload window of a URL change the previous
  archive's variant must not be fetched and recorded under the new URL.
  A `stop()` that forgets `_url` drops `_sessionParam` with it. `destroy()`
  gates its teardown (hls.js listeners, UI handlers, media detach) on the
  state (`>= SYNC`), not on `_url`, which such a stop clears. The `INIT`
  block is unchanged.

### 3. UI stopped look (`src/ui/ui.js`, `src/ui/ui-pip.js`)

`UI.showStopped()` (splash background, captions hidden, capture stream
released, controls paused on the play button) is run by the live
playback-end handler and by the engine's idle attach, as in #104.
`toggleMode(mode, { capture = true } = {})` skips `_createCaptureStream()`
when `capture` is false; the idle attach passes `false`, so the stopped
look has nothing to release. The VOD branch and every other caller are
unchanged.

### 4. SLDP manager (`src/sldp/manager.js`)

A closing stop clears `_sessionReady` (#104, unchanged).

### 4b. Transport adapter (`src/transport/adapter.js`)

`connecting` is true from a `start` command until the worker's first
`connected: true/false` for it (and false after `destroy()`). A closing
`stop` command clears both `connected` and `connecting` as it is sent, so
a second stop in the same task (a seek, a nested stop) sends no second
close. The live engine's `stop()` and `detach()` treat a connecting socket
like a connected one when deciding to send the closing command; the worker
already closes a socket in the CONNECTING state without sending to it, and
a `WebSocket` constructor failure (a malformed URL) posts the disconnect
and the closed notice like a dropped connection, so the engine's reconnect
path and error reporting run instead of a playing state with no data.

### 4d. Playback context (`src/playback/context.js`)

`setLevels(levels, parentUrl)` records `parentUrl` as `levelsSourceUrl`, the
master playlist the VOD levels belong to; `hasCurrentStream` says whether a
live stream is selected. `setLevels()` always ends with a valid
current level: when neither the stream mapping nor the caller selects one
(the current configuration was reset by a URL change while the previous
stream's live metadata is still present), or the kept index exceeds the
new list, the minimum level is selected.

### 4c. Progress service (`src/playback/progress-service.js`)

`resetVodDuration()` zeroes the VOD durations and position and tells the
UI's duration, the time indicator and the external progress listener
(`nimio:vod-progress` with 0/0); `updateVodPosition()` clamps a seek only to
a known (non zero) duration, so between a source change and the new playlist's
`updateVodPlaylistDuration()` seeks pass through and the seek bar shows no
DVR extent; a seek-bar interaction while the total duration is zero is
ignored (it would map to position 0 and to the live branch).

### 5. README

- `stop()`: "Stops playback and resets the player. Emits
  `nimio:playback-end` with the mode that was playing (nothing when the
  player was already stopped). Afterwards the
  player is in live mode, stopped: `play()` starts the live stream,
  `seekVod()` opens the VOD at the position, paused."
- `setStreamURL(url)`: "A playing player reconnects to the new stream
  right away; a player in VOD mode, playing or paused, switches to live and
  plays the new stream. A paused or stopped live player uses the new URL on
  the next `play()`. Switching emits `nimio:playback-end` (with the mode
  that was playing) followed by `nimio:play`." The parameter text is kept.
- `seekVod(position)`: add "On a stopped or paused player the VOD opens
  paused at the position; during live playback it continues playing."
- `pause()`: add "On a stopped player it only emits `nimio:pause` (so the
  controls show the play button after a connection failure); during a
  reconnect wait it also cancels the retry. The next `play()` starts
  anew."
- `nimio:playback-end`: "Playback ended: the media reached its end, or
  `stop()` / `setStreamURL()` ended it. `mode` is the mode that was
  playing." (today: "Playback reached the end of the media").

## Scenario matrix

The matrix states the outcome a user gets for every public entry point this
change touches, from every state the player can be in, together with the
next action a user is likely to take. Each cell is a test target; the
reviewers grade the code against the cells, not only against the design
sections. Decisions taken on 2026-10-19: a URL change in VOD mode or during
a pending switch is a stop followed by a live play; a paused VOD player
also starts live playback on a URL change; a seek on a stopped player opens
the VOD paused whatever the `autoplay` setting; a stop from VOD emits the
VOD end event only; the pre-existing holes on the stopped state (listed
under Problems) are fixed in this PR.

### Legend

- **Player state**: `LIVE playing`, `LIVE paused`, `LIVE stopped` (never
  played, after `stop()`, or after an engine-internal stop: pause timeout,
  invalid status, reconnect exhaustion), `LIVE reconnecting` (dropped, a
  retry pending), `VOD playing`, `VOD paused`, `PEND →VOD` (live detached,
  VOD attaching, waiting for `MEDIA_ATTACHED`), `PEND →LIVE` (VOD detached
  and warm, live attaching; it exists only inside the synchronous switch
  call, so it is a start state only for a listener of an event the live
  attach emits, `nimio:play` or `nimio:connection-started`), `destroyed`.
- **VOD engine**: `cold` (hls.js not initialised), `warm` (levels loaded,
  detached, `isRunning()`), `reloading` (re-initialised after a URL change,
  loading the new playlist, detached, still `STOP` so `isRunning()` is
  false; the facade's `stop()` stops it, a seek attaches it at the requested
  position through `_runVodFromStart()`), `attached` (holds the UI),
  `stopped` (`VOD_STATE.STOP`, keeps its last `_url`, when its variant
  had loaded, until the next
  `initialize()`; attachable without `initialize()`, which is why every
  start from it goes through `_runVodFromStart()`).
- **Context**: `PlaybackContext.state` as `value/initial`.
- **Session**: the SLDP server session: `open`, `kept alive` (live engine
  detached, statistics session preserved), `closed`.
- **Capture**: the native-PiP canvas capture stream (only when native PiP is
  in use).
- **VOD URL changed**: `config.vod.url` differs after `updateConfigStreamURL`
  (an explicit `vod` field, or a default VOD URL that follows the live one).

Rules that hold in every row:

- The facade's `stop()` resets the context (`STOPPED/false`), voids any
  pending VOD start and calls the VOD engine's `stop()` unconditionally
  (which cancels a queued `initialize()` and stops a background reload), in
  every start state. A live socket still connecting is closed like a
  connected one. Engine-internal stops do neither
  (documented gap; the next facade `stop()` or `setStreamURL()` cleans up).
- `setStreamURL()` stops a running VOD engine (warm or reloading) and voids
  any pending VOD start whenever the VOD URL changed, in every start state.
  An engine with an unchanged VOD URL is untouched (in VOD mode and during
  a pending switch the stop itself stops it and voids the pending start).
- Calls from inside a listener of the VOD `nimio:playback-end` emitted by a
  stop in progress (the VOD engine still holds the UI): `stop()`,
  `pause()`, `seekVod()`, `seekLive()` and seek-bar drags are ignored; a
  `play()` is remembered and performed as the stop's last step (an initial
  live play, the path a URL change takes); `setStreamURL()` records the URL
  only and the outer call continues with the newest config; `destroy()`
  works and the outer call returns silently.
  The live `nimio:playback-end` is emitted by the last step with the guard
  released: a `play()` from its listener restarts live with an initial
  play, as in the base; a nested `stop()` is a harmless no-op.

### A. `stop()`

| Start             | Result                                                                                               | Context         | UI / capture                                                          | Session                   | VOD engine                                                                  | Events                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| LIVE playing      | LIVE stopped, live engine active                                                                     | `STOPPED/false` | stopped look (splash, play button, captions hidden); capture released | closed                    | warm or reloading → stopped silently; cold untouched                        | `playback-end LIVE`                                                                          |
| LIVE paused       | same as LIVE playing; the pause timeout is cancelled                                                 | `STOPPED/false` | same                                                                  | closed                    | same                                                                        | `playback-end LIVE`                                                                          |
| LIVE stopped      | no live action; the autoplay timer of a just-constructed player is cancelled                         | `STOPPED/false` | unchanged; no capture created                                         | no socket action          | a VOD engine still running after an engine-internal stop → stopped silently | none                                                                                         |
| LIVE reconnecting | the pending retry is cancelled; LIVE stopped (the stop ends the playback the application still sees) | `STOPPED/false` | stopped look, applied by the end event                                | none (already dropped)    | running → stopped silently                                                  | `playback-end LIVE` (the drop emitted none)                                                  |
| VOD playing       | LIVE stopped, live engine active                                                                     | `STOPPED/false` | stopped look; no capture stream is created by the idle attach         | kept-alive session closed | stopped; `_url` kept (its variant had loaded) until the next `initialize()` | `playback-end VOD` only; no LIVE end event, the live engine never ran (README)               |
| VOD paused        | same as VOD playing                                                                                  | `STOPPED/false` | same                                                                  | closed                    | stopped                                                                     | `playback-end VOD` only                                                                      |
| PEND →VOD         | switch settled silently (no `MODE_SWITCH` error), LIVE stopped                                       | `STOPPED/false` | stopped look                                                          | kept-alive session closed | attaching → stopped; the late `MEDIA_ATTACHED` finds no callback            | `playback-end VOD` (the VOD never showed a frame; accepted: it was the engine being entered) |
| PEND →LIVE        | switch settled silently, LIVE stopped                                                                | `STOPPED/false` | stopped look                                                          | closed                    | warm → stopped silently                                                     | `playback-end LIVE`                                                                          |
| destroyed         | no-op                                                                                                | –               | –                                                                     | –                         | –                                                                           | none                                                                                         |

Follow-ups after any `stop()` that ended in `LIVE stopped`:

| Next action                                                              | Expected                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play()`                                                                 | an initial live play with the current live URL: one `nimio:connection-started`, one `nimio:play LIVE`; the capture stream is created by the playback start                                                                                                                       |
| `pause()`                                                                | emits `nimio:pause` (the UI shows the play button), changes no state; a later `play()` is still an initial play. In `LIVE reconnecting` it also cancels the retry, and the next `stop()` emits `playback-end LIVE`; on a just-constructed `autoplay` player, the automatic start |
| `seekVod(pos)`, or a drag into the DVR                                   | VOD of the current VOD URL at `pos`, **paused** whatever the `autoplay` setting; the engine re-initialises first when its `_url` is stale. `play()` then resumes buffering and plays                                                                                             |
| `seekLive()`                                                             | no switch, no error; latency updated only                                                                                                                                                                                                                                        |
| a VOD start that was pending (hls.js still loading) when the stop ran    | dropped: the player stays LIVE stopped                                                                                                                                                                                                                                           |
| a second `stop()`                                                        | nothing thrown or emitted (the VOD engine's stop runs again, idempotent)                                                                                                                                                                                                         |
| `stop()` / `play()` / `seekVod()` from the `nimio:playback-end` listener | VOD end (VOD-mode stop): `stop()` and `seekVod()` ignored; a `play()` restarts live with an initial play once the stop completed. LIVE end (live-mode stop): a `play()` restarts live with an initial play, as in the base                                                       |
| `setStreamURL(url)`                                                      | row "LIVE stopped" of table B                                                                                                                                                                                                                                                    |
| `destroy()` inside the `nimio:playback-end` listener                     | `stop()` returns silently after the emit; nothing is attached, started or emitted afterwards                                                                                                                                                                                     |

### B. `setStreamURL(url)` — string form or `{ live, vod }`

| Start             | Live engine                                                                                                                                                                                           | VOD engine                                                                                                                                     | Result                                           | Session                               | Events                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | -------------------------------- |
| LIVE playing      | stop, then play with the new URL                                                                                                                                                                      | VOD URL changed: warm or reloading → stopped, re-initialised with the new URL on the next `nimio:connection-established`; unchanged: untouched | LIVE playing the new URL                         | old closed, new opened                | `playback-end LIVE`, `play LIVE` |
| LIVE paused       | stop; the new URL is used by the next `play()`                                                                                                                                                        | same rule                                                                                                                                      | LIVE stopped                                     | closed                                | `playback-end LIVE`              |
| LIVE stopped      | URL recorded only                                                                                                                                                                                     | same rule (an engine left running by an engine-internal stop is stopped when its URL changed)                                                  | LIVE stopped                                     | none                                  | none                             |
| LIVE reconnecting | URL recorded; the pending retry plays the new URL                                                                                                                                                     | same rule                                                                                                                                      | LIVE reconnecting, then playing the new URL      | new on the retry                      | `play LIVE` on the retry         |
| VOD playing       | facade `stop()` (VOD stopped, UI to live idle, kept-alive session closed, context reset), then live `play()` = an initial play with the new URL. No switch machinery, no path back to the old archive | stopped; new URL on `connection-established`                                                                                                   | LIVE playing the new URL                         | kept-alive closed, one new connection | `playback-end VOD`, `play LIVE`  |
| VOD paused        | same as VOD playing: live playback starts (as the base did; README updated)                                                                                                                           | stopped                                                                                                                                        | LIVE playing the new URL                         | kept-alive closed, one new connection | `playback-end VOD`, `play LIVE`  |
| PEND →VOD         | `stop()` settles the switch silently, then live `play()` with the new URL                                                                                                                             | attaching → stopped                                                                                                                            | LIVE playing the new URL; no `MODE_SWITCH` error | kept-alive closed, one new connection | `playback-end VOD`, `play LIVE`  |
| PEND →LIVE        | same; the half-started live attach is stopped and restarted with the new URL                                                                                                                          | warm → stopped silently                                                                                                                        | LIVE playing the new URL                         | old closed, one new connection        | `playback-end LIVE`, `play LIVE` |
| destroyed         | no-op                                                                                                                                                                                                 | –                                                                                                                                              | –                                                | –                                     | none                             |

Follow-ups after a `setStreamURL()` that changed the live URL:

| Next action                                                                                | Expected                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seekVod(pos)` or a drag into the DVR before `nimio:connection-established` of the new URL | VOD of the **new** VOD URL at `pos` (the stopped engine re-initialises); playing, since the live engine is playing; the old archive is never shown                                                          |
| `seekVod(pos)` or a drag after `connection-established`                                    | `seekVod(pos)`: same, from the reloading engine, not clamped to the old archive's duration; a drag while no duration is known yet (before the new playlist) is ignored, the bar cannot map it to a position |
| the server rejects the new stream (invalid status)                                         | `startupVodFailover`: VOD of the new VOD URL from the start, autoplay setting decides; otherwise `nimio:playback-error NO_SRC`, LIVE stopped                                                                |
| the socket never opens or drops                                                            | reconnect attempts, then `nimio:playback-error NO_SRC`, LIVE stopped; no failover, no `playback-end`, no stopped look (pre-existing, unchanged)                                                             |
| `play()` after a row that ended in LIVE stopped                                            | an initial play with the new URL                                                                                                                                                                            |
| a VOD start pending from before the change                                                 | dropped when the VOD URL changed; kept otherwise (the archive URL did not change)                                                                                                                           |
| `setStreamURL()` again from the VOD `nimio:playback-end` listener                          | the newest URL is recorded; the outer call plays it; one connection                                                                                                                                         |
| `destroy()` inside a listener fired during the change                                      | returns silently; no further attach, play or emit                                                                                                                                                           |
| only the VOD URL changed (`{ vod }`) while LIVE playing                                    | the live engine restarts anyway today; pre-existing, out of scope (to-do list)                                                                                                                              |

### C. Seeks from `LIVE reconnecting`

The matrix legend defines the state; these are its seek cells (the live
detach records the state the application sees: `PLAYING` while a retry is
pending for a connection that dropped during playback, the engine's own
state otherwise; the disconnect handler records what the player was doing
before it stops the engine). A player paused _before_ the drop also gets
a retry (the base resumes a paused player on the retry; deciding that is
on the to-do list), but a seek during that wait follows the pause.

| Start                                               | `seekVod(pos)` or a drag into the DVR                                                                    | the switch fails or times out                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| LIVE reconnecting                                   | the retry is dropped; VOD at `pos`, **playing** (the player was playing a moment ago); no live end event | live restarted with a normal attach (an immediate retry); `MODE_SWITCH` error, no end event                    |
| LIVE reconnecting after a `pause()` during the wait | VOD at `pos`, paused (the user paused); no further event                                                 | LIVE stopped, idle; `playback-end LIVE` (the pause left it unreported), then `MODE_SWITCH`                     |
| LIVE reconnecting after a drop while paused         | VOD at `pos`, paused (the last user action was pause; the base kept it paused too); no further event     | LIVE stopped, idle; `playback-end LIVE` (the retry the seek cancelled was the pending end), then `MODE_SWITCH` |

## Error handling

- `stop()` does not depend on the VOD engine's detach callback: the engine
  releases the UI synchronously before `detachMedia()`, so the live idle
  attach always finds the UI free. A late or missing hls.js detach event
  cannot leave the player without an owner.
- `nimio:playback-end` listeners during `stop()`: while the VOD engine is
  being stopped the facade is `_stopping`, so `stop()`, `pause()` and
  seeks from the listener are no-ops, a `play()` is performed once the
  stop completed and a `setStreamURL()` only records the URL; the outer
  call ends the player LIVE stopped (or playing, after that `play()`). The live
  engine's own stop (live mode, or a stop during a pending switch to live)
  runs with the guard released and emits the event last: a `play()` from
  that listener is an initial play, a nested `stop()` finds a stopped
  engine and does nothing.
- `setStreamURL()` in VOD mode or during a pending switch has no failure
  mode of its own: the stop cannot fail, and the live `play()` reports its
  problems through the live error path (reconnect attempts, then
  `nimio:playback-error`, or the startup VOD failover for a server
  rejection). The old stream's VOD is never restored, since the engine was
  stopped and its next start re-initialises with the new URL.
- A `destroy()` from a listener during `setStreamURL()` makes `stop()`
  return silently; `setStreamURL()` re-checks `_destroyed` before the
  `play()`.
- A VOD start whose `initialize()` promise resolves after a `stop()`,
  `setStreamURL()` or a newer start is dropped by the facade's generation
  check, and the engine's own generation (bumped by its `stop()`) keeps the
  queued reload from running in the background.
- A failed or timed-out switch to VOD restores a live engine that was
  stopped or paused with the idle attach: the player ends live, stopped,
  with the stopped look; a paused one (including one paused during a
  reconnect wait) emits `nimio:playback-end LIVE`, and
  `nimio:playback-error MODE_SWITCH` follows as before (unless that end
  event's listener destroyed the player); a playing one is restarted.
- Both methods return early on a destroyed player, as today.

## Testing (vitest, jsdom; browser suite for the UI)

- `tests/nimio-mode-switch.test.js` (fake-engine fixtures): every row of
  table A and B that the fakes can express, named after the row: `stop()`
  from VOD / VOD paused / pending switches / live with a warm VOD / live
  stopped with a VOD left running; `stop()` resets the context and bumps
  the VOD start generation; a second `stop()` is a no-op; `play()`,
  `seekVod()` and `stop()` from the VOD playback-end listener are ignored;
  `setStreamURL()` in live mode stops a running VOD engine only when the
  VOD URL changed and calls the engine's `setStreamURL()`; in VOD mode and
  during a pending switch it stops and then calls the live `play()` with
  no switch started; a `destroy()` from the listener leaves it silent; a
  nested `setStreamURL()` from the listener is recorded and the outer call
  plays once; a position change into a non-running VOD engine goes through
  `_runVodFromStart()`; `_runVodFromStart()` keeps the context value the
  detach wrote, sets `initial` only for the failover, and drops a start
  whose generation is stale.
- `tests/nimio-vod-lifecycle.test.js` (real VOD engine): `stop()` with a
  destroying listener ends quietly; `play()` after an attach resumes
  buffering before playing; `initialize()` from STOP with a new URL enters
  SYNC and `isRunning()`.
- `tests/nimio-live-attach.test.js`: an idle attach takes the UI with
  `toggleMode(LIVE, { capture: false })`, calls `showStopped()`, starts
  nothing; `pause()` on a stopped engine emits `nimio:pause` and changes no
  state, and during a reconnect wait also cancels the retry; `stop()` on a
  stopped
  engine cancels the autoplay timers and a pending reconnect.
  `tests/nimio-live-after-destroy.test.js`: an idle attach followed by
  `play()` is an initial play.
- `tests/nimio-live.test.js`: `setStreamURL()` on an attached stopped
  engine returns early; the detached branch is gone.
- `tests/browser/ui-integration.test.js`: `toggleMode(LIVE, { capture:
false })` creates no capture stream; `showStopped()` after a VOD
  playback-end shows the splash and releases an existing capture stream.
- `tests/sldp-manager.test.js`: a closing stop clears `sessionReady`.
- `tests/transport-adapter.test.js`: `connecting` from a start until the
  worker reports the socket open or closed, and false after `destroy()`.
- Second review round: `stop()` on a stopped live engine and `detach()`
  close a connecting socket; a VOD reload from `STOP` stays stopped, a
  `stop()` before the queued reload cancels it and after it stops the
  loading; the facade's `stop()` calls the engine stop unconditionally; a
  failed or timed-out switch restores a stopped or paused live engine idle
  and a playing one with the normal attach, from a snapshot taken when the
  previous engine let go of the UI; the idle restore is followed by the
  engine's `stop()`; a `play()` from the live `nimio:playback-end` listener
  of a live-mode `stop()` restarts live; a paused VOD is restored paused
  when a switch to live never completes.
- Minors of the behaviour-diff review: a `stop()` during an unfinished
  reload forgets the URL and the next initialize reloads, a second
  interruption too; the variant playlist completes the reload, the master
  alone does not; a `stop()` or `destroy()` from the duration-reset
  listener ends the reload before it loads; fresh live metadata keeps the
  live selection on a source change; a reload of a new source drops the
  old session parameter; a detach during a URL change does not reload the
  previous archive's variant; a stop in INIT keeps the initialize generation; a
  live `stop()` cancels the autoplay play timer and keeps the controls
  fade, `destroy()` cancels both; a new source selects the configured
  initial rendition with stale live metadata; the duration reset notifies
  the external progress listener and the time indicator.
- Minors of the shared-state trace: a closing stop clears the adapter's
  connection state as it is sent; a seek-bar interaction with no known
  duration is ignored; a `WebSocket` constructor failure posts the
  disconnect and closed notices; the error attach takes the UI idle and
  shows the stopped look; the controls fade leaves a stopped player's
  controls visible and hides a playing player's.
- `tests/progress-service.test.js`: a seek is clamped to a known VOD
  duration, passes through after `resetVodDuration()`, and is clamped
  again once the new playlist duration arrives;
  `tests/nimio-vod-lifecycle.test.js`: a reload that changes the source
  resets the progress service's duration, a same-URL initialize does not;
  `tests/nimio-vod.test.js`: with a previously played archive's levels in a
  real context, a manifest from a new source replaces them and publishes
  no duration, a manifest from the same source republishes it;
  `tests/playback-context.test.js`: `levelsSourceUrl`; a replacement with
  fewer levels than the selected index falls back to a valid level, a
  still-valid selection is kept; `tests/nimio-vod.test.js`: a new source
  with fewer renditions before the live connection completes selects a
  valid level and initialises session, layout and the variant load.

- Final review (two lenses): a `play()` from the VOD end-event listener is
  performed after the stop, once, also when the stop came from
  `setStreamURL()`, and not when the listener destroyed the player; an
  idle restore of a paused live engine emits the live end event before the
  switch error, of a stopped one no end event, and survives a destroy from
  that listener; a live `stop()` during a reconnect wait emits the live
  end event, a detach (`keepConnection`) and a stop with no retry pending
  do not; `pause()` on a never-played autoplay player cancels the autoplay;
  a VOD stop that forgets the URL drops the session parameter, and a
  `destroy()` after it still releases the handlers.
  `tests/nimio-stop-events.test.js` (real event bus, real context, the
  real VOD stop and the real live attach/stop/play): the event sequence of
  a VOD-mode `stop()` (VOD end only, idle live attach with the stopped
  look, kept-alive session closed, context reset), of a VOD-mode
  `setStreamURL()` (VOD end, then one `play LIVE` with the new URL after
  the close), of a `stop()` with a `play()` from the listener, and of a
  second `stop()` (nothing); with the real SLDP manager over a stubbed
  transport, a VOD-mode `stop()` sends the closing stop, clears the
  session-ready flag, and the next `play()` sends a new start (no play
  request on the old session); a live-mode URL change followed by a seek
  into the new archive before the connection is established, as one flow:
  the reload requests the new master playlist without the old session
  parameter, the duration is reset, the attach requests the new URL at the
  position, the new manifest replaces the levels (no old duration
  republished, the new session parameter) and the new variant playlist
  brings the duration and starts playback.
- Final inspection: a `pause()` during a reconnect wait followed by a
  `stop()` emits the live end event once; `hasUnreportedEnd()` (a retry
  pending, or cancelled by a pause); an idle restore of a live engine
  paused during a reconnect wait emits the live end event before the
  switch error;
  `tests/nimio-stop-events.test.js`: a `pause()` during a reconnect wait
  (real `Reconnector`) followed by a timed-out seek into VOD reports the
  end exactly once, and a later `stop()` adds nothing; a drop, a `pause()`,
  a `play()` and an exhausted reconnect: `stop()` emits nothing, like the
  control without the pause; `attach()` clears the flag like `play()`; a
  seek during a reconnect wait opens the VOD playing and a timed-out switch
  restarts live with the switch error only (real `Reconnector` and the real
  disconnect handler); a player paused before the drop opens the VOD
  paused, and its timed-out switch ends stopped with the end event then
  the switch error; `tests/nimio-vod-lifecycle.test.js`: the reload after
  an interrupted load completes (the second master of the same source
  requests the variant and re-reads the session parameter).

Suite-level: `npx vitest run`, `npx prettier --check src tests`,
`npm run test:browser` (exit code and no "Unhandled").

## Delivery

- A second commit on `fix/vod-stop-and-stream-url-pr` on top of `9e20450`,
  so the maintainer reviews the delta; the working branch gets its own code
  commit plus the spec and plan commits.
- PR #104 description: a "Changes after review" section mapping the six
  findings and the design-review additions to the commit, and the
  documentation note on `nimio:playback-end`.
