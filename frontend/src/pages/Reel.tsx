import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { TrashIcon } from "../editor/components/icons";
import { formatDuration } from "../components/ProgressBar";
import { ExportControls } from "../editor/components/ExportPanel";
import { ReelPlayer, reelLayout } from "../components/reel/ReelPlayer";
import { ReelTimeline } from "../components/reel/ReelTimeline";
import { useReelStore, type ReelMember } from "../local/reel/reel-store";

export default function Reel() {
  const { id } = useParams<{ id: string }>();
  const loadReel = useReelStore((s) => s.loadReel);
  const reset = useReelStore((s) => s.reset);

  useEffect(() => {
    if (id) void loadReel(id);
    return () => reset();
  }, [id, loadReel, reset]);

  const members = useReelStore((s) => s.members);
  const title = useReelStore((s) => s.title);
  const exportSpec = useReelStore((s) => s.exportSpec);
  const render = useReelStore((s) => s.render);
  const setTitle = useReelStore((s) => s.setTitle);
  const setExport = useReelStore((s) => s.setExport);
  const moveMember = useReelStore((s) => s.moveMember);
  const removeMember = useReelStore((s) => s.removeMember);
  const startRender = useReelStore((s) => s.startRender);
  const totalDurationS = useReelStore((s) => s.totalDurationS);
  const selectedMemberId = useReelStore((s) => s.selectedMemberId);
  const selectMember = useReelStore((s) => s.selectMember);
  const setMemberViewport = useReelStore((s) => s.setMemberViewport);
  const resetMemberViewport = useReelStore((s) => s.resetMemberViewport);

  const [playheadS, setPlayheadS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  const stage =
    exportSpec.resolution && typeof exportSpec.resolution === "object"
      ? exportSpec.resolution
      : { w: 1920, h: 1080 };
  const renderable = members.filter((m) => !m.missing).length;
  const rendering = render.status === "running";

  function jumpToMember(memberId: string) {
    selectMember(memberId);
    const l = reelLayout(members).find((x) => x.member.memberId === memberId);
    if (l) setPlayheadS(l.start);
    setPlaying(false);
  }

  return (
    <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-rule bg-paper-hi">
        <div className="h-14 px-3 sm:px-5 flex items-center gap-3">
          <Link
            to="/jobs"
            className="font-mono text-[11px] tracking-label uppercase text-ink-2 hover:text-ink shrink-0"
          >
            ← Library
          </Link>
          <span className="font-display tracking-label uppercase text-[11px] text-ink-2 shrink-0">
            REEL
          </span>
          <input
            value={title ?? ""}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled reel"
            className="flex-1 min-w-0 bg-transparent font-display font-semibold text-lg text-ink outline-none placeholder:text-ink-2/50"
          />
          {render.status === "done" && render.resultUrl ? (
            <a href={render.resultUrl} download={`${title || "reel"}.mp4`}>
              <ChunkyButton variant="primary" size="md">
                Download MP4
              </ChunkyButton>
            </a>
          ) : (
            <ChunkyButton
              variant="primary"
              size="md"
              disabled={renderable < 1 || rendering}
              onClick={() => void startRender()}
            >
              {rendering ? `Rendering ${Math.round(render.pct)}%` : "Render reel"}
            </ChunkyButton>
          )}
        </div>
        {rendering && (
          <div className="h-1 bg-paper-deep">
            <div className="h-full bg-hot transition-all" style={{ width: `${render.pct}%` }} />
          </div>
        )}
        {render.status === "error" && (
          <p className="px-5 py-1.5 font-mono text-xs text-danger bg-danger/10">
            {render.error}
          </p>
        )}
      </header>

      {/* 3-column body */}
      <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)_clamp(360px,28vw,440px)]">
        {/* Left: ordered project list */}
        <aside className="border-r border-rule bg-paper-hi/50 overflow-y-auto p-3 flex flex-col gap-2">
          <span className="label">Projects · order</span>
          {members.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-2 mt-1">
              Empty — add projects from the Library.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {members.map((m, i) => (
                <MemberRow
                  key={m.memberId}
                  member={m}
                  index={i}
                  count={members.length}
                  selected={m.memberId === selectedMemberId}
                  onSelect={() => jumpToMember(m.memberId)}
                  onMove={(d) => moveMember(m.memberId, d)}
                  onRemove={() => removeMember(m.memberId)}
                />
              ))}
            </ol>
          )}
        </aside>

        {/* Middle: working player */}
        <section className="min-w-0 overflow-hidden flex items-center justify-center p-4 bg-paper-deep/40">
          <ReelPlayer
            members={members}
            stage={stage}
            playheadS={playheadS}
            playing={playing}
            muted={muted}
            onSeek={setPlayheadS}
            onPlayingChange={setPlaying}
            onFraming={setMemberViewport}
            onResetFraming={resetMemberViewport}
          />
        </section>

        {/* Right: render panel */}
        <aside className="border-l border-rule bg-paper-hi/60 overflow-y-auto p-4">
          <ExportControls
            spec={exportSpec}
            setExport={setExport}
            source={{ w: stage.w, h: stage.h, durationS: totalDurationS() }}
          />
        </aside>
      </div>

      {/* Bottom: full-width reel timeline */}
      <ReelTimeline
        members={members}
        playheadS={playheadS}
        playing={playing}
        muted={muted}
        selectedMemberId={selectedMemberId}
        onSeek={(s) => {
          setPlayheadS(s);
        }}
        onTogglePlay={() => members.length > 0 && setPlaying((p) => !p)}
        onToggleMute={() => setMuted((m) => !m)}
        onSelectMember={jumpToMember}
      />
    </div>
  );
}

function MemberRow({
  member,
  index,
  count,
  selected,
  onSelect,
  onMove,
  onRemove,
}: {
  member: ReelMember;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <li
      onClick={onSelect}
      className={[
        "group flex items-center gap-2 rounded-md p-1.5 cursor-pointer border transition-colors",
        member.missing
          ? "border-danger/60"
          : selected
            ? "border-hot bg-hot/5"
            : "border-rule hover:border-ink-2",
      ].join(" ")}
    >
      <span className="font-mono text-[10px] tabular text-ink-2 w-4 text-center shrink-0">
        {index + 1}
      </span>
      <div className="h-9 w-14 rounded bg-sunken overflow-hidden shrink-0">
        {member.posterUrl && (
          <div
            className="h-full w-full"
            style={{
              backgroundImage: `url(${member.posterUrl})`,
              backgroundSize: "cover",
              backgroundPosition: "left center",
            }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-display text-[12px] font-semibold text-ink truncate">
          {member.title}
        </div>
        <div className="font-mono text-[10px] tabular text-ink-2">
          {member.missing ? (
            <span className="text-danger">missing</span>
          ) : (
            formatDuration(member.fullDurationS)
          )}
        </div>
      </div>
      <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <RowBtn label="Up" disabled={index === 0} onClick={() => onMove(-1)}>
          ▲
        </RowBtn>
        <RowBtn label="Down" disabled={index === count - 1} onClick={() => onMove(1)}>
          ▼
        </RowBtn>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remove"
        className="h-6 w-6 inline-flex items-center justify-center rounded text-ink-2 hover:text-danger shrink-0 opacity-0 group-hover:opacity-100"
      >
        <TrashIcon width={13} height={13} />
      </button>
    </li>
  );
}

function RowBtn({
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
      className="h-3.5 w-5 inline-flex items-center justify-center text-[8px] text-ink-2 hover:text-ink disabled:opacity-25"
    >
      {children}
    </button>
  );
}
