/**
 * Reel sequence strip: members as duration-proportional blocks (block width
 * = its share of total runtime), so the shape of the final cut is honest.
 * Click selects (drives the preview); ← / → reorder; × removes.
 */
import type { ReelMember } from "../../local/reel/reel-store";
import { formatDuration } from "../ProgressBar";

export function ReelSequence({
  members,
  selectedMemberId,
  onSelect,
  onMove,
  onRemove,
}: {
  members: ReelMember[];
  selectedMemberId: string | null;
  onSelect: (memberId: string) => void;
  onMove: (memberId: string, delta: number) => void;
  onRemove: (memberId: string) => void;
}) {
  const total =
    members.reduce((a, m) => a + Math.max(0.001, m.trimOutS - m.trimInS), 0) ||
    1;

  return (
    <div className="flex items-stretch gap-1 h-20">
      {members.map((m, i) => {
        const dur = Math.max(0.001, m.trimOutS - m.trimInS);
        const w = (dur / total) * 100;
        const sel = m.memberId === selectedMemberId;
        return (
          <div
            key={m.memberId}
            onClick={() => onSelect(m.memberId)}
            style={{ width: `${w}%`, minWidth: 72 }}
            className={[
              "relative rounded-md overflow-hidden cursor-pointer border-2 group shrink-0",
              sel
                ? "border-hot"
                : m.missing
                  ? "border-danger/60"
                  : "border-rule hover:border-ink-2",
            ].join(" ")}
          >
            {m.posterUrl && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `url(${m.posterUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "left center",
                }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
            <span className="absolute top-1 left-1.5 font-mono text-[10px] tabular text-paper-hi/90">
              {i + 1}
            </span>
            <span className="absolute bottom-3 left-1.5 right-1.5 font-display text-[11px] font-semibold text-paper-hi truncate">
              {m.title}
            </span>
            <span className="absolute bottom-1 left-1.5 font-mono text-[9px] tabular text-paper-hi/70">
              {m.missing ? "missing" : formatDuration(dur)}
            </span>
            <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <SeqBtn label="Move left" disabled={i === 0} onClick={() => onMove(m.memberId, -1)}>
                ←
              </SeqBtn>
              <SeqBtn
                label="Move right"
                disabled={i === members.length - 1}
                onClick={() => onMove(m.memberId, 1)}
              >
                →
              </SeqBtn>
              <SeqBtn label="Remove" onClick={() => onRemove(m.memberId)}>
                ×
              </SeqBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SeqBtn({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="h-5 w-5 inline-flex items-center justify-center rounded bg-black/55 text-paper-hi text-xs leading-none hover:bg-black/80 disabled:opacity-30"
    >
      {children}
    </button>
  );
}
