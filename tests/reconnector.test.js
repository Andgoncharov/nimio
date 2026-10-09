import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Reconnector } from "@/reconnector";
import { EventBus } from "@/event-bus";

describe("Reconnector.destroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("removes its connection-established subscription", () => {
    const bus = EventBus.getInstance("rc-1");
    const rc = new Reconnector("rc-1", 3);
    expect(bus.listenerCount("nimio:connection-established")).toBe(1);

    rc.destroy();

    expect(bus.listenerCount("nimio:connection-established")).toBe(0);
  });

  it("cancels a scheduled reconnect", () => {
    const rc = new Reconnector("rc-2", 3);
    const cb = vi.fn();
    expect(rc.schedule(cb)).toBe(true);

    rc.destroy();
    vi.advanceTimersByTime(5000);

    expect(cb).not.toHaveBeenCalled();
  });
});
