# Media path after-stop guards — Design

**Date:** 2026-10-14
**Branch:** `fix/media-after-stop-guards`, stacked on PR 1's code branch
`fix/worker-termination-pr` (`efe8964`, itself on upstream `main` at `f2d6eea`).
The decoder-flow changes extend PR 1's `destroy()` and fallback timer, so this
PR depends on PR 1 and is rebased onto `main` once PR 1 lands.
**Status:** Implemented on `fix/media-after-stop-guards` (code commit on top of PR 1), including the review follow-ups listed in the plan's Task 7
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

`cancelPendingStreams()` bumps the sequence without starting a call, so a
`setStreams()` that is still awaiting the codec check commits nothing when it
settles. The manager calls it on every stop and on `destroy()`; the context
must not commit stale metadata just because the manager will ignore the reply
(found in review: the token check alone ran after the commit).

### 2. `SLDPManager` run token, setup timers, `destroy()` (`src/sldp/manager.js`)

- Constructor: `this._setupTimers = new Set(); this._runToken = 0;`
- `resetRequestedStreams()` (called by every `stop()`): `this._runToken++;
this._cancelSetupTimers(); this._context.cancelPendingStreams();` before
  the existing body.
- `start(url)`: `this._startToken = this._runToken; this._sessionReady = false;`
  first.
- Status callback:

```js
this._transport.setCallback("status", async (status) => {
  if (this._startToken !== this._runToken) return; // stopped since start()
  const token = this._runToken; // before any emit
  if (this._useSyncMode) {
    this._handleSyncParams(status); // emits nimio:sync-mode-params
    if (token !== this._runToken) return; // a listener stopped us
  }
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
- `destroy()`: `this._runToken++; this._cancelSetupTimers();
this._context.cancelPendingStreams(); this._sessionReady = false;
this.cancelKeepAlive();`
- The token is captured before the sync-mode emit: a listener that stops
  playback bumps the token, and a capture taken afterwards would treat the
  stopped work as current (found in review).
- `requestCurrentStreams()` is unchanged (it is a synchronous path from
  `attach()`), but reuse is gated: `sessionReady` is `false` from `start()`
  and `destroy()` and turns `true` only when a status reply committed its
  metadata for the current run. A non-closing stop (detach) during the codec
  check cancels the pending commit, so the kept-alive socket has no stream
  list to reuse; `attach()` then performs a fresh handshake instead of
  requesting current streams from an empty context (found in review).

### 2b. Transport session: replies of a replaced run are dropped

The run token cannot see a reply the worker had already posted for the old
socket before `stop()` ran, delivered after a new `start()` (for example
`setStreamURL()`): `_startToken` matches the new run and the message carries
no identity (found in review). Internal messages, not the SLDP wire, gain one:

- `TransportAdapter.send("start", data)` sets `data.session = ++this._session`.
- The worker hands `e.data.session` to the protocol agent (`agent.session`).
- `SLDPAgent` adds `session: this._session` to every message it posts
  (`status`, `error`, codec data, chunks).
- The worker tags its socket lifecycle notifications too: `connected: true`
  on open, `disconnect` and `connected: false` on close, and the
  `connected: false` of `closeSocket()`, each with the session of the socket
  they describe. Otherwise a disconnect an old socket had already posted
  could arrive after a restart, stop the new playback state and invalidate
  its fresh status reply (found in review).
- `TransportAdapter._handleMessage()` drops a message whose `session` is
  present and differs from the adapter's current one. Only messages that
  predate any start carry no session.

### 3. `NimioLive.destroy()` and `attach()` (`src/nimio-live.js`)

`attach()` reuses the connected transport only when
`this._sldpManager.sessionReady` holds; otherwise it calls `start()`, as it
does for a disconnected transport.

### 3a. `NimioLive.destroy()`

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
    if (!res || this._destroyed || !this._buffer) {
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

The subclasses' `_handleDecoderOutput()` (`flow-audio.js`, `flow-video.js`)
return right after the await when the flow was destroyed meanwhile, so no
decoder-queue or latency state is written for a destroyed flow.

### 5. Switch abort cleanup (`src/media/decoders/flow.js`)

Roles: the main flow calls `switchTo(newFlow)` and becomes `dst`; the new
rendition flow becomes `src`. Only the main flow has `onSwitchResult`.

- New `_onPeerDestroyed()` on the flow that is still alive. If the main flow
  had already committed (`finalizeSwitch()` cancelled its input and posted its
  own shutdown) when the peer died, there is no decoder to fall back to: after
  reporting the failed switch it also raises `onDecodingError(type)`, so the
  engine applies its existing no-video / no-audio / stop handling instead of
  leaving a silent freeze (found in review):

```js
_onPeerDestroyed() {
  if (this._switchContext?.dst) {
    this._failSwitch(SWITCH_ABORT_MSG);
    return;
  }
  // the src side only forgets the pairing; the main flow owns the result
  this._switchContext = null;
  this._switchPeerFlow = null;
}

// Main (dst) flow: drop the switch state, report once, recover when this
// flow cannot continue on its own. Returns the former peer (unpaired).
_failSwitch(msg, lostDecoder = false) {
  const inputCancelled = !!this._switchContext?.inputCancelled;
  const peer = this._switchPeerFlow;
  this._switchContext = null;
  this._switchPeerFlow = null;
  if (this._state?.isStopped()) return peer; // teardown is silent
  this._onSwitchResult?.(false, msg);
  if (lostDecoder || inputCancelled || this._isShuttingDown) {
    this._onDecodingError?.(this._type);
  }
  return peer;
}
```

`inputCancelled` is read from the switch context before it is cleared.
`processChunk()` cancels the main stream on the first dst key chunk that the
new rendition already covers, before `finalizeSwitch()` runs, so the recovery
must key on the cancelled input, not only on the shutdown (found in review).

The main flow has one place that fails a switch, `_failSwitch(msg, lostDecoder)`:
it reads `inputCancelled`, clears the switch state, returns the former peer,
and unless playback is stopped reports the failure once and recovers via
`onDecodingError` when the input was cancelled, the shutdown was posted, or
the decoder is gone. `_onPeerDestroyed()` on the main flow, the excessive-gap
abort in `_handleDstSwitchFrame()` (which then destroys the returned peer) and
the inactive-peer adoption guard (with `lostDecoder = true`) all go through
it, so the gap abort no longer discards the cancellation state (found in
review).

Single owner on the engine side: `_onAudioCodecDataReceived()` destroys the
next flow on an incompatible updated header and reports the failure itself
only if `_nextRenditionData` is still set afterwards. The explicit `cancelStream()` lives in the same branch:
once paired, `destroy()` already cancelled the stream through `onInputCancel`,
and a second cancellation only logs "Stream with sn ... was not requested"
(found in review). Once the flows are
paired, destroying the next flow makes the main flow report through
`_onPeerDestroyed()`, which clears `_nextRenditionData`; reporting again
dereferenced `null` (found in review).

- `decoderError` on a `src` flow: `this.destroy(); break;` (no call to its own
  `_onSwitchResult`). The destroy notifies the main flow, which reports once.
- `_handleSrcSwitchFrame()` excessive gap: unchanged (`frame.close(); this.destroy();`);
  the notification now reports the failure, which today is silent.
- `_handleDstSwitchFrame()` excessive gap: clear own pointers first, then destroy
  the peer, then report:

```js
const peer = this._failSwitch(`Rendition switch isn't possible, ...`);
peer.destroy(); // already unpaired: no notification back
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

Review follow-ups (plan Task 7) added: `sessionReady` lifecycle and the
detach-during-codec-check sequence against the real context; a sync-mode
listener that stops playback; `cancelPendingStreams()`; transport session
numbering, filtering and lifecycle tagging (`tests/transport-adapter.test.js`,
`tests/transport-web-socket.test.js`, `tests/sldp-agent.test.js`); the
adapter reporting disconnected on a new start; switch-abort ownership
(`_failSwitch` paths, input-cancelled recovery, adoption guard escalation);
incompatible audio update before and after pairing with the real
`_onRenditionSwitchResult` (`tests/nimio-transport-switch.test.js`);
`attach()` handshaking again when the session is not ready; subclass output
guards after destroy.

Suite-level: `npx vitest run`, `npm run prettier:check`.

## Delivery

- Branch `fix/media-after-stop-guards` stacked on `fix/worker-termination-pr`;
  one code commit for the PR on a code-only branch, spec and plan local. The
  PR is opened against `main` with a note that it depends on PR 1; GitHub shows
  only its own commit once PR 1 is merged.
- PR title: "Drop late decoder messages and stale SLDP replies after stop".
