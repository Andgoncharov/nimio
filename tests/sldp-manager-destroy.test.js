import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SLDPManager } from "@/sldp/manager";

function createManager(name) {
  const mgr = new SLDPManager(name);
  const transport = {
    callbacks: {},
    setCallback: vi.fn((type, cb) => (transport.callbacks[type] = cb)),
    send: vi.fn(),
    runCallback: vi.fn(),
    connected: true,
  };
  mgr.init(transport, {});
  mgr._context = {
    setSourceUrl: vi.fn(),
    streams: [
      {
        stream: "s1",
        stream_info: { vcodec: "avc1", width: 1, height: 1, vtimescale: 90000 },
      },
    ],
  };
  // a status reply only counts for a run that was started
  mgr.start("wss://example.com/live");
  return { mgr, transport };
}

describe("SLDPManager stop and destroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stop cancels queued stream setup callbacks", () => {
    const { mgr, transport } = createManager("sldp-stop");
    mgr.requestStream("video", 0);

    mgr.stop();
    vi.runAllTimers();

    expect(transport.runCallback).not.toHaveBeenCalled();
  });

  it("a status processed across a stop does not request playback", async () => {
    const { mgr, transport } = createManager("sldp-status-stop");
    let settle;
    mgr._processStatus = () => new Promise((resolve) => (settle = resolve));

    const pending = transport.callbacks.status({ info: {} });
    mgr.stop();
    settle();
    await pending;

    const commands = transport.send.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("play");
  });

  it("cancels queued stream setup callbacks", () => {
    const mgr = new SLDPManager("sldp-destroy");
    const transport = {
      setCallback: vi.fn(),
      send: vi.fn(),
      runCallback: vi.fn(),
      connected: true,
    };
    mgr.init(transport, {});
    mgr._context = {
      streams: [
        {
          stream: "s1",
          stream_info: {
            vcodec: "avc1",
            width: 1,
            height: 1,
            vtimescale: 90000,
          },
        },
      ],
    };
    mgr.requestStream("video", 0);

    mgr.destroy();
    vi.runAllTimers();

    expect(transport.runCallback).not.toHaveBeenCalled();
  });

  it("a stop during the codec check applies no streams and emits no connection", async () => {
    const { mgr } = createManager("sldp-codec-stop");
    let settle;
    mgr._context.setStreams = () =>
      new Promise((resolve) => (settle = resolve));
    mgr._context.getStreamsConfig = () => [];
    mgr._processCurrentStreams = vi.fn();
    mgr._eventBus = { emit: vi.fn() };

    const pending = mgr._transport.callbacks.status({ info: [] });
    mgr.stop();
    settle();
    await pending;

    expect(mgr._processCurrentStreams).not.toHaveBeenCalled();
    expect(mgr._eventBus.emit).not.toHaveBeenCalledWith(
      "nimio:connection-established",
      expect.anything(),
    );
  });

  it("a stop from a connection-established listener prevents the play request", async () => {
    const { mgr, transport } = createManager("sldp-listener-stop");
    mgr._context.setStreams = () => Promise.resolve(true);
    mgr._context.getStreamsConfig = () => [];
    mgr._processCurrentStreams = vi.fn();
    mgr._eventBus = {
      emit: vi.fn((event) => {
        if (event === "nimio:connection-established") mgr.stop();
      }),
    };

    await mgr._transport.callbacks.status({ info: [] });

    const commands = transport.send.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("play");
  });

  it("a cancelled status settling first does not clear the restarted status's play request", async () => {
    const { mgr, transport } = createManager("sldp-settle-order");
    const settlers = [];
    mgr._context.setStreams = () =>
      new Promise((resolve) => settlers.push(() => resolve(true)));
    mgr._context.getStreamsConfig = () => [];
    mgr._processCurrentStreams = vi.fn(() => {
      mgr._curStreams = [{ sn: 1, stream: "s1" }];
    });
    mgr._eventBus = { emit: vi.fn() };

    const old = mgr._transport.callbacks.status({ info: [] });
    mgr.stop(); // stop and restart while the old codec check is pending
    mgr.start("wss://example.com/live");
    const fresh = mgr._transport.callbacks.status({ info: [] });
    settlers[0]();
    settlers[1](); // both settle in the same turn, old first
    await Promise.all([old, fresh]);

    const plays = transport.send.mock.calls.filter((c) => c[0] === "play");
    expect(plays).toHaveLength(1);
    expect(plays[0][1].streams).toEqual([{ sn: 1, stream: "s1" }]);
  });

  it("a status arriving after a stop that preceded it requests nothing", async () => {
    const { mgr, transport } = createManager("sldp-stop-before-status");
    mgr._context.setSourceUrl = vi.fn();
    mgr._context.setStreams = () => Promise.resolve(true);
    mgr._context.getStreamsConfig = () => [];
    mgr._processCurrentStreams = vi.fn();
    mgr._eventBus = { emit: vi.fn() };

    mgr.start("wss://example.com/live");
    mgr.stop({ closeConnection: false }); // e.g. detach to VOD before the status reply
    await mgr._transport.callbacks.status({ info: [] });

    expect(mgr._processCurrentStreams).not.toHaveBeenCalled();
    const commands = transport.send.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("play");
  });

  it("a status arriving after destroy requests nothing", async () => {
    const { mgr, transport } = createManager("sldp-destroy-before-status");
    mgr._context.setSourceUrl = vi.fn();
    mgr._context.setStreams = () => Promise.resolve(true);
    mgr._context.getStreamsConfig = () => [];
    mgr._processCurrentStreams = vi.fn();
    mgr._eventBus = { emit: vi.fn() };

    mgr.start("wss://example.com/live");
    mgr.destroy();
    await mgr._transport.callbacks.status({ info: [] });

    const commands = transport.send.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("play");
  });

  it("destroy clears an armed keep-alive timer immediately", () => {
    const { mgr, transport } = createManager("sldp-keepalive-destroy");
    mgr.keepAliveConnection(); // live session kept alive (VOD mode)
    transport.send.mockClear();

    mgr.destroy();
    vi.advanceTimersByTime(10000);

    const keepAlives = transport.send.mock.calls.filter(
      ([cmd, data]) => cmd === "stop" && data.sns?.length === 0,
    );
    expect(keepAlives).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
