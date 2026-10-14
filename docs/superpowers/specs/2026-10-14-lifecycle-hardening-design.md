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
  `_onAudioCodecDataReceived()` (PR 3b).
- Instance name collision warnings: upstream #95's silent
  `allocateInstanceKey()` stays.
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
  ]);
  this._vodPlayer = this._livePlayer = this._ui = undefined;
  this._vuMeterSvc = undefined;
  this._destroyed = true;
  releaseInstances(this._instName);
}
```

### 3. `Nimio.destroy()`

```js
destroy() {
  if (this._destroyed) return;
  this._destroyed = true;

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
  ]);
  // last, as live and VOD players share services (e.g. AudioContext); the
  // event bus release also drops the application's listeners
  releaseInstances(this._instName);

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
subscriptions.

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

`src/nimio-volume.js`: `this._audioVolumeCtrl?.x()`.

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

### 6. VOD script tag (`src/nimio-vod.js`)

`_addScriptTag()` assigns `this._playerScript = script` before appending it;
the load continuation no longer assigns it. `destroy()` calls
`_removePlayerScript()` first: null `onload`/`onerror`, remove the element
from its parent if any, forget it. The existing removal in `_clear()` is
replaced by the same call.

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

Suite-level: `npx vitest run`, `npm run prettier:check`; `npm run
test:browser` for the UI cases.

## Delivery

- One code commit on a code-only branch `fix/lifecycle-hardening-pr` stacked
  on `fix/live-after-stop-guards-pr`; spec and plan local.
- PR title: "Make player destruction idempotent and failure-safe".
