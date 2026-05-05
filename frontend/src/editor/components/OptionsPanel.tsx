/**
 * Options-Panel — clip-wide settings for whatever the timeline has selected.
 *
 * Routing mirrors SyncTuner:
 *   - selectedClipId === null            → hint
 *   - selectedClipId === MASTER_AUDIO_ID → master-audio volume
 *   - clip is video                      → rotation + flip
 *   - clip is image                      → rotation + flip
 *
 * Settings are global to a clip (no time-range), so the panel mutates the
 * clip directly via setClipRotation / setClipFlip / resetClipTransform —
 * NOT through the FX system. They're picked up live by the preview
 * (the Compositor's WebGL2 backend applies it via uvMatrix) and baked identically into the
 * render pipeline (compositor.compositeImage).
 */
import { useEditorStore } from "../store";
import {
  isImageClip,
  MASTER_AUDIO_ID,
  normaliseRotation,
  type Clip,
  type ImageClip,
  type VideoClip,
} from "../types";
import { ChunkyButton } from "./ChunkyButton";
import { Knob } from "./Knob";
import { MonoReadout } from "./MonoReadout";
import {
  FlipHIcon,
  FlipVIcon,
  ImageIcon,
  RotateCwIcon,
  VideoClipIcon,
  VolumeIcon,
} from "./icons";

export function OptionsPanel() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const clips = useEditorStore((s) => s.clips);

  if (selectedClipId === MASTER_AUDIO_ID) {
    return <MasterAudioOptions />;
  }
  const clip = clips.find((c) => c.id === selectedClipId) ?? null;
  if (!clip) {
    return <SelectionHint />;
  }
  return <ClipOptions clip={clip} />;
}

function SelectionHint() {
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h2 className="font-display text-lg leading-none">Options</h2>
        <p className="text-xs text-ink-2 mt-1">
          Pick a lane in the timeline to tweak its options.
        </p>
      </header>
      <div className="rounded-md border border-rule border-dashed bg-paper-deep px-3 py-6 text-center">
        <p className="text-xs text-ink-3">
          Click a cam tape, image clip or the master-audio waveform.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ clip options ----------------------------- */

interface ClipOptionsProps {
  clip: Clip;
}

function ClipOptions({ clip }: ClipOptionsProps) {
  const setRotation = useEditorStore((s) => s.setClipRotation);
  const setFlip = useEditorStore((s) => s.setClipFlip);
  const resetTransform = useEditorStore((s) => s.resetClipTransform);
  const clips = useEditorStore((s) => s.clips);
  const camIdx = clips.findIndex((c) => c.id === clip.id);

  const rot = normaliseRotation(clip.rotation);
  const flipX = !!clip.flipX;
  const flipY = !!clip.flipY;
  const isImage = isImageClip(clip);
  const transformDirty = rot !== 0 || flipX || flipY;

  return (
    <div className="flex flex-col gap-5">
      <ClipHeader clip={clip} camIdx={camIdx} />

      <SelectedPillSection clipId={clip.id} />

      <section className="flex flex-col gap-2">
        <div className="label flex items-center gap-1.5">
          <RotateCwIcon width={12} height={12} />
          Rotation
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              { v: 0, label: "0°" },
              { v: 90, label: "90°" },
              { v: 180, label: "180°" },
              { v: 270, label: "270°" },
            ] as const
          ).map((opt) => {
            const active = rot === opt.v;
            return (
              <ChunkyButton
                key={opt.v}
                variant={active ? "primary" : "secondary"}
                size="sm"
                pressed={active}
                onClick={() => setRotation(clip.id, opt.v)}
                aria-pressed={active}
              >
                {opt.label}
              </ChunkyButton>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="label">Flip</div>
        <div className="grid grid-cols-2 gap-1.5">
          <ChunkyButton
            variant={flipX ? "primary" : "secondary"}
            size="md"
            pressed={flipX}
            iconLeft={<FlipHIcon />}
            onClick={() => setFlip(clip.id, "x", !flipX)}
            aria-pressed={flipX}
          >
            Horizontal
          </ChunkyButton>
          <ChunkyButton
            variant={flipY ? "primary" : "secondary"}
            size="md"
            pressed={flipY}
            iconLeft={<FlipVIcon />}
            onClick={() => setFlip(clip.id, "y", !flipY)}
            aria-pressed={flipY}
          >
            Vertical
          </ChunkyButton>
        </div>
      </section>

      {!isImage && <VideoClipMeta clip={clip as VideoClip} />}
      {isImage && <ImageClipMeta clip={clip as ImageClip} />}

      <ChunkyButton
        variant="ghost"
        size="sm"
        disabled={!transformDirty}
        onClick={() => resetTransform(clip.id)}
      >
        Reset transform
      </ChunkyButton>
    </div>
  );
}

/**
 * Per-pill controls. Visible only when the user has a pill selected on
 * the cam currently shown by this panel — which is the common case
 * since pill-click sets both `selectedPillId` AND `selectedClipId`.
 *
 * The section reads the pill's current arr/source bounds against its
 * stored originals; the RESET button is enabled iff at least one of the
 * four fields has been moved off its baseline. RESET pushes a history
 * snapshot so the gesture can be undone the same way as a drag.
 *
 * The cam-track nudge (= "shift every pill of this cam in lockstep")
 * lives in the SyncTuner panel's Nudge row already, where the user is
 * adjusting cam-master alignment anyway.
 */
function SelectedPillSection({ clipId }: { clipId: string }) {
  const selectedPillId = useEditorStore((s) => s.selectedPillId);
  const pill = useEditorStore((s) =>
    s.pills.find((p) => p.id === selectedPillId) ?? null,
  );
  const commitPillEdit = useEditorStore((s) => s.commitPillEdit);
  const resetPill = useEditorStore((s) => s.resetPill);
  if (!pill || pill.camId !== clipId) return null;
  const dirty =
    Math.abs(pill.arrStartS - pill.originalArrStartS) > 1e-3 ||
    Math.abs(pill.arrEndS - pill.originalArrEndS) > 1e-3 ||
    Math.abs(pill.sourceInS - pill.originalSourceInS) > 1e-3 ||
    Math.abs(pill.sourceOutS - pill.originalSourceOutS) > 1e-3;
  return (
    <section className="flex flex-col gap-2 rounded-md border border-rule px-3 py-2 bg-paper-deep">
      <div className="label">Selected pill</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular font-mono">
        <span className="text-ink-3">arr</span>
        <span className="text-ink">
          {pill.arrStartS.toFixed(3)}s — {pill.arrEndS.toFixed(3)}s
        </span>
        <span className="text-ink-3">source</span>
        <span className="text-ink">
          {pill.sourceInS.toFixed(3)}s — {pill.sourceOutS.toFixed(3)}s
        </span>
      </div>
      <ChunkyButton
        variant="ghost"
        size="sm"
        disabled={!dirty}
        onClick={() => {
          commitPillEdit();
          resetPill(pill.id);
        }}
        title="Restore the pill to its auto-generated arr-time + source-trim defaults"
      >
        Reset pill
      </ChunkyButton>
    </section>
  );
}

function ClipHeader({ clip, camIdx }: { clip: Clip; camIdx: number }) {
  const isImage = isImageClip(clip);
  const camLabel = camIdx >= 0 ? `${isImage ? "Image" : "Cam"} ${camIdx + 1}` : clip.filename;
  const Icon = isImage ? ImageIcon : VideoClipIcon;
  return (
    <header
      className="rounded-md border border-rule px-3 py-2 flex items-center gap-2"
      style={{
        background: `linear-gradient(180deg, ${clip.color}22 0%, ${clip.color}11 100%)`,
        borderLeft: `4px solid ${clip.color}`,
      }}
    >
      <Icon width={16} height={16} style={{ color: clip.color }} />
      <span
        className="font-display font-semibold text-[11px] tracking-label uppercase truncate"
        style={{ color: clip.color }}
      >
        {camLabel}
      </span>
      <span className="ml-auto text-[10px] text-ink-3 font-mono uppercase truncate max-w-[120px]">
        {clip.filename}
      </span>
    </header>
  );
}

function VideoClipMeta({ clip }: { clip: VideoClip }) {
  const w = clip.displayW;
  const h = clip.displayH;
  if (!w || !h) return null;
  const rot = normaliseRotation(clip.rotation);
  const eff = rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
  return (
    <div className="grid grid-cols-2 gap-2">
      <MonoReadout
        label="Source"
        size="sm"
        align="center"
        tone="muted"
        value={`${w}×${h}`}
      />
      <MonoReadout
        label="Output"
        size="sm"
        align="center"
        tone={rot === 0 ? "muted" : "hot"}
        value={`${eff.w}×${eff.h}`}
      />
    </div>
  );
}

function ImageClipMeta({ clip }: { clip: ImageClip }) {
  const w = clip.displayW;
  const h = clip.displayH;
  if (!w || !h) return null;
  const rot = normaliseRotation(clip.rotation);
  const eff = rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
  return (
    <div className="grid grid-cols-2 gap-2">
      <MonoReadout
        label="Source"
        size="sm"
        align="center"
        tone="muted"
        value={`${w}×${h}`}
      />
      <MonoReadout
        label="Output"
        size="sm"
        align="center"
        tone={rot === 0 ? "muted" : "hot"}
        value={`${eff.w}×${eff.h}`}
      />
    </div>
  );
}

/* --------------------------- master-audio options ------------------------ */

function MasterAudioOptions() {
  const audioVolume = useEditorStore((s) => s.audioVolume);
  const setVolume = useEditorStore((s) => s.setMasterAudioVolume);
  const muted = audioVolume === 0;

  // Display gain as both linear (× factor) and dB. dB is what audio
  // engineers reach for; the linear factor is what the renderer multiplies
  // by, so we show both.
  const dB = audioVolume <= 0 ? "-∞" : (20 * Math.log10(audioVolume)).toFixed(1);

  return (
    <div className="flex flex-col gap-5">
      <header
        className="rounded-md border border-rule px-3 py-2 flex items-center gap-2"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,87,34,0.12) 0%, rgba(255,87,34,0.04) 100%)",
          borderLeft: "4px solid #FF5722",
        }}
      >
        <VolumeIcon width={16} height={16} className="text-hot" />
        <span className="font-display font-semibold text-[11px] tracking-label uppercase text-hot">
          Master Audio
        </span>
      </header>

      <section className="flex flex-col gap-3 items-center">
        <div className="label flex items-center gap-1.5">
          <VolumeIcon width={12} height={12} />
          Volume
        </div>
        <Knob
          value={audioVolume}
          min={0}
          max={2}
          step={0.01}
          pixelsPerRange={400}
          onChange={setVolume}
          size={140}
          label="VOL"
        />
        <div className="grid grid-cols-2 gap-2 w-full">
          <MonoReadout
            label="Gain"
            tone={muted ? "muted" : "default"}
            size="md"
            align="center"
            value={`${audioVolume.toFixed(2)}×`}
          />
          <MonoReadout
            label="dB"
            tone={muted ? "muted" : "hot"}
            size="md"
            align="center"
            value={`${dB} dB`}
          />
        </div>
      </section>

      <div className="grid grid-cols-3 gap-1.5">
        <ChunkyButton
          variant={muted ? "primary" : "secondary"}
          size="sm"
          pressed={muted}
          onClick={() => setVolume(muted ? 1 : 0)}
        >
          {muted ? "Unmute" : "Mute"}
        </ChunkyButton>
        <ChunkyButton variant="secondary" size="sm" onClick={() => setVolume(1)}>
          Unity
        </ChunkyButton>
        <ChunkyButton variant="secondary" size="sm" onClick={() => setVolume(2)}>
          +6 dB
        </ChunkyButton>
      </div>
    </div>
  );
}

