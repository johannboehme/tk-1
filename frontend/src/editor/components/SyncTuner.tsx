// The killer panel: knob + nudges + A/B + loop presets for live offset tuning.
// In multi-cam mode it follows whichever clip is selected in the Timeline,
// so each cam can be nudged independently. The same panel also handles the
// master-audio start nudge — selecting the audio waveform in the timeline
// flips this UI into MASTER_AUDIO_ID mode and the knob/buttons drive
// `audioStartNudgeS` on JobMeta instead of a clip's sync override.
//
// Pill-aware branch: when the user has a single pill selected (arr-mode,
// non-MATCH snap), the knob + nudge buttons drive that ONE pill's source
// offset instead of the whole cam — so a single chunk can be tuned without
// disturbing the rest of the take.
import { useEditorStore } from "../store";
import { isVideoClip, MASTER_AUDIO_ID } from "../types";
import { ChunkyButton } from "./ChunkyButton";
import { Knob } from "./Knob";
import { MonoReadout, formatMs } from "./MonoReadout";
import { SegmentedControl } from "./SegmentedControl";
import { AudioStartIcon, SyncIcon } from "./icons";

interface Props {
  lastSyncOverrideMs: number | null;
}

export function SyncTuner({ lastSyncOverrideMs }: Props) {
  const clips = useEditorStore((s) => s.clips);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setClipSyncOverride = useEditorStore((s) => s.setClipSyncOverride);
  const nudgeClipSyncOverride = useEditorStore((s) => s.nudgeClipSyncOverride);
  const selectedPillId = useEditorStore((s) => s.selectedPillId);
  const selectedPill = useEditorStore((s) =>
    s.selectedPillId
      ? (s.pills.find((p) => p.id === s.selectedPillId) ?? null)
      : null,
  );
  const pillIndexInCam = useEditorStore((s) => {
    if (!s.selectedPillId) return -1;
    const sp = s.pills.find((p) => p.id === s.selectedPillId);
    if (!sp) return -1;
    const camPills = s.pills
      .filter((p) => p.camId === sp.camId)
      .slice()
      .sort((a, b) => a.arrStartS - b.arrStartS);
    return camPills.findIndex((p) => p.id === sp.id);
  });
  const nudgePillSourceMs = useEditorStore((s) => s.nudgePillSourceMs);
  const setPillSourceOffsetMs = useEditorStore(
    (s) => s.setPillSourceOffsetMs,
  );
  const resetPill = useEditorStore((s) => s.resetPill);
  const abBypass = useEditorStore((s) => s.offset.abBypass);
  const setAbBypass = useEditorStore((s) => s.setAbBypass);
  // currentTime read imperatively in the loop-around-playhead handler
  // — subscribing would re-render this whole panel 60×/sec for nothing.
  const trim = useEditorStore((s) => s.trim);
  const setLoop = useEditorStore((s) => s.setLoop);
  const loop = useEditorStore((s) => s.playback.loop);
  const hasBpm = useEditorStore((s) => Boolean(s.jobMeta?.bpm));

  // Master-audio mode: selecting the audio strip in the timeline routes
  // the knob/nudges to JobMeta.audioStartNudgeS instead of a clip override.
  if (selectedClipId === MASTER_AUDIO_ID) {
    return <MasterAudioBranch />;
  }

  const found = clips.find((c) => c.id === selectedClipId) ?? null;
  // Sync tuner only operates on video clips; image clips have no sync.
  const selectedClip = found && isVideoClip(found) ? found : null;
  const selectedIdx = selectedClip
    ? clips.findIndex((c) => c.id === selectedClip.id)
    : -1;

  // Pill-mode = a pill is selected AND it belongs to the cam this panel
  // is currently tuning. Otherwise fall back to cam-level sync override.
  const pillMode =
    selectedPill !== null &&
    selectedClip !== null &&
    selectedPill.camId === selectedClip.id;
  const pillOffsetMs = pillMode
    ? Math.round(
        (selectedPill.sourceInS - selectedPill.originalSourceInS) * 1e6,
      ) / 1e3
    : 0;

  const algoMs = selectedClip?.syncOffsetMs ?? 0;
  const userOverrideMs = pillMode ? pillOffsetMs : (selectedClip?.syncOverrideMs ?? 0);
  const totalMs = abBypass ? algoMs : algoMs + userOverrideMs;

  function setLoopAroundPlayhead(seconds: number) {
    const t = useEditorStore.getState().playback.currentTime;
    const half = seconds / 2;
    const start = Math.max(trim.in, t - half);
    const end = Math.min(trim.out, start + seconds);
    setLoop({ start, end });
  }

  function nudgeWithHaptic(delta: number) {
    if (!selectedClip) return;
    if (pillMode && selectedPillId) {
      nudgePillSourceMs(selectedPillId, delta);
    } else {
      nudgeClipSyncOverride(selectedClip.id, delta);
    }
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        /* ignore */
      }
    }
  }

  function setOverride(ms: number) {
    if (!selectedClip) return;
    if (pillMode && selectedPillId) {
      setPillSourceOffsetMs(selectedPillId, ms);
    } else {
      setClipSyncOverride(selectedClip.id, ms);
    }
  }

  // Reset-to-last is a cam-level concept (carried across clips on a job).
  // Skip it in pill-mode — RESET on a pill goes back to its baseline via
  // resetPill, which is the only meaningful "previous" for a single chunk.
  const showResetToLast =
    !pillMode &&
    lastSyncOverrideMs !== null &&
    selectedClip !== null &&
    lastSyncOverrideMs !== userOverrideMs;

  return (
    <div className="flex flex-col gap-5">
      {/* On narrow phones the title and the A/B segmented control don't
       *  fit on one row (segments alone are ~210 px); stack them so the
       *  title can show in full instead of collapsing to "S...". */}
      <header className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2 text-ink min-w-0">
          <SyncIcon width={18} height={18} />
          <h2 className="font-display text-lg leading-none truncate">
            {selectedClip
              ? pillMode && pillIndexInCam >= 0
                ? `Sync · Cam ${selectedIdx + 1} · Chunk ${pillIndexInCam + 1}`
                : `Sync · Cam ${selectedIdx + 1}`
              : "Sync Tuner"}
          </h2>
        </div>
        <SegmentedControl
          value={abBypass ? "algo" : "override"}
          options={[
            { value: "algo", label: "A • ALGO" },
            { value: "override", label: "B • OVERRIDE" },
          ]}
          onChange={(v) => setAbBypass(v === "algo")}
          size="sm"
        />
      </header>

      {!selectedClip ? (
        <SelectClipHint
          clips={clips.filter(isVideoClip)}
          onPick={setSelectedClipId}
          hasBpm={hasBpm}
        />
      ) : (
        <>
          {/* Selected clip name */}
          <div
            className="rounded-md border border-rule px-3 py-2 flex items-center gap-2"
            style={{
              background: `linear-gradient(180deg, ${selectedClip.color}22 0%, ${selectedClip.color}11 100%)`,
              borderLeft: `4px solid ${selectedClip.color}`,
            }}
          >
            <span
              className="font-display font-semibold text-[11px] tracking-label uppercase"
              style={{ color: selectedClip.color }}
            >
              Cam {selectedIdx + 1}
            </span>
            <span className="font-mono text-[10px] text-ink-2 truncate">
              {selectedClip.filename}
            </span>
          </div>

          {/* Algo + Total readouts side-by-side */}
          <div className="grid grid-cols-2 gap-2">
            <MonoReadout
              label="ALGO"
              tone="muted"
              size="md"
              align="center"
              value={formatMs(algoMs)}
            />
            <MonoReadout
              label={abBypass ? "PLAYING (A)" : "TOTAL"}
              tone="hot"
              size="md"
              align="center"
              value={formatMs(totalMs)}
            />
          </div>

          {/* Knob */}
          <div className="flex flex-col items-center gap-2 py-2">
            <Knob
              label={pillMode ? "PILL OFFSET" : "USER OVERRIDE"}
              value={userOverrideMs}
              min={-2000}
              max={2000}
              step={0.5}
              pixelsPerRange={1400}
              onChange={(v) => setOverride(v)}
            />
            <MonoReadout
              tone="default"
              size="lg"
              align="center"
              className="w-44"
              value={formatMs(userOverrideMs)}
            />
            <span className="text-[10px] text-ink-3 font-mono tabular">
              drag • shift = fine • dbl-click = 0
            </span>
          </div>

          {/* Nudges */}
          <div className="flex flex-col gap-2">
            <span className="label">Nudge ms</span>
            <div className="grid grid-cols-6 gap-1.5">
              {[-100, -10, -1, 1, 10, 100].map((d) => (
                <ChunkyButton
                  key={d}
                  size="sm"
                  variant={d > 0 ? "primary" : "secondary"}
                  onClick={() => nudgeWithHaptic(d)}
                >
                  {d > 0 ? `+${d}` : d}
                </ChunkyButton>
              ))}
            </div>
          </div>

          {/* Loop region presets */}
          <div className="flex flex-col gap-2">
            <span className="label">Practice Loop</span>
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 2, 4].map((s) => (
                <ChunkyButton
                  key={s}
                  size="sm"
                  variant="secondary"
                  pressed={loop?.end !== undefined && Math.abs(loop.end - loop.start - s) < 0.05}
                  onClick={() => setLoopAroundPlayhead(s)}
                >
                  {s}s
                </ChunkyButton>
              ))}
              <ChunkyButton
                size="sm"
                variant="ghost"
                disabled={!loop}
                onClick={() => setLoop(null)}
              >
                CLEAR
              </ChunkyButton>
            </div>
          </div>

          {/* Resets */}
          <div className="grid grid-cols-2 gap-1.5">
            <ChunkyButton
              variant="ghost"
              size="sm"
              onClick={() => {
                if (pillMode && selectedPillId) resetPill(selectedPillId);
                else setOverride(0);
              }}
              disabled={userOverrideMs === 0}
            >
              {pillMode ? "RESET PILL" : "RESET TO ALGO"}
            </ChunkyButton>
            {showResetToLast && (
              <ChunkyButton
                variant="ghost"
                size="sm"
                onClick={() => setOverride(lastSyncOverrideMs ?? 0)}
              >
                USE LAST ({formatMs(lastSyncOverrideMs ?? 0, false).trim()})
              </ChunkyButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Empty state shown when the user hasn't picked a clip in the Timeline.
 * Lists every cam as a quick-pick chip — plus a Master-Audio chip when
 * BPM analysis ran, since the audio start can be nudged the same way.
 */
function SelectClipHint({
  clips,
  onPick,
  hasBpm,
}: {
  clips: ReturnType<typeof useEditorStore.getState>["clips"];
  onPick: (id: string) => void;
  hasBpm: boolean;
}) {
  if (clips.length === 0 && !hasBpm) {
    return (
      <div className="rounded-md border border-dashed border-rule px-4 py-6 text-center">
        <p className="font-mono text-xs text-ink-2 leading-relaxed">
          No video clips with sync data — only video cams that ran the
          audio matcher show up here.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-rule px-4 py-4 flex flex-col gap-3">
      <p className="font-mono text-xs text-ink-2 leading-relaxed text-center">
        Pick a track to tune — or tap one here:
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {hasBpm && (
          <button
            key={MASTER_AUDIO_ID}
            type="button"
            onClick={() => onPick(MASTER_AUDIO_ID)}
            className="font-display tracking-label uppercase text-[10px] rounded-md border border-rule bg-paper-hi px-2.5 py-1.5 hover:bg-paper-deep transition-colors flex items-center gap-1.5"
            style={{ borderLeftColor: "#FF6B00", borderLeftWidth: 3 }}
          >
            <AudioStartIcon width={10} height={10} />
            Master Audio
          </button>
        )}
        {clips.map((c) => {
          // Strip "cam-" prefix to keep the label in sync with the
          // timeline lane labels (which use the master cam index, not
          // the filtered position).
          const label = c.id.startsWith("cam-")
            ? `Cam ${c.id.slice(4)}`
            : c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              className="font-display tracking-label uppercase text-[10px] rounded-md border border-rule bg-paper-hi px-2.5 py-1.5 hover:bg-paper-deep transition-colors flex items-center gap-1.5"
              style={{ borderLeftColor: c.color, borderLeftWidth: 3 }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: c.color }}
              />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Master-audio nudge sub-panel — same controls layout as the cam-clip
 * branch, but the knob/nudges drive `audioStartNudgeS` (in seconds, signed)
 * on JobMeta. ALGO is fixed at 0 — the analyzer's auto-detected start is
 * the baseline; the override is a pure user-correction delta.
 *
 * No A/B bypass in v1: the same comparison is reachable by tapping
 * RESET TO ALGO and then re-applying the saved last-nudge if needed.
 */
function MasterAudioBranch() {
  const audioNudgeS = useEditorStore(
    (s) => s.jobMeta?.audioStartNudgeS ?? 0,
  );
  const setAudioStartNudgeS = useEditorStore((s) => s.setAudioStartNudgeS);
  const nudgeAudioStartMs = useEditorStore((s) => s.nudgeAudioStartMs);
  // currentTime read imperatively in setLoopAroundPlayhead.
  const trim = useEditorStore((s) => s.trim);
  const setLoop = useEditorStore((s) => s.setLoop);
  const loop = useEditorStore((s) => s.playback.loop);

  const audioNudgeMs = audioNudgeS * 1000;

  function setLoopAroundPlayhead(seconds: number) {
    const t = useEditorStore.getState().playback.currentTime;
    const half = seconds / 2;
    const start = Math.max(trim.in, t - half);
    const end = Math.min(trim.out, start + seconds);
    setLoop({ start, end });
  }

  function nudgeWithHaptic(deltaMs: number) {
    nudgeAudioStartMs(deltaMs);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-ink min-w-0">
          <SyncIcon width={18} height={18} />
          <h2 className="font-display text-lg leading-none truncate">
            Sync · Master Audio
          </h2>
        </div>
      </header>

      {/* Track strip — neutral hot-orange to set master-audio apart from cam colours. */}
      <div
        className="rounded-md border border-rule px-3 py-2 flex items-center gap-2"
        style={{
          background:
            "linear-gradient(180deg, #FF6B0022 0%, #FF6B0011 100%)",
          borderLeft: "4px solid #FF6B00",
        }}
      >
        <AudioStartIcon width={12} height={12} />
        <span
          className="font-display font-semibold text-[11px] tracking-label uppercase"
          style={{ color: "#FF6B00" }}
        >
          Master Audio
        </span>
        <span className="font-mono text-[10px] text-ink-2 truncate">
          beat-grid anchor
        </span>
      </div>

      {/* Algo + Total readouts side-by-side. ALGO=0 because the analyzer
          auto-detection is the baseline; the nudge is a pure delta. */}
      <div className="grid grid-cols-2 gap-2">
        <MonoReadout
          label="ALGO"
          tone="muted"
          size="md"
          align="center"
          value={formatMs(0)}
        />
        <MonoReadout
          label="TOTAL"
          tone="hot"
          size="md"
          align="center"
          value={formatMs(audioNudgeMs)}
        />
      </div>

      {/* Knob */}
      <div className="flex flex-col items-center gap-2 py-2">
        <Knob
          label="USER OVERRIDE"
          value={audioNudgeMs}
          min={-2000}
          max={2000}
          step={0.5}
          pixelsPerRange={1400}
          onChange={(v) => setAudioStartNudgeS(v / 1000)}
        />
        <MonoReadout
          tone="default"
          size="lg"
          align="center"
          className="w-44"
          value={formatMs(audioNudgeMs)}
        />
        <span className="text-[10px] text-ink-3 font-mono tabular">
          drag • shift = fine • dbl-click = 0
        </span>
      </div>

      {/* Nudges */}
      <div className="flex flex-col gap-2">
        <span className="label">Nudge ms</span>
        <div className="grid grid-cols-6 gap-1.5">
          {[-100, -10, -1, 1, 10, 100].map((d) => (
            <ChunkyButton
              key={d}
              size="sm"
              variant={d > 0 ? "primary" : "secondary"}
              onClick={() => nudgeWithHaptic(d)}
            >
              {d > 0 ? `+${d}` : d}
            </ChunkyButton>
          ))}
        </div>
      </div>

      {/* Loop region presets */}
      <div className="flex flex-col gap-2">
        <span className="label">Practice Loop</span>
        <div className="grid grid-cols-4 gap-1.5">
          {[1, 2, 4].map((s) => (
            <ChunkyButton
              key={s}
              size="sm"
              variant="secondary"
              pressed={
                loop?.end !== undefined &&
                Math.abs(loop.end - loop.start - s) < 0.05
              }
              onClick={() => setLoopAroundPlayhead(s)}
            >
              {s}s
            </ChunkyButton>
          ))}
          <ChunkyButton
            size="sm"
            variant="ghost"
            disabled={!loop}
            onClick={() => setLoop(null)}
          >
            CLEAR
          </ChunkyButton>
        </div>
      </div>

      {/* Reset */}
      <div className="grid grid-cols-1 gap-1.5">
        <ChunkyButton
          variant="ghost"
          size="sm"
          onClick={() => setAudioStartNudgeS(0)}
          disabled={audioNudgeMs === 0}
        >
          RESET TO ALGO
        </ChunkyButton>
      </div>
    </div>
  );
}
