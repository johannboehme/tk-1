/**
 * Shared M:SS clock formatting for transport readouts and duration labels
 * (Triage, Arrange). The Editor's MonoReadout uses its own MM:SS.ff
 * variant with centisecond precision — that one intentionally stays local.
 */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
