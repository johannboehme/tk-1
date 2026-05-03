/**
 * "+ Add" entry for the editor: a TAKE-button-sized + key on the right
 * (visually aligned with the lane TAKE buttons below) plus a quiet MATCH
 * LED toggle to its left.
 *
 * The file picker accepts both video and image; per file:
 *   - image/*  → addImageToJob (MATCH toggle is irrelevant)
 *   - video/*  → addVideoToJob with skipSync = !matchAudio
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { addImageToJob, addVideoToJob } from "../../local/jobs";
import { pickVideoOrImageFiles } from "../../local/file-picker";
import { useEditorStore } from "../store";

interface Props {
  jobId: string;
  /** Compact mode for ~64 px lane-header columns on phones: drop the
   *  MATCH toggle (the user can't see what it does at this size; the
   *  default is on, which is what 99 % of users want). */
  compact?: boolean;
}

// Sized to align with the lane TAKE buttons (44 × 28 in the PROGRAM-strip
// row's 32 px height — 4 px taller would clip the bottom border).
const PLUS_W = 44;
const PLUS_H = 24;

export function AddMediaButton({ jobId, compact = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [matchAudio, setMatchAudio] = useState(true);
  const pushNotice = useEditorStore((s) => s.pushNotice);

  const onPick = async () => {
    setBusy(true);
    try {
      const picks = await pickVideoOrImageFiles({ multiple: true });
      if (picks.length === 0) {
        // user cancelled — nothing to do, no toast
        return;
      }
      let videoCount = 0;
      let imageCount = 0;
      for (const p of picks) {
        if (p.file.type.startsWith("image/")) {
          await addImageToJob(jobId, p);
          imageCount++;
        } else {
          await addVideoToJob(jobId, p, { skipSync: !matchAudio });
          videoCount++;
        }
      }
      const parts: string[] = [];
      if (videoCount > 0) {
        parts.push(`${videoCount} ${videoCount === 1 ? "clip" : "clips"}`);
      }
      if (imageCount > 0) {
        parts.push(`${imageCount} ${imageCount === 1 ? "image" : "images"}`);
      }
      pushNotice(`Added ${parts.join(" + ")}`);
    } catch (err) {
      pushNotice(err instanceof Error ? err.message : "Add failed");
    } finally {
      setBusy(false);
    }
  };

  // 64-px lane-header column on phones: MATCH shrinks to LED-only
  // (no "match" label) and + drops from 44 → 22 px so both fit
  // side-by-side with a 4 px gap. Wider viewports keep the labelled
  // MATCH chip and the full-width +.
  const plusW = compact ? 22 : PLUS_W;
  return (
    <div
      className={[
        "flex items-center w-full gap-1",
        compact ? "justify-center px-1" : "justify-between pl-2 pr-2",
      ].join(" ")}
      data-testid="add-media-bar"
    >
      <MatchTab
        on={matchAudio}
        onChange={setMatchAudio}
        disabled={busy}
        compact={compact}
      />

      <motion.button
        type="button"
        onClick={onPick}
        disabled={busy}
        whileTap={{ scale: 0.96 }}
        aria-label={busy ? "Adding media" : "Add media (video or image)"}
        title="Add media (video or image)"
        className="relative shrink-0 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          width: plusW,
          height: PLUS_H,
          transform: busy ? "translateY(1px)" : undefined,
        }}
        data-testid="add-media-button"
      >
        <span
          className="absolute inset-0 rounded-md flex items-center justify-center"
          style={PLUS_FACE}
        >
          <span
            className="font-mono font-semibold text-[15px] leading-none"
            style={{
              color: "#1A1816",
              textShadow: "0 1px 0 rgba(255,255,255,0.45)",
            }}
          >
            {busy ? "·" : "+"}
          </span>
        </span>
      </motion.button>

    </div>
  );
}

// Cassette-key face — paper-toned, embossed, similar to LaneHeader's TAKE
// when off-air. Uses inline style so we can mirror the tape-deck shading
// exactly without flooding the Tailwind config.
const PLUS_FACE: React.CSSProperties = {
  background: "linear-gradient(180deg, #FAF6EC 0%, #EFE7D2 100%)",
  border: "1px solid rgba(0,0,0,0.18)",
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.65)",
    "inset 0 -1px 0 rgba(0,0,0,0.10)",
    "0 1px 0 rgba(0,0,0,0.10)",
  ].join(", "),
};

/**
 * Quiet MATCH toggle — a clickable LED chip with a "match" label. Sits to
 * the left of the + so it reads as a *modifier* on the next add, not as
 * its own primary action. The on-state lights the LED orange and tints
 * the label; the off-state stays in muted ink-3.
 */
function MatchTab({
  on,
  onChange,
  disabled,
  compact = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`Match audio for incoming video clips: ${on ? "on" : "off"}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={
        on
          ? "MATCH on — incoming videos run the audio matcher (toggle for unsynced add)"
          : "MATCH off — incoming videos go in unsynced (toggle to enable matching)"
      }
      className={[
        "inline-flex items-center select-none rounded shrink-0",
        // Compact: a square LED chip — 22 × 24 with just the dot.
        // Wider viewports keep the labelled chip with the "match" caption.
        compact ? "justify-center px-1" : "gap-1 px-1.5",
        "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        "active:translate-y-[1px]",
      ].join(" ")}
      style={{
        height: PLUS_H,
        width: compact ? 22 : undefined,
        ...(on ? MATCH_ON : MATCH_OFF),
      }}
      data-testid="add-media-match-toggle"
    >
      <span
        aria-hidden
        className={`inline-block rounded-full shrink-0 ${compact ? "w-2 h-2" : "w-1.5 h-1.5"}`}
        style={{
          background: on ? "#FF5722" : "#9A8F80",
          boxShadow: on
            ? "0 0 4px rgba(255,87,34,0.9)"
            : "inset 0 0 0 0.5px rgba(0,0,0,0.18)",
          opacity: on ? 1 : 0.55,
        }}
      />
      {!compact && (
        <span
          className="font-display tracking-label uppercase text-[9px] font-semibold leading-none"
          style={{ color: on ? "#1A1816" : "#5C544A" }}
        >
          match
        </span>
      )}
    </button>
  );
}

// Cassette-key faces for the MATCH toggle, mirroring the + button's
// embossing so it reads as a button at a glance. The on-state lights
// the LED orange and tints the face slightly toward the hot palette;
// the off-state stays paper-neutral.
const MATCH_OFF: React.CSSProperties = {
  background: "linear-gradient(180deg, #FAF6EC 0%, #EFE7D2 100%)",
  border: "1px solid rgba(0,0,0,0.18)",
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.65)",
    "inset 0 -1px 0 rgba(0,0,0,0.10)",
  ].join(", "),
};

const MATCH_ON: React.CSSProperties = {
  background: "linear-gradient(180deg, #FFE3D6 0%, #FFD4BD 100%)",
  border: "1px solid rgba(255,87,34,0.55)",
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.7)",
    "inset 0 -1px 0 rgba(0,0,0,0.12)",
    "0 0 0 0.5px rgba(255,87,34,0.25)",
  ].join(", "),
};
