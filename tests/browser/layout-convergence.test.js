import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MODE } from "@/shared/values";
import { UILayoutManager } from "@/ui/layout-manager";
import { containerHeightIndependent } from "@/ui/height-probe";

// Regression tests for the VOD flicker (#86): drive the production
// UILayoutManager and height probe through a real ResizeObserver in a
// real layout engine and assert the loop converges to a fixed point
// instead of oscillating. Only the thin style-application glue from
// UI._resizeAndRedraw / _updateLayout is replicated here (building the
// full UI needs workers and codecs); the decision logic under test is
// all production code.

const FRAME = { width: 1280, height: 720 };
const AR = FRAME.width / FRAME.height;

function buildPlayer({ parentCss, width, height, probeFn, parentVars }) {
  const parent = document.createElement("div");
  parent.style.cssText = parentCss;
  for (const [name, value] of Object.entries(parentVars ?? {})) {
    parent.style.setProperty(name, value);
  }
  document.body.appendChild(parent);

  // Mirrors the container setup in the UI constructor.
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "block",
    position: "relative",
    backgroundColor: "#000",
    alignContent: "center",
  });
  parent.appendChild(container);

  // Mirrors ui.css `.nimio-container > canvas` and _applyBasicStyle.
  const canvas = document.createElement("canvas");
  canvas.width = FRAME.width;
  canvas.height = FRAME.height;
  Object.assign(canvas.style, {
    display: "block",
    width: "100%",
    height: "100%",
    margin: "auto",
    position: "relative",
  });
  container.appendChild(canvas);

  const layoutMgr = new UILayoutManager(width, height);
  layoutMgr.setFrameSize(FRAME.width, FRAME.height);
  Object.assign(container.style, layoutMgr.containerLayout(false));

  const probe = probeFn ?? containerHeightIndependent;
  const stats = { events: 0, applies: 0 };

  // Mirrors _resizeAndRedraw.
  function applyLayout(rect) {
    let heightIndependent = false;
    if (layoutMgr.heightNeedsProbe()) {
      heightIndependent = probe(container, canvas);
    }
    const cssProps = layoutMgr.fullLayout(
      rect.width,
      rect.height,
      MODE.VOD,
      false,
      false,
      heightIndependent,
    );
    if (cssProps) {
      container.style.width = cssProps.container.width;
      container.style.height = cssProps.container.height;
      canvas.style.width = cssProps.output.width;
      canvas.style.height = cssProps.output.height;
      canvas.style["object-fit"] = cssProps.output["object-fit"];
      canvas.style["aspect-ratio"] = cssProps.output["aspect-ratio"];
    }
    stats.applies++;
  }

  // Mirrors _createResizeObserver / _updateLayout (rAF-deferred with a
  // pending guard).
  let pending = false;
  const observer = new ResizeObserver((entries) => {
    stats.events++;
    const rect = entries[0].contentRect;
    requestAnimationFrame(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        applyLayout(rect);
      });
    });
  });
  observer.observe(container);

  // Mirrors the initial layout pass from _handleLayoutUpdate.
  applyLayout(container.getBoundingClientRect());

  return {
    parent,
    container,
    canvas,
    stats,
    destroy() {
      observer.disconnect();
      parent.remove();
    },
  };
}

// Resolves true once no resize events arrive for quietMs; false if the
// loop is still producing events when maxMs runs out (oscillation).
async function settles(stats, { quietMs = 300, maxMs = 3000 } = {}) {
  const start = performance.now();
  let seen = stats.events;
  let lastChange = performance.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = performance.now();
    if (stats.events !== seen) {
      seen = stats.events;
      lastChange = now;
    } else if (now - lastChange >= quietMs) {
      return true;
    }
    if (now - start >= maxMs) return false;
  }
}

describe("VOD layout convergence", () => {
  let player;

  beforeEach(() => {
    player = undefined;
  });

  afterEach(() => {
    player?.destroy();
  });

  it("converges with an auto height (the original flicker)", async () => {
    player = buildPlayer({
      parentCss: "display:block;width:800px",
      width: "100%",
      height: "auto",
    });

    expect(await settles(player.stats)).toBe(true);
    expect(player.stats.applies).toBeLessThanOrEqual(8);
    expect(player.canvas.style.width).toBe("100%");
    expect(player.canvas.style.height).toBe("auto");
    expect(player.container.offsetHeight).toBeCloseTo(800 / AR, 0);
  });

  it("converges with a percentage height in a heightless parent", async () => {
    player = buildPlayer({
      parentCss: "display:block;width:800px",
      width: "100%",
      height: "100%",
    });

    expect(await settles(player.stats)).toBe(true);
    expect(player.stats.applies).toBeLessThanOrEqual(8);
    expect(player.canvas.style.width).toBe("100%");
    expect(player.canvas.style.height).toBe("auto");
  });

  it("converges with a fit-content height", async () => {
    player = buildPlayer({
      parentCss: "display:block;width:800px",
      width: "100%",
      height: "fit-content",
    });

    expect(await settles(player.stats)).toBe(true);
    expect(player.stats.applies).toBeLessThanOrEqual(8);
    expect(player.canvas.style.height).toBe("auto");
  });

  it("letterboxes a resolvable percentage height and stays stable", async () => {
    player = buildPlayer({
      parentCss: "display:block;width:800px;height:300px",
      width: "100%",
      height: "100%",
    });

    expect(await settles(player.stats)).toBe(true);
    expect(player.stats.applies).toBeLessThanOrEqual(8);
    // The rect-based fit must survive: height-constrained, aspect width.
    expect(player.canvas.style.height).toBe("100%");
    expect(player.canvas.style.width).toBe("auto");
    expect(player.container.offsetHeight).toBe(300);
    expect(player.canvas.offsetWidth).toBeCloseTo(300 * AR, 0);
  });

  it("converges with an auto-valued var() height in a fixed-height parent", async () => {
    // Regression for the var() finding: the parent is definite, but the
    // variable resolves to auto, so the container is content-sized and
    // the rect fit would oscillate.
    player = buildPlayer({
      parentCss: "display:block;width:800px;height:300px",
      parentVars: { "--player-height": "auto" },
      width: "100%",
      height: "var(--player-height)",
    });

    expect(await settles(player.stats)).toBe(true);
    expect(player.stats.applies).toBeLessThanOrEqual(8);
    expect(player.canvas.style.width).toBe("100%");
    expect(player.canvas.style.height).toBe("auto");
  });

  it("self-check: a wrong independent verdict makes the harness detect oscillation", async () => {
    // Simulates the pre-fix behavior (rect fit despite an unresolvable
    // percentage) and proves this harness can catch it: if the guard
    // regresses, the convergence tests above fail the same way.
    player = buildPlayer({
      parentCss: "display:block;width:800px",
      width: "100%",
      height: "100%",
      probeFn: () => true,
    });

    const settled = await settles(player.stats, { maxMs: 1500 });

    expect(settled).toBe(false);
    expect(player.stats.events).toBeGreaterThan(10);
  });
});
