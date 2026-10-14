# Live engine after-stop guards and service release — Design

**Date:** 2026-10-14
**Branch:** `fix/live-after-stop-guards`, stacked on PR 2a's code branch
`fix/media-after-stop-guards-pr` (`2e7a7da`), which sits on PR 1's
`fix/worker-termination-pr` (`efe8964`) and upstream `main` (`f2d6eea`).
**Status:** Approved design, awaiting implementation plan
**Origin:** PR 2b of the series replacing PR #92. PR 1 terminates workers;
PR 2a guards the media path after stop; PR 3 hardens the facade and UI.

## Goal

Asynchronous work of the live engine that was started before a stop must not
act afterwards, the engine must unsubscribe everything it subscribed, and the
per-instance services that hold timers, graph connections or pending loads
must release them when the player is destroyed. Two leftovers from PR 2a are
closed as well: a kept-alive session that never committed, and a next
rendition left pending when the main audio flow is torn down mid-switch.

## Problems (verified in the code at `2e7a7da`)

- `NimioLive._initAudioProcessor()` awaits the worklet module and, in sync
  mode, the clock handshake, with no check that playback was stopped meanwhile.
  `_stopAudio()` nulls the context and node, so a completion after it creates
  an `AudioWorkletNode` on a stopped engine, attaches ports and connects the
  graph. `_onAudioStartTsNotSet()` awaits that initialisation and then records
  `_firstAudioFrameTsUs` and the playback start for a run that is gone.
- `_startNoAudioMode()` (after an audio decoder error, or a stream without
  audio) calls `_initAudioProcessor(48000, 1, true)` even when a node already
  drives playback; `initContext()` then closes the running context on the
  sample-rate change and video freezes. `_setNoAudio()` had already silenced
  the existing node, which is all no-audio mode needs.
- `_sendPendingAdvertizerActions()` registers a port handler that reads
  `this._audioNode` when the reply arrives; after a stop the field is `null`
  and the handler throws.
- `_onVideoSetupReceived()` / `_onAudioSetupReceived()` create decoder flows
  while the engine is stopped (a setup timer or a late worker message); the
  codec-data handlers already guard this.
- `_createSyncModeParams()` subscribes an anonymous `nimio:sync-mode-params`
  handler that `destroy()` cannot remove.
- `releaseInstances()` (#95) calls `destroy()` on services that define it.
  `MetricsManager` does not (a store's 500 ms interval survives if its flow was
  never removed), `AudioGraphController` does not (connections survive), and
  `VUMeterService.clear()` only stops the meter: a worklet module still loading
  creates a meter afterwards and calls back into the cleared service, or logs a
  fatal error and re-initialises it.
- `detach()` arms keep-alive even when the session never committed its status
  (PR 2a's `sessionReady` is false). The kept socket is useless: `attach()`
  handshakes again anyway. An idle session is kept alive for the VOD stay.
- `_onAudioCodecDataReceived()`, main-track incompatible update: destroys the
  main audio flow. If a rendition switch is pending, the next flow is unpaired
  by that destroy but never destroyed or reported, so `_nextRenditionData`
  stays set and ABR is stuck "in progress".

## Non-goals

- `Nimio.destroy()` idempotence and failure isolation, constructor rollback,
  public methods after destroy, autoplay timers, the reconnector surviving a
  `detach()`, `play()`/`attach()` re-checking after their emits (PR 3).
- UI: observer disconnect, caption-list handler, removed container, rollback
  (PR 3).
- Any change to the SLDP manager, the transport session or the decoder flow
  beyond what PR 2a shipped.

## Design

### 1. Audio initialisation generation (`src/nimio-live.js`)

- Constructor: `this._audioInitGen = 0; // bumped by _stopAudio() to cancel a pending init`
- `_stopAudio()`: `this._audioInitGen++;` first.
- `_initAudioProcessor(sampleRate, channels, idle)`:

```js
// No-audio mode on top of an existing node: that node already drives the
// playback clock and _setNoAudio() silenced it. Re-initialising would close
// its context and freeze video.
if (idle && this._audioNode) return;
const gen = this._audioInitGen;
// ... unchanged context init; the module load:
this._audioWorkletReady = this._audioContext.audioWorklet
  .addModule(audioProcUrl)
  .catch((err) => {
    if (gen === this._audioInitGen)
      this._logger.error("Audio worklet error", err);
  });
// ...
await this._audioWorkletReady;
if (gen !== this._audioInitGen) {
  // audio was stopped (or the engine destroyed) while the module loaded
  this._logger.debug("Audio processor initialization cancelled");
  return;
}
if (this._audioNode) return;
// ... node creation unchanged ...
if (this._config.syncBuffer > 0) {
  let smc = new SyncModeClock(this._audioNode.port);
  await smc.sync();
  if (gen !== this._audioInitGen) return; // stopped during the handshake
  this._applySyncModeParams();
}
```

- `_onAudioStartTsNotSet(frame)`:

```js
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

- `_sendPendingAdvertizerActions()` (`src/nimio-transport.js`): capture
  `const node = this._audioNode; if (!node) return;` and use `node.port` in
  the handler and its removal.

### 2. Setups while stopped (`src/nimio-transport.js`)

`_onVideoSetupReceived(data)` and `_onAudioSetupReceived(data)` start with
`if (this._state.isStopped()) return; // late setup after stop()`, before the
no-config branches.

### 3. Sync-mode listener (`src/nimio-sync-mode.js`, `src/nimio-live.js`)

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

`NimioLive.destroy()` after `_deinitTransport()`:

```js
if (this._onSyncModeParams) {
  this._eventBus.off("nimio:sync-mode-params", this._onSyncModeParams);
}
```

### 4. Service release hooks

- `MetricsManager.destroy()` (`src/metrics/manager.js`): destroy every store
  (clears its interval), clear the map. Idempotent.
- `AudioGraphController.destroy()` (`src/audio/graph-controller.js`):
  `this.dismantle();`.
- `BaseMeter.dispose()` (`src/vumeter/base.js`): `this._disposed = true;
this.stop(true);` and clear `_readyCallback`, `_updateCallback`,
  `_errorCallback`. `AudioWorkletMeter` (`src/vumeter/audio-worklet.js`):
  `_onWorkletModuleAdded`, `_onWorkletModuleNotFound` and
  `_onWorkletModuleError` return at once when `_disposed`.
- `VUMeterService` (`src/vumeter/service.js`):

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

`Nimio.destroy()` keeps calling `clear()` explicitly; `destroy()` makes
`releaseInstances()` self-sufficient.

### 5. Detach of an uncommitted session (`src/nimio-live.js`)

```js
detach(callback) {
  // ...
  this._context.setState(this._state.value, false);
  this.stop({ keepConnection: true });
  if (this._sldpManager.sessionReady) {
    // the session has stream metadata: keep it for a later attach()
    this._sldpManager.keepAliveConnection();
  } else {
    // nothing to reuse (attach() would handshake anyway): close it now
    this._sldpManager.stop({ closeConnection: true });
  }
  // ...
}
```

The engine stop stays non-closing so `nimio:playback-end` is not emitted on a
mode switch. Closing through the manager sends `stop/close` with no streams;
the worker closes the socket and reports disconnected. The statistics
constraint concerns sessions that played; an uncommitted session never did.

### 6. Next flow orphaned by a main-track incompatible header (`src/nimio-transport.js`)

In `_onAudioCodecDataReceived()`, the main-track branch that today does
`this._decoderFlows["audio"].destroy(); this._decoderFlows["audio"] = null;
this._sldpManager.cancelStream(data.trackId); this._context.resetCurrentStream("audio");`
gains:

```js
if (this._nextRenditionData) {
  // the main flow's destroy already unpaired the next flow; without a main
  // flow the switch can never finalize, so fail it now
  const next = this._nextRenditionData;
  next.decoderFlow?.destroy();
  this._sldpManager.cancelStream(next.trackId);
  this._onRenditionSwitchResult("audio", false);
}
```

`next.decoderFlow` may not exist yet (setup not received); `destroy()` is
idempotent. Nothing reports twice: the main flow's destroy made the next flow
forget the pairing without a report (src side), and the main flow itself is
destroyed, not notified.

## Error handling

- A rejected worklet module load after a stop is logged at debug level only
  (the error log is for live runs).
- A disposed meter never calls its callbacks; `_onFatalError()` cannot
  re-initialise a cleared service.
- `MetricsManager.destroy()` and `VUMeterService.destroy()` are safe to call
  twice.

## Testing (vitest, jsdom)

- `tests/nimio-live-audio.test.js` (new; minimal engine via `Object.create`,
  fake audio context whose `addModule` is a controllable promise, fake
  `AudioWorkletNode`): init cancelled by `_stopAudio()` resolves and creates no
  node; a module that fails after the stop logs no error; a stale start-ts
  request after a stop and restart resolves `false` and records nothing; the
  sync-clock reply arriving after a stop touches no node; the advertizer
  eval-ready reply uses the node it was registered on; no-audio mode keeps an
  existing node and context.
- `tests/nimio-live.test.js`: setups ignored while stopped; `destroy()`
  removes the sync-mode listener; `detach()` keeps alive when `sessionReady`
  and closes through the manager when not, without emitting
  `nimio:playback-end`.
- `tests/nimio-transport-switch.test.js`: main-track incompatible update with
  a pending next rendition destroys the next flow, cancels its stream and
  reports the switch failed once; without a pending rendition nothing extra
  happens.
- `tests/metrics-manager.test.js`, `tests/audio-graph-controller.test.js`,
  `tests/vumeter-service.test.js` (new): as in PR #92's references; the VU
  meter test drives a real `VUMeterService` with a fake `AudioContext` whose
  module load settles or fails after `clear()`.

Suite-level: `npx vitest run`, `npm run prettier:check`.

## Delivery

- One code commit on a code-only branch `fix/live-after-stop-guards-pr`
  stacked on `fix/media-after-stop-guards-pr`; spec and plan local.
- PR title: "Guard the live engine after stop and release its services on
  destroy". Depends on PR 2a (and PR 1).
