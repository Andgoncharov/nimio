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
import { hasInstances } from "@/shared/service";

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
    for (const p of players) p.destroy();
    players.length = 0;
    for (const c of containers) c.remove();
    containers.length = 0;
  });

  it("destroy releases every service registered under the instance name", () => {
    const { player } = createPlayer({ instanceName: "fac-release" });
    expect(hasInstances("fac-release")).toBe(true);

    player.destroy();

    expect(hasInstances("fac-release")).toBe(false);
    expect(fakes.uis[0].destroy).toHaveBeenCalledTimes(1);
    expect(fakes.lives[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroy drops all listeners, including application ones", () => {
    const { player } = createPlayer({ instanceName: "fac-listeners" });
    const bus = EventBus.getInstance("fac-listeners");
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

  it("a player recreated with the same name after destroy gets a fresh bus", () => {
    const { player } = createPlayer({ instanceName: "fac-reuse" });
    const bus1 = EventBus.getInstance("fac-reuse");
    player.destroy();

    const { options } = createPlayer({ instanceName: "fac-reuse" });

    expect(options.instanceName).toBe("fac-reuse");
    expect(EventBus.getInstance("fac-reuse")).not.toBe(bus1);
  });

  it("a live name collision warns and creates the player under a free suffixed name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPlayer({ instanceName: "fac-dup" });

    const second = createPlayer({ instanceName: "fac-dup" });
    const third = createPlayer({ instanceName: "fac-dup" });

    expect(second.options.instanceName).toBe("fac-dup_2");
    expect(third.options.instanceName).toBe("fac-dup_3");
    expect(fakes.lives.map((l) => l.instName)).toEqual([
      "fac-dup",
      "fac-dup_2",
      "fac-dup_3",
    ]);
    expect(hasInstances("fac-dup_2")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0].join(" ")).toContain("fac-dup_2");
    warn.mockRestore();
  });

  it("unnamed players get distinct generated names", () => {
    const a = createPlayer();
    const b = createPlayer();

    expect(a.options.instanceName).toMatch(/^nimio_\d+$/);
    expect(b.options.instanceName).toMatch(/^nimio_\d+$/);
    expect(a.options.instanceName).not.toBe(b.options.instanceName);
  });

  it("generated names skip a name taken explicitly, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createPlayer();
    const n = Number(a.options.instanceName.slice("nimio_".length));
    createPlayer({ instanceName: `nimio_${n + 1}` });

    const b = createPlayer();

    expect(b.options.instanceName).toBe(`nimio_${n + 2}`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("destroy clears the facade's service references", () => {
    const { player } = createPlayer({ instanceName: "fac-refs" });

    player.destroy();

    for (const field of [
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
    fakes.vodLoaded = false;
    fakes.vodInit = undefined;
  });

  it("a constructor failure leaves no services registered under the name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      () =>
        new Nimio({
          streamUrl: "wss://example.com/live/stream",
          container: "#no-such-container",
          instanceName: "fac-throw",
        }),
    ).toThrow();
    expect(hasInstances("fac-throw")).toBe(false);

    const { options } = createPlayer({ instanceName: "fac-throw" });
    expect(options.instanceName).toBe("fac-throw");
    error.mockRestore();
  });

  it("destroy releases the name even if an engine's destroy throws", () => {
    const { player } = createPlayer({ instanceName: "fac-throwing-engine" });
    fakes.lives[0].destroy.mockImplementation(() => {
      throw new Error("engine boom");
    });

    expect(() => player.destroy()).toThrow("engine boom");

    expect(hasInstances("fac-throwing-engine")).toBe(false);
  });

  it("destroy still tears down the engines when the UI cleanup throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { player } = createPlayer({ instanceName: "fac-ui-throws" });
    fakes.uis[0].destroy.mockImplementation(() => {
      throw new DOMException("container already removed", "NotFoundError");
    });

    expect(() => player.destroy()).toThrow("container already removed");

    expect(fakes.lives[0].destroy).toHaveBeenCalledTimes(1);
    expect(hasInstances("fac-ui-throws")).toBe(false);
    error.mockRestore();
  });

  it("a constructor failure after the UI was created destroys that UI", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
      expect(hasInstances("fac-ctor-ui")).toBe(false);
    } finally {
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
    expect(() => player.removeAllListeners()).not.toThrow();
    expect(player.listeners("nimio:play")).toEqual([]);
    expect(player.listenerCount("nimio:play")).toBe(0);
    expect(player.getVolume()).toBeUndefined();
    expect(() => player.mute()).not.toThrow();
    expect(() => player.setVolume(50)).not.toThrow();
  });

  it("a constructor failure clears the VU meter created before it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // spy on the class prototype: fetching the instance first would
    // register the name and make the player resolve a suffixed one
    const proto = Object.getPrototypeOf(
      VUMeterService.getInstance("fac-ctor-vu-probe"),
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
            instanceName: "fac-ctor-vu",
          }),
      ).toThrow("SecurityError");

      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      clear.mockRestore();
      fakes.liveThrows = false;
      error.mockRestore();
    }
  });

  it("public methods are safe no-ops with neutral values after destroy", () => {
    const { player } = createPlayer({ instanceName: "fac-api-after-destroy" });
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
    expect(player.isAbr()).toBe(false);
    expect(player.getRenditions("video")).toEqual([]);
    expect(player.getCurrentRendition("video")).toBeNull();
    expect(player.setVideoRendition("720p")).toBe(false);
    expect(player.setAudioRendition("aac")).toBe(false);
    expect(player.getCaptionTracks()).toEqual({});
    expect(player.getCurrentCaptionTrack()).toEqual({});
    expect(player.getCurrentStreamBandwidth()).toBe(0);
    expect(player.getCurrentTimestamp()).toBe(0);
    expect(player.getStreamEncodedFramerate()).toBeUndefined();
    expect(player.getVodThumbnailUrl(0)).toBeUndefined();
    expect(player.getVodPlayerHandler()).toBeNull();
    expect(typeof player.version()).toBe("string");
  });
});
