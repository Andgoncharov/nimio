# Media path after-stop guards — Design

**Date:** 2026-10-14
**Branch:** `fix/media-after-stop-guards`, stacked on PR 1's code branch
`fix/worker-termination-pr` (`efe8964`, itself on upstream `main` at `f2d6eea`).
The decoder-flow changes extend PR 1's `destroy()` and fallback timer, so this
PR depends on PR 1 and is rebased onto `main` once PR 1 lands.
**Status:** Approved design, awaiting implementation plan
**Origin:** second of the PRs that replace PR #92 (PR 2a). PR 1 terminates the
transport and decoder workers (`fix/worker-termination`). PR 2b covers the live
engine's audio initialisation guards and the service destroy hooks; PR 3 covers
the facade and UI.

## Goal

Work that was started before a stop or destroy must not act afterwards on the
media path:

1. A decoder worker message delivered after `DecoderFlow.destroy()` must not
   reach the buffer, the engine or a switch peer.
2. An SLDP status reply that belongs to a run that was stopped must not apply
   streams or request playback.
3. A rendition switch whose new flow dies mid-switch must leave the main flow
   able to switch again, and must report the failure exactly once.

## Problems (verified in the code at `efe8964`)

- `DecoderFlow._handleDecoderMessage()` processes `decodedFrame` and
  `decoderError` after `destroy()`; the buffer is already `null`, so
  `_pushToBuffer()` throws, and a `decodedFrame` whose `_handleDecodedFrame()`
  was awaiting `onStartTsNotSet` when the flow was destroyed pushes into a
  released buffer. The `shutdownComplete` branch adopts a switch peer even on a
  destroyed flow.
- `DecoderFlow.destroy()` is re-entrant until the worker acknowledges; every
  call arms another fallback timer (harmless, identity-guarded, but noisy).
- `SLDPManager`'s status callback awaits `_processStatus()` and then sends
  `play` with no check that the run is still alive. `PlaybackContext.setStreams()`
  mutates shared state before its await, so a stop and restart while the codec
  check is pending leaves a half-applied stream list. `requestStream()` arms a
  `setTimeout` that fires `videoSetup`/`audioSetup` after a stop. There is no
  `destroy()`, so an armed keep-alive survives release when the transport
  already reported disconnected.
- Switch abort: when the new-rendition flow (the `src` side of a switch)
  destroys itself on a decoder error or an excessive timestamp gap, the main
  flow (`dst`) keeps its `_switchContext` and `_switchPeerFlow`. A later
  `switchTo()` on the main flow never starts (`_startSwitch()` sees a context),
  and if the main flow finalizes it adopts a `null` worker and absorbs a `null`
  buffer. The `src` decoder-error path also calls `this._onSwitchResult(false)`
  on itself, but only the main flow has that callback (`_createMainDecoderFlow`),
  so the call throws, the handler's promise rejects, and `this.destroy()` never
  runs: the new flow's worker is not even shut down.

## Non-goals

- Live engine audio initialisation generation, setups ignored while stopped,
  `nimio:sync-mode-params` listener removal, `MetricsManager` /
  `AudioGraphController` destroy hooks, VU meter pending loads (PR 2b).
- `Nimio.destroy()` idempotence and failure isolation, constructor rollback,
  UI (PR 3).
- Any change to the SLDP wire protocol, the keep-alive interval, or the
  switch threshold.

## Design

### 1. `PlaybackContext.setStreams()` commits atomically (`src/playback/context.js`)

```js
async setStreams(streams) {
  const seq = (this._streamsSeq = (this._streamsSeq || 0) + 1);
  const cSupport = await this._checkSupportedCodecs(streams);
  if (seq !== this._streamsSeq) return false;   // superseded while checking

  // compute streamsMap, ordVideoRenditions, ordAudioRenditions,
  // ordRenditions into locals exactly as today, reading `cSupport`
  // ...
  // commit in one synchronous step
  this._streams = streams;
  this._streamsMap = streamsMap;
  this._cSupport = cSupport;
  this._ordVideoRenditions = ordVideoRenditions;
  this._ordAudioRenditions = ordAudioRenditions;
  this._ordRenditions = ordRenditions;
  return true;
}
```

Shared state is touched only after the await, in one step. The per-stream
`stream_info` normalisation (`parseInt`, width/height/name) stays as today; it
mutates the objects of the `streams` argument, which belong to this call.
Callers that ignore the return value are unaffected.

### 2. `SLDPManager` run token, setup timers, `destroy()` (`src/sldp/manager.js`)

- Constructor: `this._setupTimers = new Set(); this._runToken = 0;`
- `resetRequestedStreams()` (called by every `stop()`): `this._runToken++;
this._cancelSetupTimers();` before the existing body.
- `start(url)`: `this._startToken = this._runToken;` first.
- Status callback:

```js
this._transport.setCallback("status", async (status) => {
  if (this._startToken !== this._runToken) return; // stopped since start()
  if (this._useSyncMode) this._handleSyncParams(status);
  const token = this._runToken;
  const streams = await this._processStatus(status.info);
  // stopped during the codec check, or by a connection-established listener
  if (!streams || token !== this._runToken) return;
  this._sendRequest("play", { streams });
});
```

- `_processStatus(streams)` resolves to the streams to request, or `null`:

```js
async _processStatus(streams) {
  const token = this._runToken;
  const committed = await this._context.setStreams(streams);
  if (!committed || token !== this._runToken) return null;
  // unsupported-codec warnings as today
  this._processCurrentStreams();
  const requested = this._curStreams;
  this._curStreams = [];
  this._eventBus.emit("nimio:connection-established", streamsConfig);
  return requested;
}
```

- `requestStream()`:

```js
const timer = setTimeout(() => {
  this._setupTimers.delete(timer);
  this._transport.runCallback(`${type}Setup`, setup);
}, 0);
this._setupTimers.add(timer);
```

- `_cancelSetupTimers()`: `clearTimeout` each and clear the set.
- `destroy()`: `this._runToken++; this._cancelSetupTimers(); this.cancelKeepAlive();`
- `requestCurrentStreams()` is unchanged (it is a synchronous path from
  `attach()`).

### 3. `NimioLive.destroy()` (`src/nimio-live.js`)

```js
destroy() {
  this.stop();
  this._removeUIEventHandlers();
  this._deinitTransport();
  this._reconnect.destroy();
  this._sldpManager.destroy();
  this._transport.destroy();
}
```

### 4. Decoder flow after destroy (`src/media/decoders/flow.js`)

- `destroy()`:

```js
destroy() {
  if (this._destroyed) return;         // idempotent: one shutdown, one timer
  this._destroyed = true;
  const decoder = this._decoder;
  const peer = this._switchPeerFlow;
  this._switchPeerFlow = null;
  if (peer && peer._switchPeerFlow === this) peer._onPeerDestroyed(); // §5
  if (!decoder) return;
  this._cancelInput();
  this._shutdown();
  this._scheduleForcedTermination(decoder);
  this._trackId = null;
  if (this._buffer) { this._buffer.reset(); this._buffer = null; }
}
```

- `_handleDecoderMessage()`:
  - `decodedFrame`: after `_prepareFrame`, `if (this._destroyed) { frame.close(); break; }`.
  - `decoderError`: `if (this._destroyed) break;` first.
  - `shutdownComplete`: after terminating the worker as today,
    `if (this._destroyed) { this._switchPeerFlow = null; this._switchContext = null; break; }`.
- `_handleDecodedFrame(frame)`:

```js
if (this._destroyed || !this._buffer) {
  frame.close();
  return false;
}
if (this._state.isStopped()) {
  frame.close();
  return true;
}
if (this._startTsUs === 0) {
  if (this._onStartTsNotSet) {
    let res;
    try {
      res = await this._onStartTsNotSet(frame);
    } catch (err) {
      this._logger.error("Flow output initialization failed", err);
      res = false;
    }
    if (!res || !this._buffer) {
      frame.close();
      return false;
    } // failed, or destroyed while waiting
  }
  if (this._startTsUs === 0)
    this._startTsUs = this._state.getPlaybackStartTsUs();
}
this._pushToBuffer(frame);
return true;
```

### 5. Switch abort cleanup (`src/media/decoders/flow.js`)

Roles: the main flow calls `switchTo(newFlow)` and becomes `dst`; the new
rendition flow becomes `src`. Only the main flow has `onSwitchResult`.

- New `_onPeerDestroyed()` on the flow that is still alive:

```js
_onPeerDestroyed() {
  const wasDst = !!this._switchContext?.dst;
  this._switchContext = null;
  this._switchPeerFlow = null;
  // the main flow owns the switch result; teardown (state stopped) is silent
  if (wasDst && this._onSwitchResult && !this._state?.isStopped()) {
    this._onSwitchResult(false, "Rendition switch aborted: the new rendition's decoder stopped");
  }
}
```

- `decoderError` on a `src` flow: `this.destroy(); break;` (no call to its own
  `_onSwitchResult`). The destroy notifies the main flow, which reports once.
- `_handleSrcSwitchFrame()` excessive gap: unchanged (`frame.close(); this.destroy();`);
  the notification now reports the failure, which today is silent.
- `_handleDstSwitchFrame()` excessive gap: clear own pointers first, then destroy
  the peer, then report:

```js
this._switchContext = null;
const peer = this._switchPeerFlow;
this._switchPeerFlow = null;
peer.destroy(); // peer sees our pointer is gone: no notification
this._onSwitchResult(false, `Rendition switch isn't possible, ...`);
```

- `shutdownComplete` adoption guard on the main flow: adopt only if
  `this._switchPeerFlow.isActive()`; otherwise clear the switch state and
  report failure once (same message as `_onPeerDestroyed`). With the
  notification in place this branch is defensive.
- `_resetPlayback()` order is unchanged. It runs after `_state.stop()`, so a
  notification during teardown finds the state stopped and reports nothing;
  `_onRenditionSwitchResult()` is therefore never invoked during a stop.

## Error handling

- A rejected `onStartTsNotSet` is logged at error level and the frame closed.
- `_onPeerDestroyed()` never throws when no callback is set.
- `destroy()` never throws on a second call.

## Testing (vitest, jsdom)

- `tests/playback-context.test.js` (new): a superseded `setStreams()` resolves
  `false`, commits nothing, and the newest call's streams and renditions win.
- `tests/sldp-manager-run.test.js` (new; fake transport with `callbacks`,
  fake context, fake timers): stop cancels queued setup callbacks; destroy
  cancels them; a status whose `_processStatus` settles after a stop sends no
  `play`; a stop during the codec check applies no streams and emits no
  `nimio:connection-established`; a stop from a connection-established listener
  prevents `play`; a cancelled status settling first does not clear the
  restarted status's `play` (exactly one `play`, with the fresh streams); a
  status arriving after a stop that preceded it, and after `destroy()`, requests
  nothing; `destroy()` clears an armed keep-alive and leaves no timers.
- `tests/flow-audio.test.js` additions (fake worker fixture from PR 1):
  `destroy()` twice posts one shutdown and arms one timer; a `decodedFrame`
  after destroy is closed and not pushed; a `decoderError` after destroy calls
  nothing; `shutdownComplete` on a destroyed flow with a peer terminates the
  worker and adopts nothing; a frame whose start-ts handler was pending when the
  flow was destroyed is closed and returns `false`; a throwing start-ts handler
  closes the frame and returns `false`; destroying the `src` peer clears the
  main flow's switch state and reports `onSwitchResult(false, msg)` once while
  playing; the same reports nothing when the main flow's state is stopped; a
  `decoderError` on the `src` flow destroys it (shutdown posted) and fails the
  switch through the main flow; the main flow's excessive-gap abort reports
  exactly once; after an aborted switch the main flow can start a new switch
  (`_startSwitch` returns `true`).
- `tests/nimio-live.test.js`: `destroy()` calls `sldpManager.destroy()` after
  `reconnect.destroy()` and before `transport.destroy()`.

Suite-level: `npx vitest run`, `npm run prettier:check`.

## Delivery

- Branch `fix/media-after-stop-guards` stacked on `fix/worker-termination-pr`;
  one code commit for the PR on a code-only branch, spec and plan local. The
  PR is opened against `main` with a note that it depends on PR 1; GitHub shows
  only its own commit once PR 1 is merged.
- PR title: "Drop late decoder messages and stale SLDP replies after stop".
