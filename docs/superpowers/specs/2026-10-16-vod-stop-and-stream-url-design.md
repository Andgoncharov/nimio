# Stop and stream URL change in VOD mode — Design

**Date:** 2026-10-16, revised 2026-10-19 after the review of PR #104
**Branch:** `fix/vod-stop-and-stream-url`, from upstream `main` (`0fcce53`).
PR branch `fix/vod-stop-and-stream-url-pr` (PR #104, `9e20450`).
**Status:** Revised design, awaiting approval
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

## Non-goals

- Changing how `_switchMode()` detaches and attaches, its timeout, or its
  error reporting.
- The VOD URL update inside `updateConfigStreamURL()`, and resetting the
  VOD engine's `_sessionParam` and the context's level map on a VOD URL
  change (to-do list).
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
    // running covers the attached VOD engine (VOD mode), the warm detached
    // one (live mode) and one re-initialising after a URL change
    if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
    // a nimio:playback-end listener may have destroyed the player
    if (this._destroyed) return;
    // the VOD stop released the UI synchronously (before detaching media):
    // give it back to the live engine without starting it. A no-op when
    // the live engine already holds it.
    this._livePlayer.attach(this._ui, { latency: 0, idle: true });
    this._activate(this._livePlayer, MODE.LIVE);
    this._livePlayer.stop(); // also closes a kept-alive session
    // a stopped player presents a stopped context: the next VOD start
    // (seek) opens paused, whatever the VOD detach recorded
    this._context.resetState();
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
      if (this._vodPlayer?.isRunning()) this._vodPlayer.stop();
    }
    this._livePlayer.setStreamURL(); // playing: stop + play; paused: stop; stopped: nothing
    return;
  }
  // VOD mode or a pending switch: stop (VOD stopped, live idle with the UI,
  // kept-alive session closed, context reset), then an initial live play
  // with the new URL. One connection; no path back to the old archive.
  this.stop();
  if (this._destroyed) return;
  this._livePlayer.play();
}

play() {
  if (this._destroyed || this._stopping) return;
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
  this._attachUI(ui, { idle: !!params.idle });
  // ... the pbError branch as today
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
  // a stopped engine has nothing to pause; marking it paused would make
  // the next play() skip the connection start
  if (this._destroyed || this._state.isPaused() || this._state.isStopped()) return;
  // ... as today
}

stop(opts = {}) {
  // timers that would start playback after the stop: the autoplay of a
  // just-constructed player and a reconnect attempt. Cancelled before the
  // early return, since both run while the engine is already stopped.
  this._cancelAutoplay();
  this._reconnect.stop();
  const isStopped = this._state.isStopped();
  // ... as today
}

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
- `initialize()` sets `_state = VOD_STATE.SYNC` when it reloads the source
  from `STOP` (a URL change): the engine is loading again, detached, which
  is what SYNC means, and `isRunning()` is true, so a later `stop()` stops
  the background loading. The `INIT` block is unchanged.

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

### 5. README

- `stop()`: "Stops playback and resets the player. Emits
  `nimio:playback-end` with the mode that was playing. Afterwards the
  player is in live mode, stopped: `play()` starts the live stream,
  `seekVod()` opens the VOD at the position, paused."
- `setStreamURL(url)`: "A playing player reconnects to the new stream
  right away; a player in VOD mode, playing or paused, switches to live and
  plays the new stream. A paused or stopped live player uses the new URL on
  the next `play()`. Switching emits `nimio:playback-end` (with the mode
  that was playing) followed by `nimio:play`." The parameter text is kept.
- `seekVod(position)`: add "On a stopped or paused player the VOD opens
  paused at the position; during live playback it continues playing."
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
  and warm, live attaching), `destroyed`.
- **VOD engine**: `cold` (hls.js not initialised), `warm` (levels loaded,
  detached, `isRunning()`), `reloading` (re-initialised after a URL change,
  loading the new playlist, detached, `isRunning()`), `attached` (holds the
  UI), `stopped` (`VOD_STATE.STOP`, keeps its last `_url` until the next
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

- The facade's `stop()` resets the context (`STOPPED/false`) and voids any
  pending VOD start, in every start state. Engine-internal stops do neither
  (documented gap; the next facade `stop()` or `setStreamURL()` cleans up).
- `setStreamURL()` stops a running VOD engine (warm or reloading) and voids
  any pending VOD start whenever the VOD URL changed, in every start state.
  An engine with an unchanged VOD URL is untouched (in VOD mode and during
  a pending switch the stop itself stops it and voids the pending start).
- Calls from inside a listener of an event emitted by a stop in progress:
  `stop()`, `play()`, `pause()`, `seekVod()`, `seekLive()` and seek-bar
  drags are ignored; `setStreamURL()` records the URL only and the outer
  call continues with the newest config; `destroy()` works and the outer
  call returns silently.

### A. `stop()`

| Start             | Result                                                                       | Context         | UI / capture                                                          | Session                   | VOD engine                                                                  | Events                                                                                       |
| ----------------- | ---------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| LIVE playing      | LIVE stopped, live engine active                                             | `STOPPED/false` | stopped look (splash, play button, captions hidden); capture released | closed                    | warm or reloading → stopped silently; cold untouched                        | `playback-end LIVE`                                                                          |
| LIVE paused       | same as LIVE playing; the pause timeout is cancelled                         | `STOPPED/false` | same                                                                  | closed                    | same                                                                        | `playback-end LIVE`                                                                          |
| LIVE stopped      | no live action; the autoplay timer of a just-constructed player is cancelled | `STOPPED/false` | unchanged; no capture created                                         | no socket action          | a VOD engine still running after an engine-internal stop → stopped silently | none                                                                                         |
| LIVE reconnecting | the pending retry is cancelled; LIVE stopped                                 | `STOPPED/false` | unchanged (the drop applied no stopped look; pre-existing)            | none (already dropped)    | running → stopped silently                                                  | none (the drop emitted none; pre-existing)                                                   |
| VOD playing       | LIVE stopped, live engine active                                             | `STOPPED/false` | stopped look; no capture stream is created by the idle attach         | kept-alive session closed | stopped; `_url` kept until the next `initialize()`                          | `playback-end VOD` only; no LIVE end event, the live engine never ran (README)               |
| VOD paused        | same as VOD playing                                                          | `STOPPED/false` | same                                                                  | closed                    | stopped                                                                     | `playback-end VOD` only                                                                      |
| PEND →VOD         | switch settled silently (no `MODE_SWITCH` error), LIVE stopped               | `STOPPED/false` | stopped look                                                          | kept-alive session closed | attaching → stopped; the late `MEDIA_ATTACHED` finds no callback            | `playback-end VOD` (the VOD never showed a frame; accepted: it was the engine being entered) |
| PEND →LIVE        | switch settled silently, LIVE stopped                                        | `STOPPED/false` | stopped look                                                          | closed                    | warm → stopped silently                                                     | `playback-end LIVE`                                                                          |
| destroyed         | no-op                                                                        | –               | –                                                                     | –                         | –                                                                           | none                                                                                         |

Follow-ups after any `stop()` that ended in `LIVE stopped`:

| Next action                                                              | Expected                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `play()`                                                                 | an initial live play with the current live URL: one `nimio:connection-started`, one `nimio:play LIVE`; the capture stream is created by the playback start                           |
| `pause()`                                                                | no-op, no event; a later `play()` is still an initial play                                                                                                                           |
| `seekVod(pos)`, or a drag into the DVR                                   | VOD of the current VOD URL at `pos`, **paused** whatever the `autoplay` setting; the engine re-initialises first when its `_url` is stale. `play()` then resumes buffering and plays |
| `seekLive()`                                                             | no switch, no error; latency updated only                                                                                                                                            |
| a VOD start that was pending (hls.js still loading) when the stop ran    | dropped: the player stays LIVE stopped                                                                                                                                               |
| a second `stop()`                                                        | no-op: nothing thrown or emitted                                                                                                                                                     |
| `stop()` / `play()` / `seekVod()` from the `nimio:playback-end` listener | ignored; the player ends LIVE stopped                                                                                                                                                |
| `setStreamURL(url)`                                                      | row "LIVE stopped" of table B                                                                                                                                                        |
| `destroy()` inside the `nimio:playback-end` listener                     | `stop()` returns silently after the emit; nothing is attached, started or emitted afterwards                                                                                         |

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

| Next action                                                                                | Expected                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seekVod(pos)` or a drag into the DVR before `nimio:connection-established` of the new URL | VOD of the **new** VOD URL at `pos` (the stopped engine re-initialises); playing, since the live engine is playing; the old archive is never shown |
| `seekVod(pos)` or a drag after `connection-established`                                    | same, from the reloading engine                                                                                                                    |
| the server rejects the new stream (invalid status)                                         | `startupVodFailover`: VOD of the new VOD URL from the start, autoplay setting decides; otherwise `nimio:playback-error NO_SRC`, LIVE stopped       |
| the socket never opens or drops                                                            | reconnect attempts, then `nimio:playback-error NO_SRC`, LIVE stopped; no failover, no `playback-end`, no stopped look (pre-existing, unchanged)    |
| `play()` after a row that ended in LIVE stopped                                            | an initial play with the new URL                                                                                                                   |
| a VOD start pending from before the change                                                 | dropped                                                                                                                                            |
| `setStreamURL()` again from the VOD `nimio:playback-end` listener                          | the newest URL is recorded; the outer call plays it; one connection                                                                                |
| `destroy()` inside a listener fired during the change                                      | returns silently; no further attach, play or emit                                                                                                  |
| only the VOD URL changed (`{ vod }`) while LIVE playing                                    | the live engine restarts anyway today; pre-existing, out of scope (to-do list)                                                                     |

## Error handling

- `stop()` does not depend on the VOD engine's detach callback: the engine
  releases the UI synchronously before `detachMedia()`, so the live idle
  attach always finds the UI free. A late or missing hls.js detach event
  cannot leave the player without an owner.
- `nimio:playback-end` listeners during `stop()`: the facade is `_stopping`,
  so `play()`, `stop()`, `pause()` and seeks from the listener are no-ops
  and a `setStreamURL()` only records the URL; the outer call ends the
  player LIVE stopped. When the live engine was playing (a stop during a
  pending switch to live), its own stop emits the event with the facade
  already pointing at live and still `_stopping`: the same no-ops apply.
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
  `setStreamURL()` or a newer start is dropped by the generation check.
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
  nothing; `pause()` on a stopped engine is a no-op; `stop()` on a stopped
  engine cancels the autoplay timers and a pending reconnect.
  `tests/nimio-live-after-destroy.test.js`: an idle attach followed by
  `play()` is an initial play.
- `tests/nimio-live.test.js`: `setStreamURL()` on an attached stopped
  engine returns early; the detached branch is gone.
- `tests/browser/ui-integration.test.js`: `toggleMode(LIVE, { capture:
false })` creates no capture stream; `showStopped()` after a VOD
  playback-end shows the splash and releases an existing capture stream.
- `tests/sldp-manager.test.js`: a closing stop clears `sessionReady`.

Suite-level: `npx vitest run`, `npx prettier --check src tests`,
`npm run test:browser` (exit code and no "Unhandled").

## Delivery

- A second commit on `fix/vod-stop-and-stream-url-pr` on top of `9e20450`,
  so the maintainer reviews the delta; the working branch gets its own code
  commit plus the spec and plan commits.
- PR #104 description: a "Changes after review" section mapping the six
  findings and the design-review additions to the commit, and the
  documentation note on `nimio:playback-end`.
