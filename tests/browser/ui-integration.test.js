import { describe, it, expect, afterEach } from "vitest";
import { UI } from "@/ui/ui";
import { MODE } from "@/shared/values";

// Integration tests for the production probe wiring in
// UI._resizeAndRedraw - unlike the convergence harness these construct
// the real UI class, so the deferred-retry path is exercised together
// with destroy() and replaceMediaElement().

const stubBus = { on() {}, off() {}, emit() {} };

function waitFrames(n = 2) {
  return new Promise((resolve) => {
    const step = (left) =>
      left ? requestAnimationFrame(() => step(left - 1)) : resolve();
    step(n);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(fn, timeout = 3000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (fn()) return true;
    await wait(50);
  }
  return !!fn();
}

describe("UI probe integration", () => {
  let parent;
  let ui;

  afterEach(() => {
    try {
      ui?.destroy();
    } catch {
      // already destroyed by the test
    }
    ui = undefined;
    parent?.remove();
    parent = undefined;
  });

  async function buildVodPlayer() {
    parent = document.createElement("div");
    parent.style.cssText = "display:block;width:800px";
    document.body.appendChild(parent);
    ui = new UI(
      "probe-it",
      parent,
      { width: "100%", height: "100%", vod: {}, ar: "16:9" },
      stubBus,
    );
    ui._mode = MODE.VOD;
    ui._mediaElement.style.display = "block";
    await waitFrames(3); // initial ResizeObserver delivery + rAF chain
    return ui;
  }

  async function deferProbeWithFade() {
    const media = ui._mediaElement;
    media.style.transition = "opacity 0.25s linear";
    void media.offsetHeight;
    media.style.opacity = "0.5";
    await waitFrames(2);
    expect(media.getAnimations().length).toBeGreaterThan(0);
    // A resize while the fade runs defers the probe and arms the retry.
    parent.style.height = "300px";
    await until(() => ui._probeRetryPending === true);
    expect(ui._probeRetryPending).toBe(true);
  }

  it("applies the probed layout through the real resize path", async () => {
    await buildVodPlayer();

    await until(() => ui._mediaElement.style.height === "auto");
    // Heightless parent: content-sized verdict, width-constrained.
    expect(ui._mediaElement.style.width).toBe("100%");
    expect(ui._mediaElement.style.height).toBe("auto");
  });

  it("recovers the verdict after a deferred retry (production wiring)", async () => {
    await buildVodPlayer();
    await deferProbeWithFade();

    // Once the fade settles, the retry re-measures: the parent is now
    // definite, so the rect fit (height-constrained) must come back.
    const recovered = await until(
      () => ui._mediaElement.style.height === "100%",
    );
    expect(recovered).toBe(true);
    expect(ui._probeRetryPending).toBe(false);
  });

  it("survives destroy() while a deferred retry is pending", async () => {
    await buildVodPlayer();
    await deferProbeWithFade();

    ui.destroy();

    // The retry fires after the fade ends; the isConnected guard must
    // swallow it without touching the destroyed player (an unhandled
    // error here fails the test).
    await wait(500);
    expect(ui._container.isConnected).toBe(false);
  });

  it("survives replaceMediaElement() while a deferred retry is pending", async () => {
    await buildVodPlayer();
    await deferProbeWithFade();
    const oldMedia = ui._mediaElement;

    await ui.replaceMediaElement();
    expect(ui._mediaElement).not.toBe(oldMedia);

    // The settle hook watches the OLD element's transitions; when they
    // finish, the retry re-derives the current output and applies the
    // definite-parent verdict to the replacement.
    const recovered = await until(
      () => ui._mediaElement.style.height === "100%",
    );
    expect(recovered).toBe(true);
  });
});
