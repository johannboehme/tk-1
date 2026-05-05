/**
 * CamFrameStream — async frame puller from a single video source with
 * GOP-aware random access.
 *
 * Wraps demux + WebCodecs `VideoDecoder` + a small in-memory queue so the
 * multi-cam render loop can ask for "the latest frame at or before sourceTimeUs"
 * across N cams without doing the chunk-feeding bookkeeping itself.
 *
 * Behavior:
 *  - Decoder runs ahead of consumer demand (with backpressure on
 *    `decodeQueueSize`).
 *  - `frameAtOrBefore(targetUs)` auto-seeks when the target jumps backwards
 *    or forwards by more than `SEEK_FORWARD_BUDGET_US`. Seek finds the
 *    last keyframe ≤ targetUs in the sample table, flushes the decoder,
 *    reconfigures, and resumes decoding from that keyframe.
 *  - Returned frames are owned by the stream; the caller must NOT call
 *    `.close()` on them. Older frames are auto-freed on the next call.
 *  - End-of-source returns the very last frame for any targetUs >= last
 *    frame's timestamp.
 *
 * Streaming-friendly: encoded chunks are pulled on demand via
 * `loadSample(idx)` which does a `Blob.slice` per sample. Bounded memory
 * regardless of source size: only one sample's bytes at a time plus
 * mp4box's parsed sample table (sub-MB even for hour-long recordings)
 * plus the decoder's pending queue.
 */
import {
  openVideoDemux,
  type DemuxedVideoStream,
  type SampleMeta,
} from "../codec/webcodecs/demux";

export class CamFrameStream {
  private decoder: VideoDecoder;
  private readonly demuxStream: DemuxedVideoStream;
  private readonly sampleTable: ReadonlyArray<SampleMeta>;
  private sampleIdx = 0;
  private samplesDone = false;
  private pending: VideoFrame[] = [];
  private decoderError: Error | null = null;
  private flushed = false;
  private newFrameWaiters: Array<() => void> = [];
  private lastTargetUs: number | null = null;
  /** Counter of seek operations — exposed for tests / diagnostics. */
  private seekCount = 0;

  /** A forward jump larger than this triggers an implicit seek. Smaller
   *  jumps are served by linear forward decode (cheaper than the
   *  reconfigure cost). 2 seconds is conservative for typical
   *  keyframe-every-1s sources. */
  static readonly SEEK_FORWARD_BUDGET_US = 2_000_000;

  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationS: number;

  static async create(source: Blob | ArrayBuffer): Promise<CamFrameStream> {
    const demux = await openVideoDemux(source);
    if (!demux) throw new Error("CamFrameStream: source has no video track");
    return new CamFrameStream(demux);
  }

  private constructor(demux: DemuxedVideoStream) {
    this.demuxStream = demux;
    this.sampleTable = demux.sampleTable;
    this.width = demux.info.width;
    this.height = demux.info.height;
    this.fps = demux.info.fps;
    this.durationS = demux.info.durationS;
    this.decoder = this.makeDecoder();
  }

  private makeDecoder(): VideoDecoder {
    const dec = new VideoDecoder({
      output: (f) => {
        this.pending.push(f);
        this.wake();
      },
      error: (e) => {
        this.decoderError = e instanceof Error ? e : new Error(String(e));
        this.wake();
      },
    });
    dec.configure({
      codec: this.demuxStream.info.codec,
      codedWidth: this.demuxStream.info.width,
      codedHeight: this.demuxStream.info.height,
      description: this.demuxStream.info.description,
    });
    return dec;
  }

  private wake() {
    const waiters = this.newFrameWaiters;
    this.newFrameWaiters = [];
    for (const w of waiters) w();
  }

  /** Find the index of the last keyframe with timestamp ≤ targetUs. If
   *  no keyframe is at-or-before, returns 0 (start from the very first
   *  keyframe — which by mp4 invariant is sample 0 of any well-formed
   *  track). */
  private findKeyframeAtOrBefore(targetUs: number): number {
    let bestKey = 0;
    for (let i = 0; i < this.sampleTable.length; i++) {
      const s = this.sampleTable[i];
      if (!s.isKey) continue;
      const tsUs = (s.cts * 1_000_000) / s.timescale;
      if (tsUs <= targetUs) {
        bestKey = i;
      } else {
        break;
      }
    }
    return bestKey;
  }

  /** Seek the underlying decoder to the last keyframe at or before
   *  `targetUs`. Discards pending frames, flushes the existing decoder,
   *  and reconfigures a fresh one. Subsequent `frameAtOrBefore` calls
   *  will resume from the chosen keyframe.
   *
   *  Cheap to call repeatedly — typical reconfigure overhead is
   *  ~5-50ms; the win comes from avoiding linear forward decode of
   *  potentially thousands of unused frames between current position
   *  and the seek target. */
  async seekTo(targetUs: number): Promise<void> {
    const keyIdx = this.findKeyframeAtOrBefore(targetUs);
    this.seekCount++;
    // Flush + close existing decoder. Flush may throw if the decoder is
    // already in error state; either way we replace it.
    try {
      await this.decoder.flush();
    } catch {
      /* decoder may already be in error or closed */
    }
    try {
      this.decoder.close();
    } catch {
      /* already closed */
    }
    // Drop any pending frames — they're from before the seek.
    for (const f of this.pending) {
      try {
        f.close();
      } catch {
        /* already closed */
      }
    }
    this.pending = [];
    // Fresh decoder — resets internal buffers, keyframe expectation, etc.
    this.decoder = this.makeDecoder();
    this.sampleIdx = keyIdx;
    this.samplesDone = false;
    this.flushed = false;
    this.decoderError = null;
  }

  async frameAtOrBefore(targetUs: number): Promise<VideoFrame | null> {
    // Auto-seek when the target jumps backwards or forwards beyond the
    // budget. Backward jumps require a seek (the linear stream cannot
    // serve them); large forward jumps are an optimisation — better to
    // pay the reconfigure cost once than decode thousands of unused
    // frames.
    if (this.lastTargetUs !== null) {
      const delta = targetUs - this.lastTargetUs;
      if (delta < 0 || delta > CamFrameStream.SEEK_FORWARD_BUDGET_US) {
        await this.seekTo(targetUs);
      }
    } else {
      // First call — if the target is well past the file start, seek to
      // avoid decoding from sample 0. The 2s budget applies vs. t=0.
      if (targetUs > CamFrameStream.SEEK_FORWARD_BUDGET_US) {
        await this.seekTo(targetUs);
      }
    }
    this.lastTargetUs = targetUs;

    while (true) {
      if (this.decoderError) throw this.decoderError;
      // Find the latest pending frame whose timestamp ≤ targetUs.
      this.pending.sort((a, b) => a.timestamp - b.timestamp);
      let bestIdx = -1;
      for (let i = 0; i < this.pending.length; i++) {
        if (this.pending[i].timestamp <= targetUs) bestIdx = i;
        else break;
      }
      const haveLater = this.pending.length > bestIdx + 1;
      // Confident in `bestIdx` if either we have a later frame queued
      // (so no earlier frame can still arrive ≤ targetUs from the decoder)
      // or the decoder is fully drained.
      if (bestIdx >= 0 && (haveLater || this.flushed)) {
        // Release older frames; keep `bestIdx` and anything after for later
        // calls (consecutive calls usually want the same or next frame).
        for (let i = 0; i < bestIdx; i++) {
          try {
            this.pending[i].close();
          } catch {
            /* already closed */
          }
        }
        this.pending = this.pending.slice(bestIdx);
        return this.pending[0];
      }
      // Need to decode more — pull samples from the table until we hit
      // backpressure on the decoder.
      if (!this.samplesDone) {
        while (
          !this.samplesDone &&
          this.decoder.decodeQueueSize < 6 &&
          this.sampleIdx < this.sampleTable.length
        ) {
          const idx = this.sampleIdx++;
          const c = await this.demuxStream.loadSample(idx);
          this.decoder.decode(
            new EncodedVideoChunk({
              type: c.isKey ? "key" : "delta",
              timestamp: c.timestampUs,
              duration: c.durationUs,
              data: c.data,
            }),
          );
          if (this.sampleIdx >= this.sampleTable.length) {
            this.samplesDone = true;
          }
        }
        // If we filled the queue without exhausting the table, fall
        // through to the wait below.
      } else if (!this.flushed) {
        await this.decoder.flush();
        this.flushed = true;
        continue;
      }
      // Still nothing — wait for the next output callback to wake us.
      if (this.flushed && bestIdx < 0) {
        // Decoder produced nothing useful — give up.
        return null;
      }
      await new Promise<void>((resolve) => this.newFrameWaiters.push(resolve));
    }
  }

  /** Total seeks performed (incl. auto-seeks). Test/diagnostic only. */
  get seeks(): number {
    return this.seekCount;
  }

  close(): void {
    for (const f of this.pending) {
      try {
        f.close();
      } catch {
        /* already closed */
      }
    }
    this.pending = [];
    try {
      this.decoder.close();
    } catch {
      /* already closed */
    }
    // Cancel the demuxer feeder so mp4box releases its buffers and the
    // file stream reader closes.
    void this.demuxStream.cancel();
  }
}
