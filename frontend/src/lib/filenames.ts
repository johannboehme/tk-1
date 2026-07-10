/**
 * Filename helpers shared by the job title default and the download UX.
 *
 * Job titles frequently ARE filenames (the default title used to be the
 * first video's name), so anything that appends an extension must strip
 * an existing one first — otherwise the saved file ends up as
 * `take-1.mp4.mp4` (#142).
 */

/**
 * Strip a trailing file extension (1-5 alphanumeric chars containing at
 * least one letter, so `Take 1.2` keeps its version suffix). Dot-leading
 * names (`.mp4`) and names without an extension pass through unchanged.
 */
export function stripFileExtension(name: string): string {
  const m = name.match(/^(.*)\.([A-Za-z0-9]{1,5})$/);
  if (!m) return name;
  const [, base, ext] = m;
  if (!/[A-Za-z]/.test(ext)) return name; // "1.2" → version number, not an extension
  if (base === "") return name; // ".mp4" → dot-leading, nothing to strip
  return base;
}

/** Build the download filename: strip any existing extension from the
 *  base, then append exactly one. Empty bases fall back to "export". */
export function downloadFilename(base: string, ext = "mp4"): string {
  const cleaned = stripFileExtension(base.trim()).trim();
  return `${cleaned || "export"}.${ext}`;
}
