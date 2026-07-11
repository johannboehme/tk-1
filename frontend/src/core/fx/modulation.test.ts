import { describe, expect, test } from "vitest";
import {
  bipolarRateLabel,
  bipolarRatePeriodS,
  buildFollowerCurve,
  computeIntensity,
  DEFAULT_MODULATION,
  FOLLOWER_MEMO_MAX,
  followerFor,
  isSyncedRate,
  lfoPhaseAt,
  lfoShapeAt,
  sampleFollower,
  type AudioEnvelope,
  type ModContext,
  type Modulation,
  type SidechainConfig,
} from "./modulation";

/** A rate on the synced half that resolves to a given division label. */
function rateForLabel(label: string): number {
  for (let r = 0.5001; r <= 1; r += 0.0005) {
    if (bipolarRateLabel(r, 120) === label) return r;
  }
  throw new Error(`no rate maps to ${label}`);
}

function ctx(over: Partial<ModContext> = {}): ModContext {
  return {
    tMasterS: 0,
    tTimelineS: 0,
    regionInS: 0,
    regionDurS: 10,
    holding: false,
    bpm: 120,
    beatPhaseS: 0,
    beatsPerBar: 4,
    sidechainCurve: null,
    ...over,
  };
}

describe("bipolar rate — beat divisions follow real BPM", () => {
  test("1/4 = one beat at any BPM (not hardcoded to 120)", () => {
    const r = rateForLabel("1/4");
    expect(bipolarRatePeriodS(r, 120)).toBeCloseTo(0.5, 6); // 60/120
    expect(bipolarRatePeriodS(r, 100)).toBeCloseTo(0.6, 6); // 60/100
    expect(bipolarRatePeriodS(r, 140)).toBeCloseTo(60 / 140, 6);
  });

  test("label and rendered period never disagree (no inversion)", () => {
    // For each labelled division the period equals 60/bpm * beats(label).
    const beatsForLabel: Record<string, number> = {
      "1/16": 0.25,
      "1/8": 0.5,
      "1/4": 1,
      "1/2": 2,
      "1": 4,
      "2": 8,
      "4": 16,
    };
    for (const [label, beats] of Object.entries(beatsForLabel)) {
      const r = rateForLabel(label);
      expect(bipolarRateLabel(r, 120)).toBe(label);
      expect(bipolarRatePeriodS(r, 120)).toBeCloseTo(0.5 * beats, 6);
    }
  });

  test("TE direction: near centre = slowest, far right = fastest", () => {
    expect(bipolarRateLabel(0.51, 120)).toBe("4"); // slowest division
    expect(bipolarRateLabel(1.0, 120)).toBe("1/16"); // fastest division
    expect(bipolarRatePeriodS(0.51, 120)).toBeGreaterThan(
      bipolarRatePeriodS(1.0, 120),
    );
  });

  test("free (left) half is continuous Hz, slowest near centre", () => {
    expect(isSyncedRate(0.49)).toBe(false);
    expect(isSyncedRate(0.51)).toBe(true);
    // Closer to centre → slower (longer period) than the far-left extreme.
    expect(bipolarRatePeriodS(0.49, 120)).toBeGreaterThan(
      bipolarRatePeriodS(0.0, 120),
    );
    expect(bipolarRateLabel(0.2, 120)).toMatch(/HZ$/);
  });
});

describe("LFO shapes (peak on the beat at phase 0)", () => {
  test("each shape hits the expected anchor points", () => {
    expect(lfoShapeAt("sine", 0)).toBeCloseTo(1, 6);
    expect(lfoShapeAt("sine", 0.5)).toBeCloseTo(0, 6);
    expect(lfoShapeAt("triangle", 0)).toBeCloseTo(1, 6);
    expect(lfoShapeAt("triangle", 0.5)).toBeCloseTo(0, 6);
    expect(lfoShapeAt("saw", 0)).toBeCloseTo(1, 6);
    expect(lfoShapeAt("saw", 0.99)).toBeLessThan(0.05);
    expect(lfoShapeAt("ramp", 0)).toBeCloseTo(0, 6);
    expect(lfoShapeAt("ramp", 0.99)).toBeGreaterThan(0.95);
    expect(lfoShapeAt("square", 0.25)).toBe(1);
    expect(lfoShapeAt("square", 0.75)).toBe(0);
  });
});

describe("LFO phase — beat-synced lands on the grid", () => {
  test("synced + grid-anchored pulses on the beat regardless of region start", () => {
    const lfo = { shape: "saw" as const, rate: rateForLabel("1/4"), beatSync: true };
    // Region starts off-grid; beat-sync must ignore it and use master-time.
    const base = ctx({ regionInS: 0.123, bpm: 120, beatPhaseS: 0 });
    for (const tMaster of [0, 0.5, 1.0, 1.5]) {
      const p = lfoPhaseAt(lfo, { ...base, tMasterS: tMaster });
      expect(p).toBeCloseTo(0, 5); // on the beat
    }
    // Half-way between beats → phase 0.5.
    expect(lfoPhaseAt(lfo, { ...base, tMasterS: 0.25 })).toBeCloseTo(0.5, 5);
  });

  test("free LFO anchors to the region start (timeline-local)", () => {
    const lfo = { shape: "saw" as const, rate: 0.0, beatSync: false }; // fast free
    const period = bipolarRatePeriodS(0.0, 120);
    const base = ctx({ regionInS: 5 });
    const p0 = lfoPhaseAt(lfo, { ...base, tTimelineS: 5 });
    expect(p0).toBeCloseTo(0, 5);
    const pHalf = lfoPhaseAt(lfo, { ...base, tTimelineS: 5 + period / 2 });
    expect(pHalf).toBeCloseTo(0.5, 4);
  });
});

describe("computeIntensity — envelope ⊗ modulator, blended by depth", () => {
  const flatEnv = { attackS: 0, decayS: 0, sustain: 1, releaseS: 0 };

  test("depth 0 → modulator is a no-op (envelope only)", () => {
    const mod: Modulation = {
      ...DEFAULT_MODULATION,
      envelope: flatEnv,
      timeMod: "lfo",
      depth: 0,
      lfo: { shape: "saw", rate: rateForLabel("1/4"), beatSync: true },
    };
    // Off-beat (would be a deep dip if depth mattered) still reads full.
    const r = computeIntensity(mod, ctx({ tMasterS: 0.25, tTimelineS: 0.25 }));
    expect(r.level).toBeCloseTo(1, 6);
  });

  test("depth 1 + saw → full on the beat, dips between", () => {
    const mod: Modulation = {
      ...DEFAULT_MODULATION,
      envelope: flatEnv,
      timeMod: "lfo",
      depth: 1,
      lfo: { shape: "saw", rate: rateForLabel("1/4"), beatSync: true },
    };
    const onBeat = computeIntensity(mod, ctx({ tMasterS: 1.0, tTimelineS: 1.0 }));
    const offBeat = computeIntensity(mod, ctx({ tMasterS: 1.25, tTimelineS: 1.25 }));
    expect(onBeat.level).toBeCloseTo(1, 5);
    expect(offBeat.level).toBeLessThan(onBeat.level);
    expect(offBeat.level).toBeCloseTo(0.5, 4); // saw at phase 0.5
  });

  test("envelope gates the whole thing to 0", () => {
    const mod: Modulation = {
      ...DEFAULT_MODULATION,
      envelope: { attackS: 1, decayS: 0, sustain: 1, releaseS: 0 },
      depth: 1,
    };
    // localT = 0 with a 1s attack → envelope 0 → level 0.
    const r = computeIntensity(mod, ctx({ tTimelineS: 0, regionInS: 0 }));
    expect(r.level).toBe(0);
  });

  test("sidechain mode reads the prebuilt follower curve", () => {
    const curve: AudioEnvelope = { data: [0, 0, 1, 1, 0], fps: 1 };
    const mod: Modulation = {
      ...DEFAULT_MODULATION,
      envelope: flatEnv,
      timeMod: "sidechain",
      depth: 1,
    };
    const loud = computeIntensity(
      mod,
      ctx({ tMasterS: 2, sidechainCurve: curve }),
    );
    const quiet = computeIntensity(
      mod,
      ctx({ tMasterS: 0, sidechainCurve: curve }),
    );
    expect(loud.level).toBeCloseTo(1, 6);
    expect(quiet.level).toBeCloseTo(0, 6);
  });
});

describe("sidechain follower curve", () => {
  test("threshold gates, attack=0 is instant, release decays", () => {
    const audio: AudioEnvelope = { data: [0, 0, 1, 1, 0, 0, 0], fps: 10 };
    const curve = buildFollowerCurve(audio, {
      threshold: 0,
      attackS: 0, // instant rise
      releaseS: 1.0, // slow fall
      invert: false,
    });
    const d = Array.from(curve.data);
    expect(d[2]).toBeCloseTo(1, 6); // instant attack to full
    expect(d[4]).toBeGreaterThan(0); // still decaying after the drop
    expect(d[4]).toBeLessThan(d[3]); // monotonically falling
    expect(d[5]).toBeLessThan(d[4]);
  });

  test("threshold ignores sub-threshold loudness", () => {
    const audio: AudioEnvelope = { data: [0.4, 0.4, 1.0], fps: 10 };
    const curve = buildFollowerCurve(audio, {
      threshold: 0.5,
      attackS: 0,
      releaseS: 0,
      invert: false,
    });
    const d = Array.from(curve.data);
    expect(d[0]).toBeCloseTo(0, 6); // 0.4 < 0.5 → gated
    expect(d[2]).toBeCloseTo(1, 6); // (1.0-0.5)/0.5 = 1
  });

  test("invert flips the follower (ducking)", () => {
    const audio: AudioEnvelope = { data: [0, 1], fps: 10 };
    const normal = buildFollowerCurve(audio, {
      threshold: 0,
      attackS: 0,
      releaseS: 0,
      invert: false,
    });
    const ducked = buildFollowerCurve(audio, {
      threshold: 0,
      attackS: 0,
      releaseS: 0,
      invert: true,
    });
    expect(ducked.data[1]).toBeCloseTo(1 - normal.data[1], 6);
    expect(ducked.data[1]).toBeCloseTo(0, 6); // loud → weak when inverted
  });

  test("sampleFollower clamps and handles null", () => {
    expect(sampleFollower(null, 1)).toBe(0);
    const curve: AudioEnvelope = { data: [0, 1], fps: 1 };
    expect(sampleFollower(curve, -5)).toBeCloseTo(0, 6);
    expect(sampleFollower(curve, 99)).toBeCloseTo(1, 6);
    expect(sampleFollower(curve, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe("followerFor memo — bounded LRU per audio env", () => {
  const makeAudio = (): AudioEnvelope => ({
    data: new Float32Array(256).fill(0.5),
    fps: 120,
  });
  const sideAt = (threshold: number): SidechainConfig => ({
    threshold,
    attackS: 0.01,
    releaseS: 0.18,
    invert: false,
  });

  test("same config returns the cached curve (identity)", () => {
    const audio = makeAudio();
    const a = followerFor(audio, sideAt(0.3));
    const b = followerFor(audio, sideAt(0.3));
    expect(b).toBe(a);
  });

  test("null audio returns null", () => {
    expect(followerFor(null, sideAt(0.3))).toBeNull();
    expect(followerFor(undefined, sideAt(0.3))).toBeNull();
  });

  test("retains at most FOLLOWER_MEMO_MAX curves — a knob-drag's worth of stale configs is evicted", () => {
    const audio = makeAudio();
    const first = followerFor(audio, sideAt(0));
    // Simulate a knob drag: a stream of distinct intermediate configs,
    // more than the cap. The earliest entry must be evicted (rebuilt on
    // re-request → different identity), the freshest must survive.
    for (let i = 1; i <= FOLLOWER_MEMO_MAX; i++) {
      followerFor(audio, sideAt(i / 100));
    }
    const freshest = followerFor(audio, sideAt(FOLLOWER_MEMO_MAX / 100));
    expect(followerFor(audio, sideAt(0))).not.toBe(first); // evicted
    expect(followerFor(audio, sideAt(FOLLOWER_MEMO_MAX / 100))).toBe(freshest); // retained
  });

  test("a cache hit refreshes recency (true LRU, not FIFO)", () => {
    const audio = makeAudio();
    const a = followerFor(audio, sideAt(0)); // oldest insert
    const b = followerFor(audio, sideAt(0.01)); // second-oldest insert
    // Fill the cache to exactly the cap.
    for (let i = 2; i < FOLLOWER_MEMO_MAX; i++) {
      followerFor(audio, sideAt(i / 100));
    }
    // Touch `a` — under LRU this makes `b` the eviction candidate;
    // under FIFO `a` would still be first out.
    expect(followerFor(audio, sideAt(0))).toBe(a);
    followerFor(audio, sideAt(0.99)); // one insert → exactly one eviction
    expect(followerFor(audio, sideAt(0))).toBe(a); // refreshed → survives
    expect(followerFor(audio, sideAt(0.01))).not.toBe(b); // LRU → evicted
  });

  test("caches are independent per audio env", () => {
    const audioA = makeAudio();
    const audioB = makeAudio();
    const a = followerFor(audioA, sideAt(0.3));
    const b = followerFor(audioB, sideAt(0.3));
    expect(a).not.toBe(b);
    // Overflowing B's cache never evicts A's entries.
    for (let i = 1; i <= FOLLOWER_MEMO_MAX + 1; i++) {
      followerFor(audioB, sideAt(i / 200));
    }
    expect(followerFor(audioA, sideAt(0.3))).toBe(a);
  });
});
