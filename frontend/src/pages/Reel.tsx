import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { MonoReadout } from "../editor/components/MonoReadout";
import { ExportControls } from "../editor/components/ExportPanel";
import { formatDuration } from "../components/ProgressBar";
import { ReelStage } from "../components/reel/ReelStage";
import { ReelScrubber } from "../components/reel/ReelScrubber";
import { ReelSequence } from "../components/reel/ReelSequence";
import { useReelStore } from "../local/reel/reel-store";

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
  const selected = members.find((m) => m.memberId === selectedMemberId) ?? null;

  const [formatOpen, setFormatOpen] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  // Reset the frame scrubber when switching members.
  useEffect(() => {
    setScrubTime(0);
  }, [selectedMemberId]);

  const stage =
    exportSpec.resolution && typeof exportSpec.resolution === "object"
      ? exportSpec.resolution
      : { w: 1920, h: 1080 };
  const renderable = members.filter((m) => !m.missing).length;
  const rendering = render.status === "running";

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
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <MonoReadout label="CLIPS" value={String(members.length).padStart(2, "0")} />
            <MonoReadout label="TOTAL" value={formatDuration(totalDurationS())} />
            <MonoReadout label="STAGE" value={`${stage.w}×${stage.h}`} />
          </div>
          <ChunkyButton
            variant={formatOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFormatOpen((o) => !o)}
          >
            Format {formatOpen ? "▴" : "▾"}
          </ChunkyButton>
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
            <div
              className="h-full bg-hot transition-all"
              style={{ width: `${render.pct}%` }}
            />
          </div>
        )}
        {render.status === "error" && (
          <p className="px-5 py-1.5 font-mono text-xs text-danger bg-danger/10">
            {render.error}
          </p>
        )}
      </header>

      {/* Collapsible output-format bar */}
      {formatOpen && (
        <div className="shrink-0 border-b border-rule bg-paper-hi/70 overflow-y-auto max-h-[60vh]">
          <div className="max-w-2xl mx-auto p-5">
            <ExportControls
              spec={exportSpec}
              setExport={setExport}
              source={{ w: stage.w, h: stage.h, durationS: totalDurationS() }}
            />
          </div>
        </div>
      )}

      {/* Preview + scrubber */}
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 flex flex-col items-center justify-center">
          {members.length === 0 ? (
            <p className="font-mono text-sm text-ink-2">
              This reel is empty. Add projects from the Library.
            </p>
          ) : selected && !selected.missing ? (
            <div className="w-full max-w-3xl flex flex-col gap-2">
              <ReelStage
                stage={stage}
                videoUrl={selected.videoUrl}
                seekTime={scrubTime}
                viewport={selected.viewport}
                onViewport={(patch) => setMemberViewport(selected.memberId, patch)}
                onReset={() => resetMemberViewport(selected.memberId)}
              />
              <ReelScrubber
                posterUrl={selected.posterUrl}
                durationS={selected.fullDurationS}
                value={scrubTime}
                onScrub={setScrubTime}
              />
              <p className="font-mono text-[11px] text-ink-2 text-center">
                {selected.title} — scrub to pick a frame · drag to pan · wheel to
                zoom · double-click to reset
              </p>
            </div>
          ) : selected?.missing ? (
            <p className="font-mono text-sm text-danger">
              This project was deleted — remove it from the reel.
            </p>
          ) : (
            <p className="font-mono text-sm text-ink-2">
              Select a clip below to frame it.
            </p>
          )}
        </div>

        {/* Duration-proportional sequence */}
        {members.length > 0 && (
          <div className="shrink-0 border-t border-rule bg-paper-hi/60 p-3 overflow-x-auto">
            <ReelSequence
              members={members}
              selectedMemberId={selectedMemberId}
              onSelect={selectMember}
              onMove={moveMember}
              onRemove={removeMember}
            />
          </div>
        )}
      </main>
    </div>
  );
}
