# Terminate transport and decoder workers on destroy — Design

**Date:** 2026-10-14
**Branch:** `fix/worker-termination` (from upstream `main` at `f2d6eea`)
**Status:** Approved design, awaiting implementation plan
**Origin:** first of three PRs that replace PR #92 after upstream #95 covered its
service-release foundation. The other two (after-stop guards; facade and UI
hardening) get their own specs.

## Goal

A `Nimio` player that is destroyed must leave no Worker thread behind. Today
two kinds of worker survive `destroy()`:

1. **The transport worker.** `TransportAdapter` creates a `Worker` and never
   terminates it. The worker holds the adapter callbacks, which hold the live
   engine, which holds everything else, so the thread and its object graph
   leak per create/destroy cycle.
2. **A decoder worker that never got codec data.** `decoder-video.js` and
   `decoder-audio.js` handle `shutdown` only `if (videoDecoder)` /
   `if (audioDecoder)`. When the flow is destroyed before the first codec
   data created a decoder, the worker neither acknowledges nor closes, and
   `DecoderFlow` only terminates on `shutdownComplete`, so the thread leaks.
   A wedged or crashed worker leaks the same way.

## Non-goals

- Dropping late frames or ignoring late errors in a destroyed flow, and
  refusing to adopt a switch peer after destroy (second PR).
- SLDP manager run token, audio initialisation generation, sync-mode listener,
  metrics and audio-graph release (second PR).
- Idempotent, failure-isolated `Nimio.destroy()`, constructor rollback, UI
  observer and caption handler release (third PR).
- Any change to `Nimio.destroy()` ordering or to the service registry.

## Design

### 1. Transport worker: `terminate` command (`src/transport/web-socket.js`)

A new branch handled before the `!socket` guard:

```js
if (type === "terminate") {
  if (socket) closeSocket();
  self.close();
  return;
}
```

`closeSocket()` is upstream's helper (#98, extended by #90): it clears
`onopen`, `onclose` and `onmessage`, closes the socket, forgets it and posts
`{ aux: true, connected: false }`. No `disconnect` message is posted, so the
main thread sees a clean shutdown, not a dropped connection.

### 2. `TransportAdapter.destroy()` (`src/transport/adapter.js`)

```js
const TERMINATE_FALLBACK_MS = 1000;

destroy() {
  const worker = this._worker;
  if (!worker) return;                 // idempotent

  this._worker = undefined;
  this._callbacks = {};
  this._connected = false;
  worker.onmessage = null;
  try {
    worker.postMessage({ type: "terminate" });
  } catch (err) {
    this._logger.debug("Transport worker terminate request failed", err);
  }
  setTimeout(() => worker.terminate(), TERMINATE_FALLBACK_MS);
}
```

- `send()` returns without posting when `_worker` is undefined.
- `runCallback()` returns without calling anything when `_worker` is
  undefined. Its existing "no callback set" branch gains a `return` so it no
  longer logs and then throws on the missing function.
- The hard `worker.terminate()` is a safety net for a wedged worker. In the
  normal case the worker has already run `self.close()` and the call is a
  no-op.
- Ordering: `postMessage` delivery is in order, so a closing stop posted by
  `NimioLive.stop()` earlier in the same teardown is processed (Cancel sent,
  socket closed) before `terminate`. This is why `terminate()` is not called
  immediately: that would kill the thread with the stop still queued and drop
  the server session without a close frame.

### 3. Call site (`src/nimio-live.js`)

`NimioLive.destroy()` gains `this._transport.destroy()` as its last step:

```js
destroy() {
  this.stop();
  this._removeUIEventHandlers();
  this._deinitTransport();
  this._reconnect.destroy();
  this._transport.destroy();
}
```

`Nimio.destroy()` is unchanged. After the transport is destroyed,
`transport.connected` is `false`, so an armed SLDP keep-alive timer exits on
its next tick (the closing stop already cancelled it when the socket was
connected).

### 4. Decoder workers acknowledge unconditionally

In `src/media/decoders/decoder-video.js` and `decoder-audio.js`, the
`shutdown` case always ends with `self.postMessage({ type: "shutdownComplete" })`
and `self.close()`. The decoder-specific cleanup (clearing buffers and
timings, closing the codec) stays inside the existing `if (decoder)` guard.

### 5. Decoder flow hard-terminate fallback (`src/media/decoders/flow.js`)

```js
const SHUTDOWN_FALLBACK_MS = 1000;

destroy() {
  const decoder = this._decoder;
  if (!decoder) return;

  this._switchPeerFlow = null;
  this._cancelInput();
  this._shutdown();                    // no-op when a switch already posted it
  this._scheduleForcedTermination(decoder);
  this._trackId = null;
  if (this._buffer) {
    this._buffer.reset();
    this._buffer = null;
  }
}

_scheduleForcedTermination(decoder) {
  setTimeout(() => {
    if (this._decoder !== decoder) return;   // shutdownComplete handled it
    this._removeDecoderListener();
    decoder.terminate();
    this._decoder = null;
  }, SHUTDOWN_FALLBACK_MS);
}
```

- The early return on `_isShuttingDown` is removed: a destroy that follows a
  rendition switch's shutdown must still arm the fallback, otherwise a worker
  that never acknowledges that shutdown leaks.
- The fallback is keyed on worker identity. If `shutdownComplete` arrived
  first, the handler terminated the worker and set `_decoder` to `null` (or to
  the switch peer's worker), so the fallback does nothing.
- The `shutdownComplete` handler is unchanged and remains the normal path.
- Errors thrown by the cancel or shutdown steps are not caught here; failure
  isolation belongs to the facade PR.

## Error handling

- `postMessage` to a worker that is already gone throws; `destroy()` logs at
  debug level and still schedules the hard terminate.
- `worker.terminate()` on a closed worker is a no-op by specification.
- No new errors are surfaced to the application.

## Testing (vitest, jsdom)

- `tests/transport-adapter.test.js` (new, fake `Worker`): destroy posts
  `terminate`, nulls `onmessage`, reports disconnected and does not terminate
  immediately; fallback terminates at exactly 1000 ms; a throwing
  `postMessage` still schedules the fallback; destroy twice posts once and
  terminates once; `send()` after destroy posts nothing; `runCallback()` after
  destroy calls nothing and does not throw; `runCallback()` with no callback
  logs and does not throw.
- `tests/transport-web-socket.test.js` (upstream's file, two cases added):
  `terminate` with an open socket closes it with handlers cleared, posts
  `connected: false`, posts no `disconnect`, and calls `self.close()`;
  `terminate` without a socket calls `self.close()` only.
- `tests/decoder-video.test.js`, `tests/decoder-audio.test.js`: `shutdown`
  before any codec data posts `shutdownComplete` and calls `close()`.
- `tests/flow-audio.test.js` (fake decoder worker, fake timers): destroy
  hard-terminates a worker that never acknowledges, after 1000 ms and not
  before; the same when `_isShuttingDown` was already set by a switch;
  `shutdownComplete` before the deadline terminates once and the fallback does
  not terminate again; destroy with no worker is a no-op.
- `tests/nimio-live.test.js`: `destroy()` calls `transport.destroy()` after
  the existing steps.

Suite-level: `npx vitest run`, `npm run prettier:check`.

## Delivery

- Branch `fix/worker-termination` from upstream `main`; one code commit for
  the PR (spec and plan commits stay local, as for PR #90).
- PR title: "Terminate transport and decoder workers on destroy".
- PR #92 is closed with a comment linking this PR and naming the two
  follow-ups.
