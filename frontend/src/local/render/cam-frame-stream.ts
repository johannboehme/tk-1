/**
 * CamFrameStream — async frame puller from a single video source.
 *
 * Wraps demux + WebCodecs `VideoDecoder` + a small in-memory queue so the
 * multi-cam render loop can ask for "the latest frame at or before sourceTimeUs"
 * across N cams without doing the chunk-feeding bookkeeping itself.
 *
 * Behavior:
 *  - Decoder runs ahead of consumer demand (with backpressure on
 *    `decodeQueueSize`).
 *  - Calls to `frameAtOrBefore(targetUs)` are monotonic per cam — the loop
 *    walks the master timeline forward, so each cam sees forward-only
 *    timestamps. Older frames are released as we advance.
 *  - Returned frames are owned by the stream; the caller must NOT call
 *    `.close()` on them. Older frames are auto-freed on the next call.
 *  - End-of-source returns the very last frame for any targetUs >= last
 *    frame's timestamp.
 *
 * Streaming-friendly: encoded chunks are pulled from the demuxer's
 * AsyncIterable on demand, not materialised up-front, so the source
 * file's encoded bytes are only ever resident in the mp4box internal
 * state (released as we drain) plus the decoder's pending queue.
 */
import {
  openVideoDemux,
  type DemuxedVideoStream,
  type VideoChunk,
} from "../codec/webcodecs/demux";

export class CamFrameStream {
  private decoder: VideoDecoder;
  private readonly demuxStream: DemuxedVideoStream;
  private readonly samplesIter: AsyncIterator<VideoChunk>;
  private samplesDone = false;
  private pending: VideoFrame[] = [];
  private decoderError: Error | null = null;
  private flushed = false;
  private newFrameWaiters: Array<() => void> = [];

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
    this.samplesIter = demux.samples[Symbol.asyncIterator]();
    this.width = demux.info.width;
    this.height = demux.info.height;
    this.fps = demux.info.fps;
    this.durationS = demux.info.durationS;
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.pending.push(f);
        this.wake();
      },
      error: (e) => {
        this.decoderError = e instanceof Error ? e : new Error(String(e));
        this.wake();
      },
    });
    this.decoder.configure({
      codec: demux.info.codec,
      codedWidth: demux.info.width,
      codedHeight: demux.info.height,
      description: demux.info.description,
    });
  }

  private wake() {
    const waiters = this.newFrameWaiters;
    this.newFrameWaiters = [];
    for (const w of waiters) w();
  }

  async frameAtOrBefore(targetUs: number): Promise<VideoFrame | null> {
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
      // Need to decode more — pull chunks from the demuxer until we hit
      // backpressure on the decoder.
      if (!this.samplesDone) {
        while (
          !this.samplesDone &&
          this.decoder.decodeQueueSize < 6
        ) {
          const r = await this.samplesIter.next();
          if (r.done) {
            this.samplesDone = true;
            break;
          }
          const c = r.value;
          this.decoder.decode(
            new EncodedVideoChunk({
              type: c.isKey ? "key" : "delta",
              timestamp: c.timestampUs,
              duration: c.durationUs,
              data: c.data,
            }),
          );
        }
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
