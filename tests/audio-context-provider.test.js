import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioContextProvider } from "@/audio/context-provider";

let created;

class FakeAudioContext {
  constructor(opts) {
    this.sampleRate = opts.sampleRate;
    this.state = "running";
    this.destination = { maxChannelCount: 2, channelCount: 2 };
    this.close = vi.fn(() => {
      this.state = "closed";
      return Promise.resolve();
    });
    this.resume = vi.fn();
    created.push(this);
  }
}

describe("AudioContextProvider.destroy", () => {
  let name = 0;
  let provider;

  beforeEach(() => {
    created = [];
    window.AudioContext = FakeAudioContext;
    provider = AudioContextProvider.getInstance(`acp-${++name}`);
  });

  afterEach(() => {
    delete window.AudioContext;
  });

  it("closes the context once and drops the reference", () => {
    provider.init(48000);
    const ctx = created[0];

    provider.destroy();
    provider.destroy();

    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(provider.get()).toBeUndefined();
  });

  it("does not call close() on an already closed context", () => {
    provider.init(48000);
    const ctx = created[0];
    ctx.state = "closed";

    provider.destroy();

    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("clears the state-change handler and pending callbacks of a suspended context", () => {
    class Suspended extends FakeAudioContext {
      constructor(opts) {
        super(opts);
        this.state = "suspended";
      }
    }
    window.AudioContext = Suspended;
    provider.init(48000);
    const ctx = created[0];
    const cb = vi.fn();
    provider.onContextRunning(cb);
    expect(typeof ctx.onstatechange).toBe("function");

    provider.destroy();

    expect(ctx.onstatechange).toBeUndefined();
    expect(provider.isSuspended()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows a rejected close()", async () => {
    provider.init(48000);
    const ctx = created[0];
    ctx.close = vi.fn(() => Promise.reject(new Error("closing")));

    expect(() => provider.destroy()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("is a no-op when no context was created", () => {
    expect(() => provider.destroy()).not.toThrow();
  });

  it("closes the previous context when the sample rate changes", () => {
    provider.init(48000);
    provider.init(44100);

    expect(created).toHaveLength(2);
    expect(created[0].close).toHaveBeenCalledTimes(1);
    expect(created[1].close).not.toHaveBeenCalled();
    expect(provider.get()).toBe(created[1]);
  });
});
