import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sockets = [];

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.close = vi.fn();
    this.send = vi.fn();
    sockets.push(this);
  }
}

describe("transport worker terminate command", () => {
  let closeSpy;

  beforeEach(async () => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    closeSpy = vi.spyOn(self, "close").mockImplementation(() => {});
    vi.resetModules();
    await import("@/transport/web-socket");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeSpy.mockRestore();
    self.onmessage = null;
  });

  it("closes the socket silently and closes the worker scope", () => {
    self.onmessage({
      data: {
        type: "start",
        url: "wss://x",
        protocols: ["sldp.softvelum.com"],
      },
    });
    const socket = sockets[0];
    socket.onclose = () => {};

    self.onmessage({ data: { type: "terminate" } });

    expect(socket.onclose).toBeUndefined();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the worker scope even when no socket exists", () => {
    self.onmessage({ data: { type: "terminate" } });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
