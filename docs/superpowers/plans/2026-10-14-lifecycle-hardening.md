# Facade, UI and VOD Lifecycle Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Nimio.destroy()` is idempotent, runs every step even when one throws, always releases the instance name, and rethrows the first error only afterwards; a failing constructor rolls back; every public method is a safe no-op on a destroyed player; the UI releases its observer and listeners, tolerates a removed container and rolls back a failed construction; the VOD engine removes a pending or failed hls.js script tag.

**Architecture:** A `runCleanupSteps()` helper isolates teardown steps and collects errors. The facade constructor delegates to `_init()` under a try and rolls back with `_rollbackInit()`; `destroy()` keys on a `_destroyed` flag, runs isolated steps, releases services, clears references and rethrows. API mixins null-check their collaborators. The UI constructor delegates to `_construct()` with `_rollbackConstruction()`. The VOD engine records its script element at insertion.

**Tech Stack:** Vanilla JS ES modules, Vitest + jsdom; vitest browser config (`npm run test:browser`) for the UI cases.

**Spec:** `docs/superpowers/specs/2026-10-14-lifecycle-hardening-design.md`

## Global Constraints

- Branch `fix/lifecycle-hardening`, stacked on PR 2b's code branch
  `fix/live-after-stop-guards-pr` (`9ae6ca5`). No changes to
  `src/nimio-transport.js` or the SLDP manager (PR 3b); `src/nimio-live.js`
  changes only in `destroy()` (isolated stages, spec §3, Task 7).
- Upstream's `allocateInstanceKey()` stays; no name-collision warning; no explicit `removeAllListeners()` step (the event bus release hook drops listeners).
- Project rule: **one code commit at the end** (Task 5). Earlier tasks only `git add`. Spec/plan commits stay local.
- `npx prettier --check src tests` and `npx vitest run` must be clean before the commit. `npm run test:browser` for Task 2; if the browser provider is unavailable on this machine, record it in the ledger and say so in the final report.
- Facade tests mock `@/ui/ui`, `@/nimio-live` and `@/nimio-vod` at module level and use the real event bus and services.

## Review Focus

- `destroy()` when the live engine's destroy throws: VOD engine and UI already torn down, name released, error rethrown, second `destroy()` a no-op → Task 4 tests.
- A constructor failure before the UI exists (invalid container): rollback must not dereference `_logger` or `_ui` → Task 4 test "leaves no services registered".
- `UI` constructor failing before `_addPlaybackEventHandlers()` ran: rollback must not call `_removePlaybackEventHandlers()` on unbound handlers → Task 2 rollback guards; browser test fails `_setupPip` (early) and `_setBackground` (late).
- `seekVod()` after destroy with a VOD engine that was loaded: must return `false` without touching the released context → Task 4 "neutral values" test.
- VOD `destroy()` while the script is pending, then the script loads: no `Hls` created, no services re-registered → Task 3 test.

---

### Task 1: `runCleanupSteps()` helper

**Files:**

- Modify: `src/shared/helpers.js` (append)
- Create: `tests/helpers.test.js`

**Interfaces:**

- Produces: `runCleanupSteps(logger, prefix, steps) → Error[]`; `steps` is an array of `[what, fn]`. Tasks 2 and 4 consume it.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from "vitest";
import { runCleanupSteps } from "@/shared/helpers";

describe("runCleanupSteps", () => {
  it("runs every step, logs failures and returns the errors in order", () => {
    const logger = { error: vi.fn() };
    const calls = [];
    const first = new Error("first");
    const second = new Error("second");

    const errors = runCleanupSteps(logger, "destroy", [
      ["a", () => calls.push("a")],
      [
        "b",
        () => {
          throw first;
        },
      ],
      ["c", () => calls.push("c")],
      [
        "d",
        () => {
          throw second;
        },
      ],
    ]);

    expect(calls).toEqual(["a", "c"]);
    expect(errors).toEqual([first, second]);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[0][0]).toBe("destroy: b failed");
    expect(logger.error.mock.calls[0][1]).toBe(first);
  });

  it("returns an empty list when nothing fails", () => {
    const logger = { error: vi.fn() };

    expect(runCleanupSteps(logger, "x", [["a", () => {}]])).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/helpers.test.js`
Expected: FAIL — `runCleanupSteps is not a function` (import is `undefined`).

- [ ] **Step 3: Implement**

Append to `src/shared/helpers.js`:

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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/helpers.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/shared/helpers.js tests/helpers.test.js
git add src/shared/helpers.js tests/helpers.test.js
```

---

### Task 2: UI observer, caption handler, removed container, constructor rollback

**Files:**

- Modify: `src/ui/ui.js` (constructor lines 24–129; `destroy()` lines 131–152)
- Modify: `tests/browser/ui-integration.test.js` (append a `describe`)

**Interfaces:**

- Consumes: `runCleanupSteps` (Task 1).
- Produces: `UI.prototype._construct(opts)`, `_rollbackConstruction()`; `destroy()` safe with a removed container.

- [ ] **Step 1: Write the failing browser tests**

Append to `tests/browser/ui-integration.test.js` (add `vi` to the vitest import and import `UICaptionController` from `@/ui/caption-controller`):

```js
describe("UI lifecycle", () => {
  const parents = [];
  const uis = [];

  afterEach(() => {
    for (const ui of uis) {
      try {
        ui.destroy();
      } catch {
        // already destroyed
      }
    }
    uis.length = 0;
    for (const p of parents) p.remove();
    parents.length = 0;
  });

  function newParent() {
    const parent = document.createElement("div");
    parent.style.cssText = "display:block;width:400px";
    document.body.appendChild(parent);
    parents.push(parent);
    return parent;
  }

  const opts = { width: "100%", height: "100%", ar: "16:9" };

  it("destroy tolerates a container already removed from the DOM", () => {
    const parent = newParent();
    const ui = new UI("life-removed", parent, opts, stubBus);
    uis.push(ui);
    parent.innerHTML = ""; // the host tore the player's container out

    expect(() => ui.destroy()).not.toThrow();
  });

  it("destroy removes the caption-list handler it subscribed", () => {
    const parent = newParent();
    const bus = { on: vi.fn(), off: vi.fn(), emit() {} };
    const ui = new UI(
      "life-captions-off",
      parent,
      { ...opts, captions: { CC1: { default: true } } },
      bus,
    );
    const handler = bus.on.mock.calls.find(
      (c) => c[0] === "aux:caption-list-open",
    )[1];

    ui.destroy();

    expect(bus.off).toHaveBeenCalledWith("aux:caption-list-open", handler);
  });

  it("a constructor failure early on leaves no DOM behind", () => {
    const parent = newParent();
    const spy = vi.spyOn(UI.prototype, "_setupPip").mockImplementation(() => {
      throw new Error("blocked by CSP");
    });
    try {
      expect(() => new UI("life-ctor-early", parent, opts, stubBus)).toThrow(
        "blocked by CSP",
      );

      expect(parent.childElementCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a constructor failure after captions were set up deinitializes them and leaves no DOM", () => {
    const parent = newParent();
    const proto = Object.getPrototypeOf(
      UICaptionController.getInstance("life-caption-probe"),
    );
    const deinit = vi.spyOn(proto, "deinit");
    const fail = vi
      .spyOn(UI.prototype, "_setBackground")
      .mockImplementation(() => {
        throw new Error("blocked by CSP");
      });
    try {
      expect(
        () =>
          new UI(
            "life-ctor-late",
            parent,
            { ...opts, captions: { CC1: { default: true } } },
            stubBus,
          ),
      ).toThrow("blocked by CSP");

      expect(deinit).toHaveBeenCalledTimes(1);
      expect(parent.childElementCount).toBe(0);
    } finally {
      fail.mockRestore();
      deinit.mockRestore();
    }
  });
});
```

Check that `_setupPip` and `_setBackground` exist on the prototype (`grep -n "_setupPip\|_setBackground" src/ui/ui.js`); if `_setupPip` does not, pick another method called early in the constructor after the container append (for example `_createCanvas`).

- [ ] **Step 2: Run the browser tests to verify they fail**

Run: `npm run test:browser -- tests/browser/ui-integration.test.js`
Expected: the four new tests FAIL — removed container throws `NotFoundError`; `off` not called; `childElementCount` 1 after a failed construction. If the browser provider cannot start on this machine, record `Task 2: browser tests not run locally (<reason>)` in the ledger and continue; the code changes are still verified by review and by the facade tests that mock the UI.

- [ ] **Step 3: Implement**

In `src/ui/ui.js`:

Import the helper: `import { runCleanupSteps } from "@/shared/helpers";`

Split the constructor after the "container element is not valid" throw:

```js
    this._parent = parent;
    if (!this._parent || !this._parent.appendChild) {
      throw new Error("UI container element is not valid");
    }

    try {
      this._construct(opts);
    } catch (err) {
      // never leave DOM, observers or document listeners behind
      this._rollbackConstruction();
      throw err;
    }
  }

  _construct(opts) {
    this._container = document.createElement("div");
    // ... the rest of today's constructor body, unchanged, through the
    // offscreen renderer block ...
  }

  _rollbackConstruction() {
    runCleanupSteps(this._logger, "UI construction rollback", [
      ["offscreen renderer", () => this._offscreenRenderer?.terminate()],
      ["captions", () => this._removeCaptions()],
      ["observer", () => this._resizeObserver?.disconnect()],
      [
        "display handlers",
        () => this._onViewportUpd && this._removeDisplayEventHandlers(),
      ],
      [
        "playback handlers",
        // bound as own properties by _addPlaybackEventHandlers()
        () =>
          Object.hasOwn(this, "_onPlaybackEnded") &&
          this._removePlaybackEventHandlers(),
      ],
      [
        "caption list handler",
        () =>
          this._onCaptionListOpen &&
          this._eventBus.off("aux:caption-list-open", this._onCaptionListOpen),
      ],
      [
        "container",
        () => this._container?.parentNode?.removeChild(this._container),
      ],
    ]);
    this._offscreenRenderer = undefined;
  }
```

Store the caption-list handler (inside `_construct`):

```js
this._captionList = new UICaptionList(this._controlsBar, this._eventBus);
this._captionCtrl.list = this._captionList;
this._onCaptionListOpen = () => this._closeAbrMenu();
this._eventBus.on("aux:caption-list-open", this._onCaptionListOpen);
```

`destroy()`:

```js
    this._container.removeEventListener("click", this._onClick);
    this._resizeObserver.disconnect();
    if (this._onCaptionListOpen) {
      this._eventBus.off("aux:caption-list-open", this._onCaptionListOpen);
      this._onCaptionListOpen = undefined;
    }
    while (this._container.firstChild) {
      this._container.removeChild(this._container.firstChild);
    }
    // the host may already have removed the container from the DOM
    this._container.parentNode?.removeChild(this._container);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:browser -- tests/browser/ui-integration.test.js` (if available) and `npx vitest run` (jsdom suite must stay green; the UI is only imported there).
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/ui/ui.js tests/browser/ui-integration.test.js
git add src/ui/ui.js tests/browser/ui-integration.test.js
```

---

### Task 3: VOD script tag recorded at insertion and removed on destroy

**Files:**

- Modify: `src/nimio-vod.js` (`_loadSourcePromise.then` line 49; `destroy()` line 137; `_clear()` lines 199–202; `_addScriptTag()` line 562)
- Create: `tests/nimio-vod-lifecycle.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi, afterEach } from "vitest";
import { NimioVod } from "@/nimio-vod";
import { EventBus } from "@/event-bus";
import { releaseInstances } from "@/shared/service";

let hlsCreated;

class FakeHls {
  constructor() {
    hlsCreated++;
    this.on = vi.fn();
    this.off = vi.fn();
    this.destroy = vi.fn();
  }
}
FakeHls.Events = {};

async function microtasks(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("NimioVod destroyed before hls.js has loaded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.Hls;
    for (const s of document.head.querySelectorAll("script")) s.remove();
  });

  it("local source: does not create Hls after destroy", async () => {
    globalThis.Hls = FakeHls;
    hlsCreated = 0;
    const name = "vod-early-local";
    const vod = new NimioVod(name, { hlsjs: { source: undefined } });

    vod.destroy();
    releaseInstances(name);
    await microtasks();

    expect(hlsCreated).toBe(0);
    expect(vod.isLoaded()).toBe(false);
  });

  it("pending remote script: removes the tag and detaches its handlers", async () => {
    globalThis.Hls = FakeHls;
    hlsCreated = 0;
    const name = "vod-early-pending";
    const vod = new NimioVod(name, {
      hlsjs: { source: "http://localhost/fake-hls.js" },
    });
    const script = document.head.querySelector("script[src$='fake-hls.js']");
    expect(script).not.toBeNull();
    const busBefore = EventBus.getInstance(name);

    vod.destroy();
    releaseInstances(name);

    expect(script.isConnected).toBe(false);
    expect(script.onload).toBeNull();
    expect(script.onerror).toBeNull();
    await microtasks();
    expect(hlsCreated).toBe(0);
    // nothing re-registered the name after release
    expect(EventBus.getInstance(name)).not.toBe(busBefore);
  });

  it("failed remote script: the tag is removed on destroy", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const name = "vod-early-failed";
    const vod = new NimioVod(name, {
      hlsjs: { source: "http://localhost/missing-hls.js" },
    });
    const script = document.head.querySelector("script[src$='missing-hls.js']");
    script.onerror();
    await microtasks();

    vod.destroy();

    expect(script.isConnected).toBe(false);
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio-vod-lifecycle.test.js`
Expected: the two remote-script tests FAIL — `script.isConnected` is `true` after destroy (the tag is only removed when it had loaded). The local-source test passes already (upstream's `_destroyed` guard).

- [ ] **Step 3: Implement**

`src/nimio-vod.js`:

In the `.then((script) => {` continuation remove the line `this._playerScript = script;`.

`destroy()`:

```js
  destroy() {
    // hls.js may still be loading, its promise must not init the player then
    this._destroyed = true;
    this._removePlayerScript();
    if (this._state === VOD_STATE.NULL) return;
```

In `_clear()` replace

```js
if (this._playerScript) {
  document.head.removeChild(this._playerScript);
  this._playerScript = undefined;
}
```

with `this._removePlayerScript();`, and add the method next to `_clear()`:

```js
  _removePlayerScript() {
    const script = this._playerScript;
    if (!script) return;

    script.onload = null;
    script.onerror = null;
    script.parentNode?.removeChild(script);
    this._playerScript = undefined;
  }
```

`_addScriptTag()` becomes an arrow-function promise that records the element before inserting it:

```js
  _addScriptTag(url) {
    return new Promise((resolve, reject) => {
      if (!url) {
        return resolve();
      }

      let script = document.createElement("script");
      script.type = "text/javascript";
      script.src = url;

      script.onload = () => resolve(script);
      script.onerror = () => reject(script);

      // kept from insertion so destroy() can drop a pending or failed load
      this._playerScript = script;
      document.head.appendChild(script);
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio-vod-lifecycle.test.js tests/nimio-mode-switch.test.js tests/nimio-vod.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio-vod.js tests/nimio-vod-lifecycle.test.js
git add src/nimio-vod.js tests/nimio-vod-lifecycle.test.js
```

---

### Task 4: Facade rollback, idempotent isolated destroy, safe public methods

**Files:**

- Modify: `src/nimio.js` (constructor lines 40–105, `destroy()` lines 107–127, public methods), `src/nimio-ext-api.js`, `src/nimio-events.js`, `src/nimio-volume.js`
- Create: `tests/nimio.test.js`

**Interfaces:**

- Consumes: `runCleanupSteps` (Task 1), `releaseInstances` / `allocateInstanceKey` (upstream).
- Produces: `Nimio.prototype._init(options)`, `_rollbackInit()`, `_destroyed`.

- [ ] **Step 1: Write the failing tests**

Create `tests/nimio.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fakes = vi.hoisted(() => ({
  uis: [],
  lives: [],
  vods: [],
  order: [],
  vodLoaded: false,
  vodInit: undefined,
  liveThrows: false,
}));

vi.mock("@/ui/ui", () => ({
  UI: class {
    constructor(instName) {
      this.instName = instName;
      this.mediaElement = {};
      this.destroy = vi.fn(() => fakes.order.push("ui"));
      fakes.uis.push(this);
    }
  },
}));

vi.mock("@/nimio-live", () => ({
  NimioLive: class {
    constructor(instName) {
      if (fakes.liveThrows) throw new Error("SecurityError: worker blocked");
      this.instName = instName;
      this.destroy = vi.fn(() => fakes.order.push("live"));
      fakes.lives.push(this);
    }
  },
}));

vi.mock("@/nimio-vod", () => ({
  NimioVod: class {
    constructor(instName) {
      this.instName = instName;
      this.destroy = vi.fn(() => fakes.order.push("vod"));
      this.isRunning = () => false;
      this.isPlaying = () => false;
      this.isLoaded = () => fakes.vodLoaded;
      this.initialize = vi.fn(() => fakes.vodInit);
      fakes.vods.push(this);
    }
  },
}));

import Nimio from "@/nimio";
import { EventBus } from "@/event-bus";
import { VUMeterService } from "@/vumeter/service";

const players = [];
const containers = [];

function createPlayer(extra = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const options = {
    streamUrl: "wss://example.com/live/stream",
    container,
    logLevel: "warn",
    ...extra,
  };
  const player = new Nimio(options);
  players.push(player);
  return { player, options };
}

describe("Nimio instance lifecycle", () => {
  beforeEach(() => {
    fakes.uis.length = 0;
    fakes.lives.length = 0;
    fakes.vods.length = 0;
    fakes.order.length = 0;
  });

  afterEach(() => {
    for (const p of players) {
      try {
        p.destroy();
      } catch {
        // a test may have made a step throw on purpose
      }
    }
    players.length = 0;
    for (const c of containers) c.remove();
    containers.length = 0;
  });

  it("destroy releases the services registered under the instance key", () => {
    const { player } = createPlayer({ instanceName: "fac-release" });
    const key = player._instName;
    const bus = EventBus.getInstance(key);

    player.destroy();

    expect(EventBus.getInstance(key)).not.toBe(bus); // a fresh one: released
    expect(fakes.uis[0].destroy).toHaveBeenCalledTimes(1);
    expect(fakes.lives[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroy drops all listeners, including application ones", () => {
    const { player } = createPlayer({ instanceName: "fac-listeners" });
    const bus = EventBus.getInstance(player._instName);
    player.on("nimio:play", () => {});
    expect(bus.listenerCount("nimio:play")).toBe(1);
    expect(bus.listenerCount("aux:playback-error")).toBe(1);

    player.destroy();

    expect(bus.listenerCount("nimio:play")).toBe(0);
    expect(bus.listenerCount("aux:playback-error")).toBe(0);
    expect(bus.listenerCount("ui:volume-change")).toBe(0);
  });

  it("destroy is idempotent", () => {
    const { player } = createPlayer({ instanceName: "fac-twice" });

    player.destroy();
    player.destroy();

    expect(fakes.lives[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the VOD engine before the live engine, after the UI", () => {
    const { player } = createPlayer({ instanceName: "fac-vod", vod: true });

    player.destroy();

    expect(fakes.order).toEqual(["ui", "vod", "live"]);
  });

  it("destroy clears the facade's references", () => {
    const { player } = createPlayer({ instanceName: "fac-refs" });

    player.destroy();

    for (const field of [
      "_ui",
      "_livePlayer",
      "_actPlayer",
      "_eventBus",
      "_context",
      "_vuMeterSvc",
      "_playProgressSvc",
      "_playProgressProxy",
      "_thumbnailSvc",
      "_audioVolumeCtrl",
    ]) {
      expect(player[field], field).toBeUndefined();
    }
  });

  it("a VOD initialization that settles after destroy does not touch released services", async () => {
    let settle;
    fakes.vodLoaded = true;
    fakes.vodInit = new Promise((resolve) => (settle = resolve));
    try {
      const { player } = createPlayer({
        instanceName: "fac-late-vod",
        vod: true,
      });
      const vod = fakes.vods[0];
      const context = player._context;
      const setState = vi.spyOn(context, "setState");

      expect(player.seekVod(0)).toBe(true);
      expect(vod.initialize).toHaveBeenCalledTimes(1);
      player.destroy();
      settle();
      await fakes.vodInit;
      await Promise.resolve();

      expect(setState).not.toHaveBeenCalled();
    } finally {
      fakes.vodLoaded = false;
      fakes.vodInit = undefined;
    }
  });

  it("a constructor failure before the UI exists leaves no services registered", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const name = "fac-throw";
    const busBefore = EventBus.getInstance(name); // what a leak would reuse

    expect(
      () =>
        new Nimio({
          streamUrl: "wss://example.com/live/stream",
          container: "#no-such-container",
          instanceName: name,
        }),
    ).toThrow();

    // the key the failed player used was released: its bus is gone
    expect(EventBus.getInstance(name)).toBe(busBefore); // untouched: key was name#2
    expect(fakes.uis).toHaveLength(0);
    error.mockRestore();
  });

  it("destroy releases the key even if the live engine's destroy throws, and rethrows", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { player } = createPlayer({ instanceName: "fac-throwing-engine" });
    const key = player._instName;
    const bus = EventBus.getInstance(key);
    fakes.lives[0].destroy.mockImplementation(() => {
      fakes.order.push("live");
      throw new Error("engine boom");
    });

    expect(() => player.destroy()).toThrow("engine boom");

    expect(fakes.uis[0].destroy).toHaveBeenCalledTimes(1);
    expect(EventBus.getInstance(key)).not.toBe(bus);
    expect(player._livePlayer).toBeUndefined();
    expect(() => player.destroy()).not.toThrow(); // idempotent afterwards
    error.mockRestore();
  });

  it("destroy still tears down the engines when the UI cleanup throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { player } = createPlayer({ instanceName: "fac-ui-throws" });
    const key = player._instName;
    const bus = EventBus.getInstance(key);
    fakes.uis[0].destroy.mockImplementation(() => {
      throw new DOMException("container already removed", "NotFoundError");
    });

    expect(() => player.destroy()).toThrow("container already removed");

    expect(fakes.lives[0].destroy).toHaveBeenCalledTimes(1);
    expect(EventBus.getInstance(key)).not.toBe(bus);
    error.mockRestore();
  });

  it("a constructor failure after the UI was created destroys that UI and clears the VU meter", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const proto = Object.getPrototypeOf(
      VUMeterService.getInstance("fac-vu-probe"),
    );
    const clear = vi.spyOn(proto, "clear");
    fakes.liveThrows = true;
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      containers.push(container);
      expect(
        () =>
          new Nimio({
            streamUrl: "wss://example.com/live/stream",
            container,
            instanceName: "fac-ctor-ui",
          }),
      ).toThrow("SecurityError");

      expect(fakes.uis).toHaveLength(1);
      expect(fakes.uis[0].destroy).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      clear.mockRestore();
      fakes.liveThrows = false;
      error.mockRestore();
    }
  });

  it("event and volume methods are safe no-ops after destroy", () => {
    const { player } = createPlayer({ instanceName: "fac-after-destroy" });
    const fn = () => {};
    player.on("nimio:play", fn);
    player.destroy();

    expect(() => player.off("nimio:play", fn)).not.toThrow();
    expect(() => player.on("nimio:play", fn)).not.toThrow();
    expect(() => player.once("nimio:play", fn)).not.toThrow();
    expect(() => player.removeAllListeners()).not.toThrow();
    expect(player.listeners("nimio:play")).toEqual([]);
    expect(player.listenerCount("nimio:play")).toBe(0);
    expect(player.getVolume()).toBeUndefined();
    expect(() => player.mute()).not.toThrow();
    expect(() => player.unmute()).not.toThrow();
    expect(() => player.setVolume(50)).not.toThrow();
  });

  it("public methods are safe no-ops with neutral values after destroy", () => {
    fakes.vodLoaded = true;
    try {
      const { player } = createPlayer({
        instanceName: "fac-api-after-destroy",
        vod: true,
      });
      player.destroy();

      for (const call of [
        () => player.play(),
        () => player.stop(),
        () => player.pause(),
        () => player.setParameters({ latency: 1000 }),
        () => player.setStreamURL("wss://example.com/live/other"),
        () => player.startAbr(),
        () => player.stopAbr(),
        () => player.setCaptionTrack("CC1"),
      ]) {
        expect(call).not.toThrow();
      }
      expect(player.seekLive(0)).toBe(false);
      expect(player.seekVod(0)).toBe(false);
      expect(fakes.vods[0].initialize).not.toHaveBeenCalled();
      expect(player.isAbr()).toBe(false);
      expect(player.getRenditions("video")).toEqual([]);
      expect(player.getCurrentRendition("video")).toBeNull();
      expect(player.setVideoRendition(1)).toBe(false);
      expect(player.setAudioRendition(1)).toBe(false);
      expect(player.getCaptionTracks()).toEqual({});
      expect(player.getCurrentCaptionTrack()).toEqual({});
      expect(player.getCurrentStreamBandwidth()).toBe(0);
      expect(player.getCurrentTimestamp()).toBe(0);
      expect(player.getStreamEncodedFramerate()).toBeUndefined();
      expect(player.getVodThumbnailUrl(0)).toBeUndefined();
      expect(player.getVodPlayerHandler()).toBeNull();
      expect(typeof player.version()).toBe("string");
    } finally {
      fakes.vodLoaded = false;
    }
  });
});
```

Note on "a constructor failure before the UI exists": with upstream's `allocateInstanceKey()`, a second allocation of the same name yields `name#2`, so the failed player never touched the pre-existing `name` bus; the assertion that it is unchanged plus `fakes.uis` empty pins that rollback ran before any component existed and nothing threw inside it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/nimio.test.js`
Expected: FAIL — idempotent test calls live destroy twice? (no: today's guard is `_ui`, which is cleared, so this passes already); the throwing-engine test does not rethrow after releasing (today it throws before `releaseInstances`, so the bus is reused and `_livePlayer` stays set); the UI-throws test never destroys the engines; the constructor-failure-after-UI test leaves `fakes.uis[0].destroy` uncalled; neutral-values test throws on `player.play()` (`_actPlayer` undefined → TypeError) and others; events test throws on `listeners()`; references test finds `_eventBus` defined; the late-VOD test calls `setState`. Read the output and confirm each failing test fails for one of these reasons.

- [ ] **Step 3: Implement**

`src/nimio.js`:

Import: `import { runCleanupSteps } from "./shared/helpers";`

Constructor:

```js
  constructor(options) {
    if (options && !options.instanceName) {
      options.instanceName = "nimio_" + (Math.floor(Math.random() * 10000) + 1);
    }
    // Registry key of the per-instance services, unique per player
    this._instName = allocateInstanceKey(options.instanceName);
    try {
      this._init(options);
    } catch (err) {
      // a failed construction must leave neither DOM, engines nor the key
      this._rollbackInit();
      throw err;
    }
  }

  _init(options) {
    ScriptPathProvider.getInstance(this._instName).setScriptPath(scriptPath);
    // ... today's constructor body from here on, unchanged ...
  }

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

`destroy()`:

```js
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // every component is torn down independently: one failure must not
    // leave the others running, and the key is always released
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
          this._eventBus.off(
            "nimio:connection-established",
            this._onLiveConnected,
          );
          this._eventBus.off("aux:playback-error", this._onError);
        },
      ],
    ]);
    // Last, as live and VOD players share services (e.g. AudioContext); the
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

Public methods in `src/nimio.js`:

```js
  setParameters(params) {
    this._livePlayer?.setParameters(params);
  }

  play() {
    this._actPlayer?.play();
  }

  setStreamURL(url) {
    if (this._destroyed) return;
    // ... unchanged
  }

  pause() {
    this._actPlayer?.pause();
  }

  stop() {
    if (this._destroyed) return;
    // ... unchanged
  }

  seekVod(position) {
    if (this._destroyed) return false;
    // ... unchanged
  }

  seekLive(buffer) {
    if (!this._playProgressProxy) return false;
    // ... unchanged
  }
```

and in `_runVodFromStart()`'s `.then(() => {` add `if (this._destroyed) return;` as the first line.

`src/nimio-ext-api.js`:

```js
// Every method is a safe no-op on a destroyed player (no active engine).
export const NimioExtAPI = {
  startAbr() {
    this._actPlayer?.startAbr();
  },

  stopAbr() {
    this._actPlayer?.stopAbr();
  },

  isAbr() {
    return this._actPlayer ? this._actPlayer.isAbr() : false;
  },

  getRenditions(type) {
    return this._actPlayer ? this._actPlayer.getRenditions(type) : [];
  },

  getCurrentRendition(type) {
    return this._actPlayer ? this._actPlayer.getCurrentRendition(type) : null;
  },

  setVideoRendition(id) {
    return this.setCurrentRendition("video", id);
  },

  setAudioRendition(id) {
    return this.setCurrentRendition("audio", id);
  },

  setCurrentRendition(type, id) {
    if (!this._context || !this._actPlayer) return false;
    if (!this._checkRenditionType(type)) return false;

    return this._actPlayer.setCurrentRendition(type, id);
  },

  getCaptionTracks() {
    return this._actPlayer ? this._actPlayer.getCaptionTracks() : {};
  },

  getCurrentCaptionTrack() {
    return this._actPlayer ? this._actPlayer.getCurrentCaptionTrack() : {};
  },

  setCaptionTrack(name) {
    return this._actPlayer ? this._actPlayer.setCaptionTrack(name) : false;
  },

  getCurrentStreamBandwidth() {
    return this._actPlayer ? this._actPlayer.getCurrentStreamBandwidth() : 0;
  },

  getStreamEncodedFramerate() {
    return this._spsHolder?.sps?.maxFps;
  },

  getVodThumbnailUrl(time) {
    if (this._thumbnailSvc && this._thumbnailSvc.isSetUp()) {
      return this._thumbnailSvc.getUrl(time);
    }
  },

  getCurrentTimestamp() {
    return this._actPlayer ? this._actPlayer.getCurrentTimestamp() : 0;
  },
};
```

`src/nimio-events.js`: first line of each method `if (!this._eventBus) return;` (`listeners` → `return [];`, `listenerCount` → `return 0;`), with a file comment "All methods are safe no-ops once the player is destroyed (no event bus)."

`src/nimio-volume.js`: `setVolume`, `getVolume`, `mute`, `unmute` use `this._audioVolumeCtrl?.x(...)`; the two private handlers are unchanged (their bus subscriptions are removed in destroy).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/nimio.test.js tests/nimio-mode-switch.test.js tests/nimio-vod.test.js`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
npx prettier --write src/nimio.js src/nimio-ext-api.js src/nimio-events.js src/nimio-volume.js tests/nimio.test.js
git add src/nimio.js src/nimio-ext-api.js src/nimio-events.js src/nimio-volume.js tests/nimio.test.js
```

---

### Task 5: Full verification and the single commit

- [ ] **Step 1: Full suite and formatting**

Run: `npx prettier --check src tests && npx vitest run`
Expected: prettier clean; all files pass (PR 2b's 33 plus `tests/helpers.test.js`, `tests/nimio-vod-lifecycle.test.js`, `tests/nimio.test.js`). Run `npm run test:browser` if available.

- [ ] **Step 2: Confirm the staged set**

Expected staged: `src/shared/helpers.js`, `src/ui/ui.js`, `src/nimio-vod.js`, `src/nimio.js`, `src/nimio-ext-api.js`, `src/nimio-events.js`, `src/nimio-volume.js`, `tests/helpers.test.js`, `tests/browser/ui-integration.test.js`, `tests/nimio-vod-lifecycle.test.js`, `tests/nimio.test.js`. Nothing under `docs/`.

- [ ] **Step 3: Commit (the one code commit of this PR)**

```bash
git commit -F - <<'MSG'
Make player destruction idempotent and failure-safe

Nimio.destroy() ran its steps in sequence behind an `if (!this._ui)` guard:
a throwing step (an application listener invoked from the live stop, a host
that already removed the container) skipped every later step and the
service release, and a second destroy() repeated the failing path. A
constructor failing after the UI was created left DOM, engines and
registered services behind. Public methods threw after destroy.

- runCleanupSteps() (shared/helpers): runs teardown steps in isolation,
  logs failures and returns the errors.
- Nimio: the constructor body moves into _init(); a failure rolls back the
  VOD engine, live engine, VU meter and UI, releases the instance key and
  rethrows. destroy() is idempotent, runs every step in isolation (mode
  switch, UI, volume handlers, VU meter, VOD engine, live engine, own
  listeners), always releases the key (which also drops application
  listeners through the event bus release), clears its references and then
  rethrows the first error.
- Every public method is a safe no-op on a destroyed player; queries return
  neutral values (false, [], {}, 0, null).
- UI: the constructor body moves into _construct(); a failure removes the
  container, disconnects the observer, deinitialises captions and removes
  the listeners that were added. destroy() disconnects the observer, removes
  the stored caption-list handler and tolerates a container the host already
  removed.
- NimioVod records the hls.js script element at insertion and removes it on
  destroy whether pending, failed or loaded, with its handlers detached.

Tests: runCleanupSteps; facade lifecycle with mocked UI and engines (release,
listeners, idempotence, order, references, late VOD init, constructor
failures before and after the UI, throwing UI and engine steps, neutral
values after destroy); VOD script tag pending/failed/local; UI browser
cases (removed container, caption handler, constructor failures early and
after captions).
MSG
```

- [ ] **Step 4: PR hand-off**

PR title: "Make player destruction idempotent and failure-safe". Depends on PR 2b, 2a and 1. PR 3b (live engine after destroy) remains.

---

### Task 6 (branch review, done)

- [x] `releaseInstances()` runs as the last isolated step of both
      `destroy()` and `_rollbackInit()`; a throwing service release still
      clears the references and is rethrown (test added).
- [x] `_onPlaybackPositionChange` returns `false` after destroy (test added).
- [x] UI rollback releases the seek bar; a destroyed UI tolerates the live
      engine's late `clear()` / `hideControls()` (browser test added).
- [x] Duplicate `_removePlayerScript()` call at the end of `NimioVod.destroy()`
      removed (there is no `_clear()`; the plan's Task 3 wording was wrong).

### Task 7 (maintainer-side review, done)

- [x] `NimioLive.destroy()` runs its stages through `runCleanupSteps()` and
      rethrows after releasing everything (test: throwing `stop()` still
      terminates the transport).
- [x] `Nimio.destroy()` drops `_actPlayer` first; `setParameters()`,
      `_switchMode()` and the `aux:playback-error` handler return early when
      destroyed (test: `play()` / `setParameters()` from a
      `nimio:playback-end` listener touch no engine).
- [x] `releaseInstances()` finishes the loop and rethrows the first error
      (test in `tests/service.test.js`).
- [x] `_toggleDocumentPip()` closes a window granted after `_cleanupPip()`
      and installs nothing (new `tests/ui-pip-lifecycle.test.js`).

### Task 8 (maintainer-side review, done)

- [x] `NimioLive.destroy()` gains an isolated `_releaseMediaResources()`
      stage after `stop()` (flows, audio, grabber, overlay), tested with a
      `stop()` that throws before the flows are reached.
- [x] Volume methods return early on `_destroyed`; the teardown-listener test
      also calls `setVolume()` / `mute()`.

### Task 9 (final inspection, done)

- [x] `_releaseMediaResources()` also cancels the pause timer, stops the
      playback state and hard-stops ABR (test extended); the stray `?.` on
      `_decoderFlows` dropped.
- [x] Commit message's Tests paragraph lists the round 2/3 tests; spec §3
      wording fixed; native PiP asymmetry recorded in the spec's non-goals.

### Task 10 (maintainer-side review, done)

- [x] `VUMeterUI.destroy()` invalidates the animation loop before the
      fallible DOM removal and tolerates missing children (new
      `tests/vumeter-ui.test.js`).

## Self-review

- **Spec coverage:** §1 → Task 1; §2, §3, §4 → Task 4; §5 → Task 2; §6 → Task 3; Error handling → Tasks 2 and 4 (rollback never throws: isolated steps; destroy rethrows after release); Testing → Tasks 1–4; Delivery → Task 5.
- **Placeholder scan:** none; "unchanged" only elides code that stays byte-identical and is named.
- **Type consistency:** `runCleanupSteps(logger, prefix, steps)` identical in Task 1 and its callers; `_rollbackInit()` / `_rollbackConstruction()` named identically in code and spec; neutral values in Task 4 code match its test.
- **Review Focus:** each line has its test in the named task.
