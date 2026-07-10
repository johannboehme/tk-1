import { describe, it, expect } from "vitest";
import { synthesizeDemoVideo } from "./demo-video";
import { renderDemoSongPcm, type DemoSongSpec } from "./demo-song";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import { decodeAudioToMonoPcm } from "../codec/webcodecs/audio-decode";

/** Tiny song so the test encodes fast: 1 bar at 120 BPM = 2 s. */
const TINY_SONG: DemoSongSpec = {
  bpm: 120,
  beatsPerBar: 4,
  bars: 1,
  sampleRate: 44100,
};

describe("synthesizeDemoVideo (real Chromium WebCodecs + mp4-muxer)", () => {
  it("produces a demuxable MP4 whose audio is the song slice at the cam offset", async () => {
    const songPcm = renderDemoSongPcm(TINY_SONG);
    const startS = 0.5;
    const durationS = 1.5;

    const file = await synthesizeDemoVideo({
      spec: {
        label: "CAM T",
        filename: "demo-cam-t.mp4",
        songStartS: startS,
        theme: { bg: "#1a1816", accent: "#ff4d00", ink: "#f2ede2" },
      },
      durationS,
      songPcm,
      sampleRate: TINY_SONG.sampleRate,
      bpm: TINY_SONG.bpm,
      width: 320,
      height: 180,
      fps: 12,
    });

    expect(file.name).toBe("demo-cam-t.mp4");
    expect(file.type).toBe("video/mp4");
    expect(file.size).toBeGreaterThan(1000);

    // Video track parses with the requested geometry/duration.
    const video = await demuxVideoTrack(file);
    expect(video).not.toBeNull();
    expect(video!.info.width).toBe(320);
    expect(video!.info.height).toBe(180);
    expect(video!.info.durationS).toBeGreaterThan(durationS - 0.3);
    expect(video!.info.durationS).toBeLessThan(durationS + 0.3);

    // Audio track decodes — this is what the sync pipeline reads.
    const audio = await decodeAudioToMonoPcm(file, 22050);
    expect(audio.pcm.length).toBeGreaterThan(22050 * (durationS - 0.3));
    expect(audio.pcm.length).toBeLessThan(22050 * (durationS + 0.3));
    let sumSq = 0;
    for (let i = 0; i < audio.pcm.length; i++) sumSq += audio.pcm[i] * audio.pcm[i];
    const rms = Math.sqrt(sumSq / audio.pcm.length);
    expect(rms).toBeGreaterThan(0.02); // audibly non-silent

    // The cam's audio must line up with the song at the cam's offset:
    // cross-correlate the decoded track against the song slice. AAC
    // priming shifts the decoded audio by a few tens of ms, so we scan
    // for the correlation peak and require it (a) close to zero lag and
    // (b) far stronger than the correlation a quarter-second off.
    const sr = 22050;
    const sliceStart = Math.round(startS * TINY_SONG.sampleRate);
    const ratio = TINY_SONG.sampleRate / sr;
    const n = Math.min(audio.pcm.length, Math.floor((songPcm.length - sliceStart) / ratio));
    const corrAt = (lagSamples: number): number => {
      let acc = 0;
      let count = 0;
      for (let i = Math.max(0, -lagSamples); i < n; i += 3) {
        const j = sliceStart + Math.round((i + lagSamples) * ratio);
        if (j < 0 || j >= songPcm.length) continue;
        acc += audio.pcm[i] * songPcm[j];
        count++;
      }
      return count > 0 ? acc / count : 0;
    };
    let bestLag = 0;
    let bestCorr = -Infinity;
    const scanMax = Math.round(0.12 * sr);
    const step = Math.round(0.002 * sr);
    for (let lag = -scanMax; lag <= scanMax; lag += step) {
      const c = corrAt(lag);
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    const atOff = Math.max(
      Math.abs(corrAt(Math.round(0.25 * sr))),
      Math.abs(corrAt(-Math.round(0.25 * sr))),
    );
    expect(bestCorr).toBeGreaterThan(0);
    expect(Math.abs(bestLag / sr)).toBeLessThan(0.12); // near true alignment
    expect(bestCorr).toBeGreaterThan(atOff * 1.5);
  }, 60_000);
});
