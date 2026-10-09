import { describe, it, expect, vi } from "vitest";
import {
  multiInstanceService,
  releaseInstances,
  hasInstances,
} from "@/shared/service";

function service(extra) {
  return multiInstanceService(
    class {
      constructor(id) {
        this.id = id;
        if (extra) extra(this);
      }
    },
  );
}

describe("multiInstanceService release", () => {
  it("releaseInstance evicts the object and a later getInstance creates a new one", () => {
    const Svc = service();
    const first = Svc.getInstance("x");

    expect(Svc.hasInstance("x")).toBe(true);
    expect(Svc.releaseInstance("x")).toBe(true);
    expect(Svc.hasInstance("x")).toBe(false);
    expect(Svc.releaseInstance("x")).toBe(false);
    expect(Svc.getInstance("x")).not.toBe(first);
  });

  it("calls destroy() once on the evicted object when it is defined", () => {
    const destroy = vi.fn();
    const Svc = service((inst) => (inst.destroy = destroy));
    Svc.getInstance("y");

    Svc.releaseInstance("y");
    Svc.releaseInstance("y");

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("evicts before calling destroy() so a hook cannot re-fetch itself", () => {
    let seen;
    const Svc = service((inst) => {
      inst.destroy = () => {
        seen = Svc.hasInstance("z");
      };
    });
    Svc.getInstance("z");

    Svc.releaseInstance("z");

    expect(seen).toBe(false);
  });

  it("releaseInstances releases the name in every registered service and counts them", () => {
    const A = service();
    const B = service();
    A.getInstance("shared");
    B.getInstance("shared");
    B.getInstance("other");

    expect(hasInstances("shared")).toBe(true);
    expect(releaseInstances("shared")).toBe(2);
    expect(hasInstances("shared")).toBe(false);
    expect(B.hasInstance("other")).toBe(true);
    expect(releaseInstances("shared")).toBe(0);
  });

  it("hasInstances is false for an unknown name and for a missing name", () => {
    expect(hasInstances("never-created")).toBe(false);
    expect(hasInstances(undefined)).toBe(false);
  });

  it("a throwing destroy hook does not stop the other services from releasing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bad = service((inst) => {
      inst.destroy = () => {
        throw new Error("hook boom");
      };
    });
    const Good = service();
    Bad.getInstance("mixed");
    Good.getInstance("mixed");

    expect(() => releaseInstances("mixed")).not.toThrow();

    expect(Bad.hasInstance("mixed")).toBe(false);
    expect(Good.hasInstance("mixed")).toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
