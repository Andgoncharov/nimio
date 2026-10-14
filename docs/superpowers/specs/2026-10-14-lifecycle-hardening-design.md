# Facade, UI and VOD lifecycle hardening — Design

**Date:** 2026-10-14
**Branch:** `fix/lifecycle-hardening`, stacked on PR 2b's code branch
`fix/live-after-stop-guards-pr` (`9ae6ca5`) → PR 2a (`2e7a7da`) → PR 1
(`efe8964`) → upstream `main` (`f2d6eea`).
**Status:** Approved design, awaiting implementation plan
**Origin:** PR 3a of the series replacing PR #92. PR 3b (live engine after
destroy) follows.

## Goal

`Nimio.destroy()` always completes: it is idempotent, every step runs even if
an earlier one throws, the instance name is always released, and the first
error is rethrown only after cleanup. A constructor that fails after creating
components rolls them back. Every public method is a safe no-op on a
destroyed player. The UI releases its observer and listeners, tolerates a
container the host already removed, and rolls back a failed construction. The
VOD engine removes a pending or failed hls.js script tag.

## Problems (verified in the code at `9ae6ca5`)

- `Nimio.destroy()` guards on `if (!this._ui) return` and runs its steps in
  sequence. A throwing step (an application listener invoked from the live
  engine's stop, a host that already removed the container, a VOD engine in an
  odd state) skips every later step and `releaseInstances()`: services,
  listeners and the name leak, and a second `destroy()` repeats the failing
  path.
- The constructor has no rollback. A failure after `new UI(...)` (for example
  the live engine's transport worker refusing to start) leaves the container
  in the DOM, the observer attached, services registered under the name.
- Public methods dereference `_actPlayer`, `_livePlayer`, `_eventBus`,
  `_audioVolumeCtrl`, `_playProgressProxy` or `_context` after destroy and
  throw.
- `UI.destroy()` only `unobserve()`s the resize observer, cannot remove the
  anonymous `aux:caption-list-open` handler, and throws on
  `this._parent.removeChild(this._container)` when the host already removed
  the container. A failing constructor leaves DOM, observer, document and bus
  listeners behind.
- `NimioVod` records the hls.js `<script>` only when it has loaded, so a
  pending or failed tag is never removed on destroy.

## Non-goals

- Live engine after-destroy guards: `_destroyed` flag, autoplay and pause
  timers, re-checks after `nimio:play` / `nimio:connection-started` /
  `nimio:playback-start`, unconditional overlay and grabber release,
  reconnector reset on detach, the null-flow guard in
  `_onAudioCodecDataReceived()` (PR 3b). One engine change is made here:
  `NimioLive.destroy()` runs its stages in isolation (see §3), because the
  facade's promise that destruction completes is hollow if a throwing
  `nimio:playback-end` listener can skip the transport worker termination
  (found in review).
- Instance name collision warnings: upstream #95's silent
  `allocateInstanceKey()` stays.
- The native video Picture-in-Picture path (`_toggieVideoPip`) has no
  generation guard; §8 covers Document PiP only. A native PiP grant in the
  frame between a click and destroy leaves a window of the detached video
  open until the user closes it (PR 3b).
- An explicit `removeAllListeners()` step: the event bus's release hook (#95)
  already drops every listener, application ones included, when
  `releaseInstances()` runs.

## Design

### 1. Cleanup helper (`src/shared/helpers.js`)

```js
// Runs each [what, fn] cleanup step in isolation. A failing step is logged
// as "<prefix>: <what> failed" and does not prevent the others; the errors
// are returned so the caller can rethrow the first one after cleanup has
// completed.
export function runCleanupSteps(logger, prefix, steps) {
  const errors = [];
  for (const [what, fn] of steps) {
    try {
      fn();
    } catch (err) {
      logger.error(`${prefix}: ${what} failed`, err);
      errors.push(err);
    }
  }
  return errors;
}
```

### 2. `Nimio` constructor rollback (`src/nimio.js`)

```js
constructor(options) {
  if (options && !options.instanceName) {
    options.instanceName = "nimio_" + (Math.floor(Math.random() * 10000) + 1);
  }
  this._instName = allocateInstanceKey(options.instanceName);
  try {
    this._init(options);
  } catch (err) {
    // a failed construction must leave neither DOM, engines nor the name
    this._rollbackInit();
    throw err;
  }
}

_init(options) { /* today's constructor body after the key allocation */ }

_rollbackInit() {
  runCleanupSteps(this._logger || console, "Nimio init rollback", [
    ["VOD player", () => this._vodPlayer?.destroy()],
    ["live player", () => this._livePlayer?.destroy()],
    ["VU meter", () => this._vuMeterSvc?.clear()],
    ["UI", () => this._ui?.destroy()],
    ["services", () => releaseInstances(this._instName)],
  ]);
  this._vodPlayer = this._livePlayer = this._ui = undefined;
  this._vuMeterSvc = undefined;
  this._destroyed = true;
}
```

### 3. `Nimio.destroy()`

```js
destroy() {
  if (this._destroyed) return;
  this._destroyed = true;
  // a listener invoked during the teardown (nimio:playback-end from the
  // live stop) must not be able to restart or steer the engines
  this._actPlayer = undefined;

  // every component is torn down independently: one failure must not
  // leave the others running, and the name is always released
  const errors = runCleanupSteps(this._logger, "destroy", [
    ["mode switch", () => this._cancelModeSwitch()],
    ["UI", () => this._ui.destroy()],
    ["volume handlers", () => this._removeVolumeEventHandlers()],
    ["VU meter", () => this._vuMeterSvc.clear()],
    ["VOD player", () => this._vodPlayer?.destroy()],
    ["live player", () => this._livePlayer.destroy()],
    [
      "listeners",
      () => {
        this._eventBus.off("nimio:connection-established", this._onLiveConnected);
        this._eventBus.off("aux:playback-error", this._onError);
      },
    ],
    // last, as live and VOD players share services (e.g. AudioContext);
    // the event bus release also drops the application's listeners
    ["services", () => releaseInstances(this._instName)],
  ]);

  this._ui = undefined;
  this._vodPlayer = undefined;
  this._livePlayer = undefined;
  this._actPlayer = undefined;
  this._eventBus = undefined;
  this._context = undefined;
  this._vuMeterSvc = undefined;
  this._playProgressSvc = undefined;
  this._playProgressProxy = undefined;
  this._thumbnailSvc = undefined;
  this._audioVolumeCtrl = undefined;
  this._spsHolder = undefined;

  if (errors.length) throw errors[0];
}
```

Order: UI first (no more user input), VOD before live (shared media element
and services), live last among the engines, then the facade's own
subscriptions, then the service release as its own isolated step so a
throwing service `destroy()` can neither leave the references set nor mask
an earlier error (found in review).

`NimioLive.destroy()` uses the same helper: stop, media resources, UI
handlers, transport handlers, sync-mode handler, reconnector, SLDP manager,
transport, each isolated, first error rethrown afterwards. The media
resources stage (`_releaseMediaResources()`) destroys any remaining decoder
flows, stops audio, the grabber and the metrics overlay, each idempotent:
`_resetPlayback()` destroys the flows last, so a VU meter stop that throws
(the host emptied its container) used to leave the decoder workers alive
with no way to reach them again (found in review). The stage also cancels the
pause timer, stops the playback state (which ends the render loop) and
hard-stops ABR, for a stop that threw before reaching them. Without the
isolated stages a `nimio:playback-end` listener that throws (the emit is the last statement of the closing stop)
aborted the engine before the transport worker was terminated, and the
facade, having caught the error and cleared its reference, could never
finish that cleanup (found in review). `_switchMode()` and the facade's
`aux:playback-error` handler return early on a destroyed facade for the same
reason.

### 4. Public methods after destroy

`src/nimio.js`: `setParameters` → `this._livePlayer?.setParameters(params)`;
`play` / `pause` → `this._actPlayer?.play()` / `?.pause()`; `stop()` and
`setStreamURL()` return at once when `_destroyed`; `seekVod()` returns
`false` when `_destroyed`; `seekLive()` returns `false` when
`!this._playProgressProxy`; `getVodPlayerHandler()` already returns `null`
via `?.`; the `_runVodFromStart()` promise continuation returns when
`_destroyed`.

`src/nimio-ext-api.js`: every `this._actPlayer.x()` becomes
`this._actPlayer ? this._actPlayer.x() : <neutral>` with `false` for
`isAbr`, `setCaptionTrack`; `[]` for `getRenditions`; `null` for
`getCurrentRendition`; `{}` for `getCaptionTracks`, `getCurrentCaptionTrack`;
`0` for `getCurrentStreamBandwidth`, `getCurrentTimestamp`; `?.` for
`startAbr` / `stopAbr`; `setCurrentRendition` also requires `_actPlayer`.

`src/nimio-events.js`: every method returns when `!this._eventBus`
(`listeners` → `[]`, `listenerCount` → `0`).

`src/nimio-volume.js`: every public method returns at once when `_destroyed`.
The volume is persisted per storage key, so a listener invoked during the
teardown must not be able to change it for later players (found in review).

### 5. UI (`src/ui/ui.js`)

```js
constructor(instName, parent, opts, eventBus) {
  // ... field setup and the "container element is not valid" throw as today
  try {
    this._construct(opts);
  } catch (err) {
    // never leave DOM, observers or document listeners behind
    this._rollbackConstruction();
    throw err;
  }
}

_construct(opts) { /* today's body from `this._container = ...` on */ }

_rollbackConstruction() {
  runCleanupSteps(this._logger, "UI construction rollback", [
    ["offscreen renderer", () => this._offscreenRenderer?.terminate()],
    ["captions", () => this._removeCaptions()],
    ["observer", () => this._resizeObserver?.disconnect()],
    ["display handlers", () => this._onViewportUpd && this._removeDisplayEventHandlers()],
    ["playback handlers", () => Object.hasOwn(this, "_onPlaybackEnded") && this._removePlaybackEventHandlers()],
    ["caption list handler", () => this._onCaptionListOpen && this._eventBus.off("aux:caption-list-open", this._onCaptionListOpen)],
    ["container", () => this._container?.parentNode?.removeChild(this._container)],
  ]);
  this._offscreenRenderer = undefined;
}
```

- The caption-list handler is stored: `this._onCaptionListOpen = () =>
this._closeAbrMenu(); this._eventBus.on("aux:caption-list-open",
this._onCaptionListOpen);` and `destroy()` removes it.
- `destroy()`: `this._resizeObserver.disconnect()` instead of `unobserve`;
  the container is removed via `this._container.parentNode?.removeChild(...)`.
- The rollback also releases the seek bar (`_removeSeekBar()`), so the
  playback progress service does not keep a UI from a failed construction
  (found in review).
- `_onPlaybackPositionChange` returns `false` on a destroyed facade (found
  in review).

### 6. VOD script tag (`src/nimio-vod.js`)

`_addScriptTag()` assigns `this._playerScript = script` before appending it;
the load continuation no longer assigns it. `destroy()` calls
`_removePlayerScript()` first: null `onload`/`onerror`, remove the element
from its parent if any, forget it. The former removal at the end of
`destroy()` (which only ran for a loaded script) is dropped.

### 7. Service release finishes the loop (`src/shared/service.js`)

`releaseInstances()` released services in registration order and stopped at
the first `destroy()` that threw (a VU meter whose external container the
host had emptied), leaving every later service registered under the key
although the facade had already cleared its references. It now isolates each
service's release, finishes the loop and rethrows the first error, which the
facade's "services" step logs and rethrows after cleanup (found in review).

### 8. Pending Document Picture-in-Picture request (`src/ui/ui-pip.js`)

`_toggleDocumentPip()` awaits `requestWindow()`. If `_cleanupPip()` ran
meanwhile (the UI was destroyed), the continuation used to move the player
into the new window, install another observer and listener, then throw on the
cleared message element, leaving the window open. `_cleanupPip()` bumps a
request generation; a completion whose generation is stale closes the window
and installs nothing (found in review; pre-existing gap).

### 9. VU meter UI stops animating before it touches the DOM (`src/vumeter/ui.js`)

`VUMeterUI.destroy()` removed its generated elements first and cleared the
`_fullValue` flag afterwards. When the host had already emptied the meter's
inner DOM, the first `removeChild()` threw, the flag stayed set, and
`_drawMeter()` kept scheduling animation frames after the player was gone.
The flag and the element lists are now cleared first; elements are removed
only if they are still children of the meter, and the meter is removed from
whatever parent it has (found in review; pre-existing gap).

## Error handling

- `destroy()` rethrows the first step error after every step ran and the name
  was released; callers that ignore it still get a fully released player.
- Rollback never throws: each step is isolated and logged.
- Public methods never throw on a destroyed player.

## Testing (vitest, jsdom)

- `tests/helpers.test.js` (new): runs every step, logs failures and returns
  the errors in order; empty list when nothing fails.
- `tests/nimio.test.js` (new; `UI`, `NimioLive`, `NimioVod` replaced by
  module mocks that record construction and destroy order and can throw; real
  `EventBus`, services and `allocateInstanceKey`): destroy releases every
  service registered under the name; drops application listeners; is
  idempotent; destroys the VOD engine before the live engine, after the UI;
  a player recreated with the same name gets a fresh bus; destroy clears the
  facade's references; a VOD initialisation settling after destroy touches no
  released service; a constructor failure leaves no services registered; a
  constructor failure after the UI was created destroys that UI and clears
  the VU meter; destroy releases the name and still tears down the engines
  when the UI cleanup throws, and rethrows that error; event, volume and
  every other public method are safe no-ops with neutral values after
  destroy.
- `tests/nimio-vod-lifecycle.test.js` (new): a pending remote script tag is
  removed with its handlers detached on destroy; a failed one is removed too;
  a local source creates nothing after destroy.
- `tests/browser/ui-integration.test.js`: destroy tolerates a container the
  host removed; a constructor failure leaves no DOM; a constructor failure
  after captions were set up deinitialises them.

Review follow-ups (plan Tasks 6–10):

- `tests/nimio-live.test.js`: `NimioLive.destroy()` with a throwing `stop()`
  still releases everything and rethrows, with only the stop stage logged; the
  media stage destroys the flows, stops audio, cancels the pause timer, stops
  the state and hard-stops ABR when `stop()` failed before reaching them.
- `tests/nimio.test.js`: a teardown listener calling `play()`,
  `setParameters()`, `setVolume()`, `mute()` touches no engine or controller;
  a throwing service release still clears the references and is rethrown; a
  playback position change after destroy is ignored.
- `tests/service.test.js`: a throwing `destroy()` does not stop the other
  releases and is rethrown.
- `tests/ui-pip-lifecycle.test.js` (new): a Document PiP window granted after
  `_cleanupPip()` is closed and nothing is installed; a grant while alive is
  used as before.
- `tests/vumeter-ui.test.js` (new): `destroy()` stops the animation loop and
  does not throw when the host removed the meter's children or the meter.
- `tests/browser/ui-integration.test.js`: a destroyed UI tolerates the live
  engine's late `clear()` and `hideControls()`.

Suite-level: `npx vitest run`, `npm run prettier:check`; `npm run
test:browser` for the UI cases.

## Delivery

- One code commit on a code-only branch `fix/lifecycle-hardening-pr` stacked
  on `fix/live-after-stop-guards-pr`; spec and plan local.
- PR title: "Make player destruction idempotent and failure-safe".
