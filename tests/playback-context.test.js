import { describe, it, expect } from "vitest";
import { PlaybackContext } from "@/playback/context";

function stream(name, height) {
  return {
    stream: name,
    stream_info: {
      resolution: `640x${height}`,
      vcodec: "avc1.42e01e",
      bandwidth: "1000",
      vtimescale: "90000",
    },
  };
}

describe("PlaybackContext.setStreams concurrency", () => {
  it("a superseded call commits nothing and the newest call wins", async () => {
    const ctx = PlaybackContext.getInstance("ctx-seq");
    const support = { video: { "avc1.42e01e": true }, audio: {} };
    let settleOld;
    ctx._checkSupportedCodecs = () =>
      settleOld
        ? Promise.resolve(support)
        : new Promise((resolve) => (settleOld = () => resolve(support)));

    const old = ctx.setStreams([stream("a", 360), stream("b", 720)]);
    const fresh = ctx.setStreams([stream("c", 480)]);
    await expect(fresh).resolves.toBe(true);
    settleOld();

    await expect(old).resolves.toBe(false);
    expect(ctx.streams.map((s) => s.stream)).toEqual(["c"]);
    expect(ctx.videoRenditions).toHaveLength(1);
    expect(ctx.videoRenditions[0].name).toBe("c");
  });
});
