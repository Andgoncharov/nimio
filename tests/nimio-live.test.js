import { describe, it, expect, vi, beforeEach } from "vitest";

const flowMocks = vi.hoisted(() => {
  class FakeDecoderFlow {
    constructor(instanceName, trackId, timescale) {
      this.instanceName = instanceName;
      this.trackId = trackId;
      this.timescale = timescale;
      this.setConfig = vi.fn();
    }
  }

  return {
    videoInstances: [],
    audioInstances: [],
    FakeVideoFlow: class extends FakeDecoderFlow {
      constructor(...args) {
        super(...args);
        flowMocks.videoInstances.push(this);
      }
    },
    FakeAudioFlow: class extends FakeDecoderFlow {
      constructor(...args) {
        super(...args);
        flowMocks.audioInstances.push(this);
      }
    },
  };
});

vi.mock("@/media/decoders/flow-video", () => ({
  DecoderFlowVideo: flowMocks.FakeVideoFlow,
}));

vi.mock("@/media/decoders/flow-audio", () => ({
  DecoderFlowAudio: flowMocks.FakeAudioFlow,
}));

vi.mock("@/transport/adapter", () => ({
  TransportAdapter: class {
    constructor() {
      this.callbacks = {};
      this.connected = false;
      this.destroy = vi.fn();
      this.send = vi.fn();
    }
  },
}));

import { NimioLive } from "@/nimio-live.js";
import { EventBus } from "@/event-bus";
import { Reconnector } from "@/reconnector";

function createLive() {
  const live = Object.create(NimioLive.prototype);
  live._config = { instanceName: "Test" };
  live._decoderFlows = { video: null, audio: null };
  live._nextRenditionData = {};
  live._sldpManager = { cancelStream: vi.fn() };
  live._eventBus = { emit: vi.fn() };
  live._onDecodedBufferFull = vi.fn();
  return live;
}

describe("NimioLive", () => {
  beforeEach(() => {
    flowMocks.videoInstances.length = 0;
    flowMocks.audioInstances.length = 0;
  });

  describe.each([
    ["video", "videoInstances", { codec: "avc1.42e01e" }, 90000],
    ["audio", "audioInstances", { codec: "mp4a.40.2" }, 48000],
  ])(
    "%s decoded-buffer-full callback",
    (type, instances, config, timescale) => {
      const data = { trackId: 2, timescale, config };

      it("is bound to the main flow with the track type", () => {
        const live = createLive();

        live._createMainDecoderFlow(type, data);

        const flow = flowMocks[instances][0];
        expect(flow.onDecodedBufferFull).toBeTypeOf("function");

        flow.onDecodedBufferFull();
        expect(live._onDecodedBufferFull).toHaveBeenCalledWith(type);
      });

      it("is bound to the next rendition flow with the track type", () => {
        const live = createLive();

        live._createNextRenditionFlow(type, data);

        const flow = flowMocks[instances][0];
        expect(flow.onDecodedBufferFull).toBeTypeOf("function");

        flow.onDecodedBufferFull();
        expect(live._onDecodedBufferFull).toHaveBeenCalledWith(type);
      });
    },
  );

  describe("_onDecodedBufferFull", () => {
    function createLiveInState(paused) {
      const live = Object.create(NimioLive.prototype);
      live._state = { isPaused: () => paused };
      live._logger = { warn: vi.fn() };
      live._cancelPauseTimeout = vi.fn();
      live.stop = vi.fn();
      return live;
    }

    it("stops playback and cancels the pause timeout while paused", () => {
      const live = createLiveInState(true);

      live._onDecodedBufferFull("audio");

      expect(live._cancelPauseTimeout).toHaveBeenCalledTimes(1);
      expect(live.stop).toHaveBeenCalledTimes(1);
      expect(live._logger.warn).toHaveBeenCalledWith(
        "Auto stop on audio buffer fill",
      );
    });

    it("does nothing while playing", () => {
      const live = createLiveInState(false);

      live._onDecodedBufferFull("video");

      expect(live._cancelPauseTimeout).not.toHaveBeenCalled();
      expect(live.stop).not.toHaveBeenCalled();
    });
  });
});

function createLiveForDestroy() {
  const name = "live-destroy-" + Math.random().toString(36).slice(2);
  const live = Object.create(NimioLive.prototype);
  live._instName = name;
  live._config = { instanceName: name, syncBuffer: 1 };
  live._eventBus = EventBus.getInstance(name);
  live._logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  live._state = { isStopped: () => true, stop: vi.fn() };
  live._sldpManager = { stop: vi.fn(), destroy: vi.fn() };
  live._advertizerEval = { handleAction: vi.fn(), pendingActions: [] };
  live._audioInitGen = 0;
  live._latencyCtrl = {};
  live._decoderFlows = { video: null, audio: null };
  live._nextRenditionData = null;
  live._workletLogReceiver = { add: vi.fn(), reset: vi.fn() };
  live._onPlayPauseClick = vi.fn();
  live._onRenditionChange = vi.fn();
  live._initTransport(name, "worker.js");
  live._createSyncModeParams();
  live._reconnect = new Reconnector(name, 3);
  live._addUIEventHandlers();
  return live;
}

describe("NimioLive.destroy", () => {
  const EVENTS = [
    "transp:track-action",
    "nimio:sync-mode-params",
    "nimio:connection-established",
    "ui:play-pause-click",
    "ui:rendition-select",
  ];

  it("subscribes once per engine event on construction", () => {
    const live = createLiveForDestroy();
    for (const ev of EVENTS) {
      expect(live._eventBus.listenerCount(ev), ev).toBe(1);
    }
  });

  it("removes every engine subscription and destroys the transport", () => {
    const live = createLiveForDestroy();
    const transport = live._transport;

    live.destroy();

    for (const ev of EVENTS) {
      expect(live._eventBus.listenerCount(ev), ev).toBe(0);
    }
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.destroy).toHaveBeenCalledTimes(1);
  });

  it("sync-mode params still reach the engine before destroy", () => {
    const live = createLiveForDestroy();
    live._eventBus.emit("nimio:sync-mode-params", {
      playerTimeMs: 5,
      serverTimeMs: 7,
    });
    expect(live._syncModeParams).toEqual({ playerTimeMs: 5, serverTimeMs: 7 });
  });

  it("cancels the autoplay timers so play() never runs on a destroyed engine", () => {
    vi.useFakeTimers();
    try {
      const live = createLiveForDestroy();
      live._playCb = vi.fn();
      live._ui = { hideControls: vi.fn() };
      live._scheduleAutoplay();

      live.destroy();
      vi.runAllTimers();

      expect(live._playCb).not.toHaveBeenCalled();
      expect(live._ui.hideControls).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a detached engine (VOD mode) by closing the connection", () => {
    const live = createLiveForDestroy();
    live._ui = undefined;
    live._transport.connected = true;

    expect(() => live.destroy()).not.toThrow();

    expect(live._sldpManager.stop).toHaveBeenCalledWith({
      closeConnection: true,
    });
    expect(live._transport.destroy).toHaveBeenCalledTimes(1);
  });

  it("audio processor init cancelled by _stopAudio resolves without a node", async () => {
    const nodes = [];
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor(ctx) {
          if (!ctx) throw new TypeError("null audio context");
          nodes.push(this);
          this.port = {
            start: vi.fn(),
            postMessage: vi.fn(),
            addEventListener: vi.fn(),
          };
        }
      },
    );
    try {
      let settle;
      const ctx = {
        sampleRate: 48000,
        audioWorklet: {
          addModule: () => new Promise((resolve) => (settle = resolve)),
        },
      };
      const live = createLiveForDestroy();
      live._audioCtrl = {
        initContext: () => ctx,
        initVolume: vi.fn(),
        reset: vi.fn(),
        connectSource: vi.fn(),
      };
      live._vuMeterSvc = { setAudioInfo: vi.fn(), isInitialized: () => false };
      live._latencyCtrl = {};
      live._audioWorkletReady = null;

      const init = live._initAudioProcessor(48000, 2);
      live._stopAudio();
      settle();

      await expect(init).resolves.toBeUndefined();
      expect(nodes).toHaveLength(0);
      expect(live._audioNode).toBeFalsy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a stale audio start-ts request is refused after a stop/restart", async () => {
    let settle;
    const ctx = {
      sampleRate: 48000,
      audioWorklet: {
        addModule: () => new Promise((resolve) => (settle = resolve)),
      },
    };
    const live = createLiveForDestroy();
    live._audioCtrl = {
      initContext: () => ctx,
      initVolume: vi.fn(),
      reset: vi.fn(),
      connectSource: vi.fn(),
    };
    live._vuMeterSvc = { setAudioInfo: vi.fn(), isInitialized: () => false };
    live._latencyCtrl = {};
    live._audioWorkletReady = null;
    live._audioConfig = { sampleRate: 48000, numberOfChannels: 2 };
    live._firstAudioFrameTsUs = 0;
    live._firstVideoFrameTsUs = 0;
    live._noVideo = true;
    live._state = {
      isStopped: () => false,
      setPlaybackStartTsUs: vi.fn(),
      isShared: () => true,
    };
    const frame = { sampleRate: 48000, numberOfChannels: 2, decTimestamp: 777 };

    const stale = live._onAudioStartTsNotSet(frame);
    live._stopAudio(); // playback stopped while the module was loading
    live._audioContext = ctx; // ...and restarted: new context and node exist
    live._audioNode = { port: { postMessage: vi.fn() } };
    settle();

    await expect(stale).resolves.toBe(false);
    expect(live._firstAudioFrameTsUs).toBe(0);
    expect(live._state.setPlaybackStartTsUs).not.toHaveBeenCalled();
  });

  it("audio processor init creates a node when it is not cancelled", async () => {
    const nodes = [];
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor(ctx) {
          if (!ctx) throw new TypeError("null audio context");
          nodes.push(this);
          this.port = {
            start: vi.fn(),
            postMessage: vi.fn(),
            addEventListener: vi.fn(),
          };
        }
      },
    );
    try {
      const ctx = {
        sampleRate: 48000,
        audioWorklet: { addModule: () => Promise.resolve() },
      };
      const live = createLiveForDestroy();
      live._config.syncBuffer = 0;
      live._audioCtrl = {
        initContext: () => ctx,
        initVolume: vi.fn(),
        reset: vi.fn(),
        connectSource: vi.fn(),
      };
      live._vuMeterSvc = { setAudioInfo: vi.fn(), isInitialized: () => false };
      live._state = { isStopped: () => false, isShared: () => true };
      live._advertizerEval.hasPendingActions = () => false;

      await live._initAudioProcessor(48000, 2);

      expect(nodes).toHaveLength(1);
      expect(live._audioNode).toBe(nodes[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a start-ts request completes when playback was not stopped", async () => {
    const live = createLiveForDestroy();
    live._initAudioProcessor = vi.fn(async () => {
      live._audioContext = {};
      live._audioNode = {};
    });
    live._audioConfig = { sampleRate: 48000, numberOfChannels: 2 };
    live._firstAudioFrameTsUs = 0;
    live._firstVideoFrameTsUs = 0;
    live._noVideo = false;
    live._state = { isStopped: () => false };

    await expect(
      live._onAudioStartTsNotSet({
        sampleRate: 48000,
        numberOfChannels: 2,
        decTimestamp: 777,
      }),
    ).resolves.toBe(true);
    expect(live._firstAudioFrameTsUs).toBe(777);
  });

  it("sync-mode clock reply arriving after stop does not touch the node", async () => {
    const handlers = [];
    const port = {
      start: vi.fn(),
      postMessage: vi.fn(),
      addEventListener: (type, h) => handlers.push(h),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          this.port = port;
        }
      },
    );
    try {
      const ctx = {
        sampleRate: 48000,
        audioWorklet: { addModule: () => Promise.resolve() },
      };
      const live = createLiveForDestroy();
      live._config.syncBuffer = 1;
      live._audioCtrl = {
        initContext: () => ctx,
        initVolume: vi.fn(),
        reset: vi.fn(),
        connectSource: vi.fn(),
      };
      live._vuMeterSvc = { setAudioInfo: vi.fn(), isInitialized: () => false };
      live._state = { isStopped: () => false, isShared: () => true };
      live._advertizerEval = {
        handleAction: vi.fn(),
        hasPendingActions: () => true,
        pendingActions: [{ op: "rem" }],
        clearPendingActions: vi.fn(),
      };

      const init = live._initAudioProcessor(48000, 2);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(handlers).toHaveLength(1); // clock handshake is waiting
      live._stopAudio();
      for (let i = 0; i < 3; i++) {
        handlers[0]({
          data: {
            aux: true,
            type: "clock-reply",
            timeMainSend: 0,
            timeWorker: 0,
          },
        });
      }

      await expect(init).resolves.toBeUndefined();
      expect(live._advertizerEval.clearPendingActions).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("advertizer eval-ready reply uses the node it was registered on", () => {
    const handlers = [];
    const node = {
      port: {
        postMessage: vi.fn(),
        addEventListener: (type, h) => handlers.push(h),
        removeEventListener: vi.fn(),
      },
    };
    const live = createLiveForDestroy();
    live._audioNode = node;
    live._advertizerEval = {
      hasPendingActions: () => true,
      pendingActions: [{ op: "rem" }],
      clearPendingActions: vi.fn(),
    };
    live._sendPendingAdvertizerActions();
    live._audioNode = null; // stopped before the processor replied

    expect(() =>
      handlers[0]({ data: "transp-discont-eval-ready" }),
    ).not.toThrow();
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: "transp-track-action",
      data: { op: "rem" },
    });
  });

  it("ignores stream setups received while stopped", () => {
    const live = createLiveForDestroy();
    live._createMainDecoderFlow = vi.fn();
    live._setNoVideo = vi.fn();

    live._onVideoSetupReceived({ trackId: 1, config: { codec: "avc1" } });
    live._onAudioSetupReceived({ trackId: 2, config: { codec: "mp4a.40.2" } });

    expect(live._createMainDecoderFlow).not.toHaveBeenCalled();
  });

  it("destroy releases flows, ABR, audio and grabber even when already stopped", () => {
    const live = createLiveForDestroy();
    const video = { destroy: vi.fn() };
    const next = { destroy: vi.fn() };
    live._decoderFlows = { video, audio: null };
    live._nextRenditionData = { decoderFlow: next };
    live._abrController = { stop: vi.fn() };
    live._context = { autoAbr: true };
    live._audioContext = {};
    live._audioCtrl = { reset: vi.fn() };
    live._grabber = { stop: vi.fn() };

    live.destroy();

    expect(video.destroy).toHaveBeenCalledTimes(1);
    expect(next.destroy).toHaveBeenCalledTimes(1);
    expect(live._decoderFlows.video).toBeNull();
    expect(live._nextRenditionData).toBeNull();
    expect(live._abrController.stop).toHaveBeenCalledWith({ hard: true });
    expect(live._audioCtrl.reset).toHaveBeenCalledTimes(1);
    expect(live._grabber.stop).toHaveBeenCalledTimes(1);
  });

  it("destroy stops the metrics overlay even when the engine is already stopped", () => {
    const live = createLiveForDestroy();
    live._debugView = { stop: vi.fn(), clear: vi.fn() };

    live.destroy();

    expect(live._debugView.stop).toHaveBeenCalledTimes(1);
  });

  it("play() is a no-op on a destroyed engine", () => {
    const live = createLiveForDestroy();
    live.destroy();
    live._state = {
      isStopped: () => true,
      isPlaying: () => false,
      isPaused: () => false,
      start: vi.fn(),
    };

    live.play(); // e.g. a playback-end listener restarting during destroy

    expect(live._state.start).not.toHaveBeenCalled();
  });

  it("destroying inside a nimio:play listener does not continue starting playback", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = createLiveForDestroy();
      live._state = {
        isStopped: () => true,
        isPlaying: () => false,
        isPaused: () => false,
        start: vi.fn(),
        stop: vi.fn(),
      };
      live._latencyCtrl = { start: vi.fn() };
      live._debugView = { start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
      live._sldpManager.start = vi.fn();
      live._eventBus.on("nimio:play", () => live.destroy());

      live.play();

      expect(live._sldpManager.start).not.toHaveBeenCalled();
      expect(live._debugView.start).not.toHaveBeenCalled();
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("destroying inside a nimio:playback-start listener does not start the grabber", () => {
    const live = createLiveForDestroy();
    live._playbackStarted = false;
    live._grabber = { start: vi.fn(), stop: vi.fn() };
    live._eventBus.on("nimio:playback-start", () => live.destroy());
    const frame = { close: vi.fn() };

    expect(live._startPlaybackOutput(frame)).toBe(false);

    expect(live._grabber.start).not.toHaveBeenCalled();
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("a throwing playback-end listener does not interrupt destroy", () => {
    const live = createLiveForDestroy();
    // a playing engine, so stop() runs its full path and emits playback-end
    live._state = {
      isStopped: () => false,
      stop: vi.fn(),
      setPlaybackStartTsUs: vi.fn(),
      setVideoLatestTsUs: vi.fn(),
      setAudioLatestTsUs: vi.fn(),
      resetCurrentTsSmp: vi.fn(),
    };
    live._ui = { clear: vi.fn() };
    live._videoBuffer = { reset: vi.fn() };
    live._vuMeterSvc = { stop: vi.fn() };
    live._latencyCtrl = { reset: vi.fn() };
    live._advertizerEval.reset = vi.fn();
    live._eventBus.on("nimio:playback-end", () => {
      throw new Error("listener boom");
    });
    const transport = live._transport;

    expect(() => live.destroy()).toThrow("listener boom");

    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(live._sldpManager.destroy).toHaveBeenCalledTimes(1);
    expect(live._eventBus.listenerCount("transp:track-action")).toBe(0);
    expect(live._eventBus.listenerCount("nimio:connection-established")).toBe(
      0,
    );
  });

  it("destroying inside a nimio:connection-started listener does not start the metrics overlay", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = createLiveForDestroy();
      live._state = {
        isStopped: () => true,
        isPlaying: () => false,
        isPaused: () => false,
        start: vi.fn(),
        stop: vi.fn(),
      };
      live._latencyCtrl = { start: vi.fn() };
      live._debugView = { start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
      live._sldpManager.start = vi.fn(() =>
        live._eventBus.emit("nimio:connection-started", "wss://x"),
      );
      live._eventBus.on("nimio:connection-started", () => live.destroy());

      live.play();

      expect(live._debugView.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes the first frame even when a listener throws during the destroy it triggered", () => {
    const live = createLiveForDestroy();
    live._state = {
      isStopped: () => false,
      stop: vi.fn(),
      setPlaybackStartTsUs: vi.fn(),
      setVideoLatestTsUs: vi.fn(),
      setAudioLatestTsUs: vi.fn(),
      resetCurrentTsSmp: vi.fn(),
    };
    live._ui = { clear: vi.fn() };
    live._videoBuffer = { reset: vi.fn() };
    live._vuMeterSvc = { stop: vi.fn() };
    live._latencyCtrl = { reset: vi.fn() };
    live._advertizerEval.reset = vi.fn();
    live._playbackStarted = false;
    live._grabber = { start: vi.fn(), stop: vi.fn() };
    live._eventBus.on("nimio:playback-start", () => live.destroy());
    live._eventBus.on("nimio:playback-end", () => {
      throw new Error("end listener boom");
    });
    const frame = { close: vi.fn() };

    expect(live._startPlaybackOutput(frame)).toBe(false);

    expect(frame.close).toHaveBeenCalledTimes(1);
    expect(live._grabber.start).not.toHaveBeenCalled();
    expect(live._logger.error).toHaveBeenCalled();
  });

  it("destroying inside a nimio:connection-started listener during attach does not start the overlay", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = createLiveForDestroy();
      live._ui = undefined; // detached (VOD mode), returning to live
      live._attachUI = vi.fn((ui) => (live._ui = ui));
      live._context = { state: { value: 1 } };
      live._state = { isStopped: () => true, start: vi.fn(), stop: vi.fn() };
      live._latencyCtrl = { start: vi.fn() };
      live._debugView = { start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
      live._transport.connected = false;
      live._sldpManager.start = vi.fn(() =>
        live._eventBus.emit("nimio:connection-started", "wss://x"),
      );
      live._eventBus.on("nimio:connection-started", () => live.destroy());

      const attached = live.attach({ setAttached: vi.fn() }, { latency: 0 });

      expect(attached).toBe(false);
      expect(live._debugView.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function playingShell() {
    const live = createLiveForDestroy();
    let stopped = true;
    live._state = {
      isStopped: () => stopped,
      isPlaying: () => false,
      isPaused: () => false,
      start: vi.fn(() => (stopped = false)),
      stop: vi.fn(() => (stopped = true)),
      setPlaybackStartTsUs: vi.fn(),
      setVideoLatestTsUs: vi.fn(),
      setAudioLatestTsUs: vi.fn(),
      resetCurrentTsSmp: vi.fn(),
    };
    live._ui = { clear: vi.fn() };
    live._videoBuffer = { reset: vi.fn() };
    live._vuMeterSvc = { stop: vi.fn() };
    live._latencyCtrl = { start: vi.fn(), reset: vi.fn() };
    live._advertizerEval.reset = vi.fn();
    live._debugView = { start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
    live._sldpManager.start = vi.fn();
    return live;
  }

  it("a nimio:play listener that stops the player prevents the connection start", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = playingShell();
      live._eventBus.on("nimio:play", () => live.stop());

      live.play();

      expect(live._sldpManager.start).not.toHaveBeenCalled();
      expect(live._debugView.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a nimio:playback-start listener that stops the player does not start the grabber", () => {
    const live = playingShell();
    live._state.start();
    live._playbackStarted = false;
    live._grabber = { start: vi.fn(), stop: vi.fn() };
    live._eventBus.on("nimio:playback-start", () => live.stop());
    const frame = { close: vi.fn() };

    expect(live._startPlaybackOutput(frame)).toBe(false);

    expect(live._grabber.start).not.toHaveBeenCalled();
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it("a playback-end listener calling pause() during destroy schedules no timer", () => {
    vi.useFakeTimers();
    try {
      const live = playingShell();
      live._state.start();
      live._state.isPaused = () => false;
      live._state.pause = vi.fn();
      live._latencyCtrl.pause = vi.fn();
      live._config.pauseTimeout = 600000;
      live._eventBus.on("nimio:playback-end", () => live.pause());

      live.destroy();

      expect(live._pauseTimeoutId).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy stops the render loop even when the stop stage throws", () => {
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    try {
      const live = playingShell();
      live._state.start();
      live._noVideo = false;
      live._sldpManager.stop = () => {
        throw new Error("transport gone");
      };

      expect(() => live.destroy()).toThrow("transport gone");

      expect(live._state.stop).toHaveBeenCalled();
      live._state.isPlaying = () => true; // even if state were still playing
      live._renderVideoFrame();
      expect(raf).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a nimio:connection-started listener that stops the player does not start the overlay (play)", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = playingShell();
      live._sldpManager.start = vi.fn(() =>
        live._eventBus.emit("nimio:connection-started", "wss://x"),
      );
      live._eventBus.on("nimio:connection-started", () => live.stop());

      live.play();

      expect(live._debugView.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a nimio:connection-started listener that stops the player does not start the overlay (attach)", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    try {
      const live = playingShell();
      live._ui = undefined;
      live._attachUI = vi.fn((ui) => (live._ui = ui));
      live._context = { state: { value: 1 } };
      live._transport.connected = false;
      live._sldpManager.start = vi.fn(() =>
        live._eventBus.emit("nimio:connection-started", "wss://x"),
      );
      live._eventBus.on("nimio:connection-started", () => live.stop());

      const attached = live.attach({ clear: vi.fn() }, { latency: 0 });

      expect(attached).toBe(false);
      expect(live._debugView.start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("NimioLive no-audio mode", () => {
  it("no-audio mode keeps the running node and context when one already exists", async () => {
    const live = createLiveForDestroy();
    const node = { port: { postMessage: vi.fn() } };
    live._audioContext = { sampleRate: 44100 };
    live._audioNode = node;
    live._audioWorkletReady = Promise.resolve();
    live._audioCtrl = { initContext: vi.fn(), reset: vi.fn() };

    await live._startNoAudioMode(); // e.g. after an audio decoder error

    expect(live._audioCtrl.initContext).not.toHaveBeenCalled();
    expect(live._audioNode).toBe(node);
    expect(live._audioContext.sampleRate).toBe(44100);
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: "audio-status",
      data: { enabled: false },
    });
  });
});
