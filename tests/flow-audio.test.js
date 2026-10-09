import { describe, it, expect, vi, beforeEach } from "vitest";
import { DecoderFlowAudio } from "@/media/decoders/flow-audio";
import { WritableAudioBuffer } from "@/media/buffers/writable-audio-buffer.js";

const SAMPLE_RATE = 48000;
const SAMPLE_COUNT = 960;
const FRAME_US = (SAMPLE_COUNT * 1e6) / SAMPLE_RATE;
const DECODER_DATA = { decoderQueue: 0 };

function createMockAudioFrame(decTimestamp) {
  return {
    decTimestamp,
    numberOfFrames: SAMPLE_COUNT,
    format: "f32-planar",
    copyTo(target) {
      target.fill(1);
    },
    close: vi.fn(),
  };
}

function createState() {
  return {
    isStopped: () => false,
    getPlaybackStartTsUs: () => 1,
    setAudioLatestTsUs: vi.fn(),
    setAudioDecoderQueue: vi.fn(),
  };
}

// The real constructor spawns a decoder worker, only the decoded output
// handling is under test here
function createFlow(buffer) {
  const flow = Object.create(DecoderFlowAudio.prototype);
  flow.setBuffer(buffer, createState());
  flow._startTsUs = 1; // playback start ts is already known
  return flow;
}

function createAudioBuffer() {
  const buffer = WritableAudioBuffer.allocate(1, SAMPLE_RATE, 2, SAMPLE_COUNT);
  buffer.reset();
  return buffer;
}

describe("DecoderFlowAudio decoded buffer full notification", () => {
  let onDecodedBufferFull;

  beforeEach(() => {
    onDecodedBufferFull = vi.fn();
  });

  it("notifies once the audio buffer runs out of space", async () => {
    const buffer = createAudioBuffer();
    const flow = createFlow(buffer);
    flow.onDecodedBufferFull = onDecodedBufferFull;

    const cap = buffer.bufferCapacity;
    for (let i = 0; i < cap - 1; i++) {
      const frame = createMockAudioFrame(i * FRAME_US);
      await flow._handleDecoderOutput(frame, DECODER_DATA);
    }
    expect(onDecodedBufferFull).not.toHaveBeenCalled();

    await flow._handleDecoderOutput(
      createMockAudioFrame((cap - 1) * FRAME_US),
      DECODER_DATA,
    );

    expect(buffer.isFull()).toBe(true);
    expect(onDecodedBufferFull).toHaveBeenCalledTimes(1);
  });

  it("doesn't throw when the buffer is gone before the frame is handled", async () => {
    const flow = createFlow(null);
    flow._startTsUs = 0;
    flow.onStartTsNotSet = async () => false; // e.g. incompatible audio config
    flow.onDecodedBufferFull = onDecodedBufferFull;

    await expect(
      flow._handleDecoderOutput(createMockAudioFrame(0), DECODER_DATA),
    ).resolves.toBeUndefined();
    expect(onDecodedBufferFull).not.toHaveBeenCalled();
  });
});

describe("DecoderFlowAudio start-ts handler failure", () => {
  it("closes the frame and reports failure when the handler rejects", async () => {
    const flow = createFlow(createAudioBuffer());
    flow._startTsUs = 0;
    flow._logger = { error: vi.fn() };
    flow.onStartTsNotSet = () => Promise.reject(new Error("cancelled"));
    const frame = createMockAudioFrame(0);

    await expect(flow._handleDecodedFrame(frame)).resolves.toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(flow._logger.error).toHaveBeenCalled();
  });

  it("drops the frame when the flow was destroyed while the handler was pending", async () => {
    const flow = createFlow(createAudioBuffer());
    flow._startTsUs = 0;
    flow._logger = { error: vi.fn() };
    flow.onStartTsNotSet = async () => {
      flow._buffer = null; // destroy() ran while the handler was awaited
      return true;
    };
    const frame = createMockAudioFrame(0);

    await expect(flow._handleDecodedFrame(frame)).resolves.toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
  });
});

function destroyableFlow() {
  const flow = createFlow(createAudioBuffer());
  flow._logger = { debug: vi.fn(), error: vi.fn() };
  flow._decoder = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  };
  flow._eventBus = { emit: vi.fn() };
  flow._metricsManager = { remove: vi.fn() };
  flow._timestampManager = { removeTrack: vi.fn() };
  flow._trackId = 7;
  flow._type = "audio";
  return flow;
}

describe("DecoderFlow messages after destroy", () => {
  it("closes a frame that arrives after destroy while playback restarted", async () => {
    const flow = destroyableFlow();
    flow.destroy();
    const frame = createMockAudioFrame(0);

    await expect(flow._handleDecodedFrame(frame)).resolves.toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("shutdownComplete after a destroy during a switch terminates the decoder and adopts nothing", async () => {
    const flow = destroyableFlow();
    const decoder = flow._decoder;
    const peer = { exportDecoder: vi.fn(), buffer: null };
    flow._isShuttingDown = true; // finalizeSwitch already posted shutdown
    flow._switchPeerFlow = peer;

    flow.destroy();
    await expect(
      flow._handleDecoderMessage({ data: { type: "shutdownComplete" } }),
    ).resolves.toBeUndefined();

    expect(decoder.terminate).toHaveBeenCalledTimes(1);
    expect(peer.exportDecoder).not.toHaveBeenCalled();
    expect(flow._decoder).toBeNull();
  });

  it("destroy hard-terminates a worker that never completes its shutdown", () => {
    vi.useFakeTimers();
    try {
      const flow = destroyableFlow();
      const decoder = flow._decoder;

      flow.destroy();
      expect(decoder.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);

      expect(decoder.terminate).toHaveBeenCalledTimes(1);
      expect(flow._decoder).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy during a switch shutdown still schedules the fallback and releases the buffer", () => {
    vi.useFakeTimers();
    try {
      const flow = destroyableFlow();
      const decoder = flow._decoder;
      flow._isShuttingDown = true; // finalizeSwitch already posted shutdown

      flow.destroy();
      vi.advanceTimersByTime(1000);

      expect(decoder.terminate).toHaveBeenCalledTimes(1);
      expect(flow._decoder).toBeNull();
      expect(flow._buffer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy completes cleanup and schedules the fallback when shutdown throws", () => {
    vi.useFakeTimers();
    try {
      const flow = destroyableFlow();
      const decoder = flow._decoder;
      flow._metricsManager.remove = () => {
        throw new Error("metrics boom");
      };

      expect(() => flow.destroy()).not.toThrow();
      expect(flow._buffer).toBeNull();
      expect(flow._logger.error).toHaveBeenCalled();
      vi.advanceTimersByTime(1000);

      expect(decoder.terminate).toHaveBeenCalledTimes(1);
      expect(flow._decoder).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
