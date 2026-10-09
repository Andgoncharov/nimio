import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const workers = vi.hoisted(() => []);

class FakeWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    this.onmessage = null;
    workers.push(this);
  }
}

import { TransportAdapter } from "@/transport/adapter";

describe("TransportAdapter.destroy", () => {
  beforeEach(() => {
    workers.length = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the worker to terminate, stops listening and reports disconnected", () => {
    const adapter = new TransportAdapter("ta-1", "worker.js");
    const worker = workers[0];
    worker.onmessage({ data: { aux: true, connected: true } });
    expect(adapter.connected).toBe(true);

    adapter.destroy();

    expect(worker.onmessage).toBeNull();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "terminate" });
    expect(adapter.connected).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("hard-terminates the worker after the fallback delay", () => {
    const adapter = new TransportAdapter("ta-2", "worker.js");
    const worker = workers[0];

    adapter.destroy();
    vi.advanceTimersByTime(999);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("still schedules the hard terminate when postMessage throws", () => {
    const adapter = new TransportAdapter("ta-3", "worker.js");
    const worker = workers[0];
    worker.postMessage = vi.fn(() => {
      throw new Error("worker gone");
    });

    expect(() => adapter.destroy()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and makes later send() calls no-ops", () => {
    const adapter = new TransportAdapter("ta-4", "worker.js");
    const worker = workers[0];

    adapter.destroy();
    adapter.destroy();
    adapter.send("play", { streams: [] });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("runCallback is a no-op after destroy", () => {
    const adapter = new TransportAdapter("ta-5", "worker.js");
    const cb = vi.fn();
    adapter.setCallback("videoSetup", cb);

    adapter.destroy();

    expect(() =>
      adapter.runCallback("videoSetup", { trackId: 1 }),
    ).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it("runCallback logs and returns when no callback is set", () => {
    const adapter = new TransportAdapter("ta-6", "worker.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => adapter.runCallback("audioSetup", {})).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
