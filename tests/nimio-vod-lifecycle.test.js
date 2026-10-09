import { describe, it, expect, vi, afterEach } from "vitest";
import { NimioVod } from "@/nimio-vod";
import { hasInstances, releaseInstances } from "@/shared/service";

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

  it("local source: does not create Hls or re-register services", async () => {
    globalThis.Hls = FakeHls;
    hlsCreated = 0;
    const name = "vod-early-local";
    const vod = new NimioVod(name, { hlsjs: { source: undefined } });

    vod.destroy();
    releaseInstances(name);
    await microtasks();

    expect(hlsCreated).toBe(0);
    expect(hasInstances(name)).toBe(false);
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

    vod.destroy();
    releaseInstances(name);

    expect(script.isConnected).toBe(false);
    expect(script.onload).toBeNull();
    expect(script.onerror).toBeNull();
    await microtasks();
    expect(hlsCreated).toBe(0);
    expect(hasInstances(name)).toBe(false);
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
    expect(error).toHaveBeenCalled();

    vod.destroy();

    expect(script.isConnected).toBe(false);
    error.mockRestore();
  });
});
