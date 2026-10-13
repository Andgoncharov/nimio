import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;

// Minimal stand-in for the browser WebSocket: send() throws on a socket that
// is not OPEN, exactly as the WebSocket spec requires.
class FakeWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== OPEN) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        "InvalidStateError",
      );
    }
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closeCalls++;
    this.readyState = CLOSING;
  }
}

async function loadWorker() {
  vi.resetModules();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  self.postMessage = vi.fn();
  await import("@/transport/web-socket");
  return (data) => self.onmessage({ data });
}

function startSocket(post) {
  post({
    type: "start",
    url: "wss://example.test/live",
    protocols: ["sldp.softvelum.com"],
    syncMode: false,
  });
  return FakeWebSocket.instances.at(-1);
}

describe("transport worker stop command", () => {
  let post;

  beforeEach(async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    post = await loadWorker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("closing stop with no streams closes a CONNECTING socket without sending", () => {
    const socket = startSocket(post);
    expect(socket.readyState).toBe(CONNECTING);

    expect(() => post({ type: "stop", sns: [], close: true })).not.toThrow();

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toBe(1);
    expect(self.postMessage).toHaveBeenCalledWith({
      aux: true,
      connected: false,
    });
  });

  it("closing stop with requested streams still closes a CONNECTING socket", () => {
    const socket = startSocket(post);

    expect(() =>
      post({ type: "stop", sns: [1, 2], close: true }),
    ).not.toThrow();

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toBe(1);
  });

  it("keep-alive (empty Cancel without close) is still sent on an OPEN socket", () => {
    const socket = startSocket(post);
    socket.readyState = OPEN;

    post({ type: "stop", sns: [] });

    expect(socket.sent).toEqual([{ command: "Cancel", streams: [] }]);
    expect(socket.closeCalls).toBe(0);
  });

  it("closing stop with streams on an OPEN socket sends Cancel and then closes", () => {
    const socket = startSocket(post);
    socket.readyState = OPEN;

    post({ type: "stop", sns: [1, 2], close: true });

    expect(socket.sent).toEqual([{ command: "Cancel", streams: [1, 2] }]);
    expect(socket.closeCalls).toBe(1);
  });
});
