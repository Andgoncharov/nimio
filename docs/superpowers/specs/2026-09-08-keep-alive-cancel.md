# Spec: Terminate the live keep-alive when the player is stopped in VOD mode

**Date:** 2026-09-08
**Branch:** `fix/keep-alive-cancel`
**Status:** Draft for discussion

## Problem

When Nimio is started in LIVE mode and then switched to VOD mode, the live
SLDP session is deliberately kept open. While detached, `SLDPManager` runs a
**keep-alive loop**: every 10 seconds it sends a `Cancel` command with an
**empty stream list** (`{ command: "Cancel", streams: [] }`) to keep the
WebSocket session alive on the server.

If the player is **stopped while in VOD mode**, the live session is never
terminated: the WebSocket stays open and the keep-alive `Cancel`-with-empty-list
messages keep being sent indefinitely. This leaks a server-side session and
network traffic for the lifetime of the page.

## Root cause (verified)

All player stop entry points ultimately call `SLDPManager.stop()`
(`src/sldp/manager.js`). During the LIVE→VOD switch, the live streams are
released (`_reqStreams` is emptied by `resetRequestedStreams()` in
`NimioLive.detach()`), and the keep-alive timer is armed by
`SLDPManager.keepAliveConnection()`.

The current `stop()` is:

```js
stop(opts = {}) {
  const sns = this.resetRequestedStreams();
  if (sns.length === 0) return;                 // (A)
  this._sendRequest("stop", { sns, close: !!opts.closeConnection });
}
```

Two coupled defects:

1. **Early return skips the close (A).** In VOD mode there are no requested
   streams, so `sns.length === 0` and `stop()` returns *before* sending the
   `stop` command — even when `closeConnection` was requested. The socket is
   never told to close.

2. **The keep-alive timer is only ever "soft-cancelled" by `_sendRequest`.**

   ```js
   _sendRequest(command, data) {
     this._keepAliveTimer = undefined;   // no clearTimeout()
     this._transport.send(command, data);
   }
   ```

   `_sendRequest` sets the timer field to `undefined` but never calls
   `clearTimeout`; cancellation relies on the fired callback checking
   `if (!this._keepAliveTimer) return;`. Because the empty-`sns` early return
   at (A) means `_sendRequest` is never called, the keep-alive loop is never
   cancelled and keeps re-arming itself forever.

There is no explicit "stop keep-alive" teardown anywhere; the loop's lifetime
is an accidental side effect of `_sendRequest`.

### Domain constraint: keep-alive preserves the server-side session for statistics

The persistent SLDP session (held open by the keep-alive loop) is the media
server's identity for that viewer. Keep-alive **must be preserved** across the
LIVE→VOD switch and across the VOD-failover path, so that when the client
returns to live (the stream becomes available again) it reuses the **same**
session. If the client instead drops the session and re-requests the live
stream, the server treats it as a **new, separate session** and reports wrong
numbers in the viewer statistics (double-counting / churn).

Therefore keep-alive must be torn down **only when the session is genuinely
being abandoned** — a closing stop (`closeConnection === true`: user stop,
`destroy()`). It must **not** be torn down on the preserve paths
(`keepConnection: true`: the VOD detach and the `_onInvalidStatus` failover).

### Which `NimioLive.stop()` paths reach `SLDPManager.stop()` (and whether that is correct)

`NimioLive.stop()` decides whether to call the manager at all:

```js
stop(opts = {}) {
  const isStopped = this._state.isStopped();
  const closeConnection = !opts.keepConnection;
  if (!isStopped || (closeConnection && this._transport.connected)) {
    this._sldpManager.stop({ closeConnection });   // (B) may be skipped
  }
  if (isStopped) return;
  ...
}
```

`_sldpManager.stop()` is **omitted** exactly when
`isStopped && (opts.keepConnection || !this._transport.connected)`.

The keep-alive loop is armed **only** in `NimioLive.detach()`, immediately after
`this.stop({ keepConnection: true })` sets the state to `STOPPED`. So for the
entire window in which keep-alive is on (the live player is detached during VOD),
`isStopped` is `true`. The manager is therefore called **only** when the caller
passes a closing stop (`opts.keepConnection` falsy) *and* the socket is still
connected.

1. **`stop({ keepConnection: true })` during VOD — CORRECT to skip the manager.**
   `_onInvalidStatus()` (`src/nimio-transport.js`; currently named
   `_onTransportError()` — see Naming fix below) calls
   `this.stop({ keepConnection: true })` when the SLDP agent posts
   `{ type: "error" }` on an invalid/empty status (`src/sldp/agent.js`) — the
   server's reply to a live request (or keep-alive `Cancel`) that returns no
   `stream_info`, i.e. "no live source right now". The guard skips the manager,
   the connection is kept, and keep-alive keeps running. **This is the intended
   behavior:** the session must survive so a later switch back to live reuses it
   (see the domain constraint above). A closing stop issued later (user stop /
   `destroy()`) is what ends it. The fix must **not** cancel keep-alive here.

2. **Closing `stop()` while keep-alive is on — the case the fix must handle.**
   A genuine stop (`closeConnection: true`) during VOD reaches the manager as
   long as the socket is connected — which it is, precisely because keep-alive
   held it open. With the `SLDPManager.stop()` fix, the manager cancels the
   loop and sends `close: true` even with no requested streams. Sub-case: if the
   socket already reported `connected === false`, the manager is skipped, but the
   keep-alive callback self-cancels on its next tick
   (`if (!this._transport.connected) this._keepAliveTimer = undefined;`) and does
   not re-arm, so any residual loop is bounded to ≤1 interval (~10 s).

**Conclusion:** the teardown belongs at the `SLDPManager` layer, gated on the
closing stop. No unconditional teardown in `NimioLive.stop()` — that would kill
the session on the failover path and corrupt the server's statistics.

### Evidence

A focused reproduction against `SLDPManager` with a mock transport and fake
timers (run during investigation, then removed) demonstrated:

- After `stop({ closeConnection: true })` with no requested streams,
  **6 additional keep-alive messages** were sent over the following 60s
  (expected: 0).
- `stop({ closeConnection: true })` sent **no `close` command** at all
  (expected: exactly one `stop` with `close: true`).

## Desired behavior

A **closing stop** (`closeConnection === true`: user stop, `destroy()`) must
terminate the live session cleanly, regardless of whether any streams are
currently requested — while the **preserve paths** (`keepConnection: true`) keep
the session and its keep-alive loop alive (see Domain constraint above):

1. On a closing stop, `SLDPManager.stop()` **cancels the keep-alive timer.**
   After a closing stop, no further keep-alive `Cancel` messages are sent.
2. On a closing stop, `stop()` **sends the `stop` command with `close: true`**
   even if there are no requested streams, so the WebSocket is closed.
3. **Preserve paths keep keep-alive running.** `NimioLive.stop({ keepConnection:
   true })` — the VOD detach and the `_onInvalidStatus()` failover — must leave
   the session and the keep-alive loop intact so a later return to live reuses
   the same server session. The fix must **not** add an unconditional keep-alive
   cancel to `NimioLive.stop()`.
4. Existing behavior is preserved:
   - Stop with requested streams still sends `stop` with those `sns` and the
     appropriate `close` flag.
   - The LIVE→VOD detach flow still keeps the connection alive: `stop()` with
     `closeConnection: false` does not close the socket, and the subsequent
     `keepAliveConnection()` call re-arms the keep-alive loop.

## Scope

- **In scope:**
  - `src/sldp/manager.js` — on a closing stop, cancel the keep-alive timer and
    send `close` even when no streams are requested; make the cancel robust
    (`clearTimeout`, not just dropping the reference); expose a public
    `cancelKeepAlive()`.
  - `src/nimio-live.js` — `NimioLive.destroy()` force-calls
    `this._sldpManager.cancelKeepAlive()`. `destroy()` is always a genuine
    teardown, so this is safe and also covers the case where the socket already
    reported `connected === false` (the manager would otherwise be skipped by the
    `NimioLive.stop()` guard). It does **not** touch the failover path.
  - `src/nimio-transport.js` — rename the misnamed callback (currently
    `_onTransportError()`) to `_onInvalidStatus()` (see below).
- **Out of scope:** `NimioVod`/`Nimio` orchestration; the `_onInvalidStatus`
  keep-alive *preservation* behavior (intended — only the name changes); the
  keep-alive interval; the SLDP wire protocol.

### Naming fix: `_onTransportError()` is a misnomer

`_onTransportError()` does not fire on a transport/socket failure (that path is
`_onDisconnect()`). It fires when the SLDP agent posts `{ type: "error" }`
because the server returned an invalid/empty status with no `stream_info`
(`src/sldp/agent.js`) — i.e. the live stream has no playable source right now.
Rename it to **`_onInvalidStatus()`** to reflect the actual condition it
handles (it stops the streams, keeps the connection, and emits `NO_SRC`). The
transport callback key it is registered under stays `"error"` for now (renaming
the worker message type is a broader change, out of scope).

> **Correction to the earlier "lift teardown into `NimioLive.stop()`"
> assumption:** an unconditional teardown in `NimioLive.stop()` would cancel
> keep-alive on the `_onInvalidStatus()` (renamed from `_onTransportError()`)
> failover path and break the server's viewer statistics (Domain constraint).
> The teardown stays in `SLDPManager.stop()`, gated on the closing stop, which
> is reached on genuine stops because keep-alive keeps the socket connected. The
> one exception is `NimioLive.destroy()`, which force-cancels keep-alive because
> it is unconditionally a full teardown.

## Constraints

- Preserve the keep-alive-during-VOD behavior (used by `NimioLive.detach()`).
- No new dependencies. Match the existing code style in `src/sldp/manager.js`.
- Unit tests run under Vitest + jsdom (`vitest.config.js`), using fake timers.
