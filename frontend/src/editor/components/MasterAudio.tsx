/**
 * Owns the master `<audio>` elements. Drives the editor's master clock
 * via `useAudioMaster` — every cam in the preview is a passive slave
 * of the store's `playback.currentTime`.
 *
 * Two `<audio>` elements with the same `src` are mounted: the hook
 * uses one as the audible "active" side and the other as a hot-spare
 * pre-parked at `loop.start`. At loop-wrap the WebAudio gain ramps
 * crossfade between them — gapless, sample-accurate on the audio
 * render thread. See `useAudioMaster.ts` for the full design.
 *
 * Visually invisible (display:none). Both elements are only here for
 * the decode + playback pipeline; the user listens to the WebAudio
 * graph's masterGain → destination output.
 */
import { useRef } from "react";
import { useAudioMaster } from "../useAudioMaster";

interface Props {
  audioUrl: string;
}

export function MasterAudio({ audioUrl }: Props) {
  const refA = useRef<HTMLAudioElement>(null);
  const refB = useRef<HTMLAudioElement>(null);
  const handle = useAudioMaster({ a: refA, b: refB }, audioUrl);
  return (
    <>
      <audio
        ref={refA}
        src={audioUrl}
        preload="auto"
        crossOrigin="anonymous"
        data-testid="master-audio"
        style={{ display: "none" }}
      />
      <audio
        ref={refB}
        src={audioUrl}
        preload="auto"
        crossOrigin="anonymous"
        data-testid="master-audio-b"
        style={{ display: "none" }}
      />
      {!handle.isReady && (
        // z-10: the compositor canvas is a LATER sibling inside the same
        // stacking context, so without an explicit z-index it paints over
        // this overlay and the decoding/error state is invisible — on a
        // stuck load the stage just looks black with a live transport.
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-sunken/90 text-paper-hi pointer-events-none">
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            {!handle.error && (
              <div className="h-2 w-32 rounded-full bg-sunken-soft overflow-hidden">
                <div className="h-full w-1/3 bg-hot animate-pulse" />
              </div>
            )}
            <span className="font-mono text-xs text-paper-hi/70 tracking-label uppercase">
              Decoding studio audio
            </span>
            {handle.error && (
              <span className="font-mono text-xs text-danger">
                {handle.error}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
