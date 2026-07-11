/**
 * Cheat-sheet overlay listing every keyboard shortcut currently
 * registered in the global registry. Toggles on `?`, closes on `Esc`,
 * `?` again, the close button, or a backdrop click.
 *
 * Components declare their shortcuts through the keymap
 * (`useGlobalShortcut` / `bindShortcut` with a `help` entry), so this
 * list stays in sync without anyone maintaining a hand-written cheat
 * sheet — behavior and documentation come from the same declaration.
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import { useShortcutRegistry, type ShortcutMeta } from "../shortcuts/registry";
import { acquireModalScope, useGlobalShortcut } from "../shortcuts/keymap";
import { HelpIcon, XIcon } from "./icons";

const GROUP_ORDER = ["Transport", "Cameras", "FX", "Edit"];

function compareGroup(a: string | undefined, b: string | undefined): number {
  const ai = a ? GROUP_ORDER.indexOf(a) : -1;
  const bi = b ? GROUP_ORDER.indexOf(b) : -1;
  // Known groups in declared order, unknown groups after, in alpha order.
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return (a ?? "").localeCompare(b ?? "");
}

function groupShortcuts(
  shortcuts: ShortcutMeta[],
): { group: string; items: ShortcutMeta[] }[] {
  const map = new Map<string, ShortcutMeta[]>();
  for (const s of shortcuts) {
    const g = s.group ?? "Other";
    const list = map.get(g);
    if (list) list.push(s);
    else map.set(g, [s]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => compareGroup(a, b))
    .map(([group, items]) => ({ group, items }));
}

/** Stylised mechanical keycap rendering for a single key label. */
function Keycap({ children }: { children: React.ReactNode }) {
  const label = String(children);
  // Wider keycap for multi-char labels (Space, Esc, Shift, etc.)
  const wide = label.length > 1 && label !== "←" && label !== "→" && label !== "↑" && label !== "↓";
  return (
    <span
      className={[
        "inline-flex items-center justify-center select-none",
        "h-7 rounded border border-rule/70 bg-paper-hi text-ink",
        "font-mono text-[11px] font-semibold tracking-tight",
        "shadow-emboss leading-none",
        wide ? "px-2 min-w-[2.25rem]" : "min-w-[1.75rem] px-1",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

/** A row in the cheat-sheet: keycaps · icon · description. */
function ShortcutRow({ meta }: { meta: ShortcutMeta }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <div className="flex flex-wrap items-center gap-1 pt-0.5 min-w-[110px]">
        {meta.keys.map((k, i) => (
          <Keycap key={`${k}-${i}`}>{k}</Keycap>
        ))}
      </div>
      {meta.icon ? (
        <div className="text-ink-2 mt-1.5 flex-none" aria-hidden>
          {meta.icon}
        </div>
      ) : (
        <div className="w-4 flex-none" aria-hidden />
      )}
      <p className="text-sm text-ink leading-snug pt-1">{meta.description}</p>
    </li>
  );
}

export function HelpOverlay() {
  const [open, setOpen] = useState(false);
  const shortcuts = useShortcutRegistry((s) => s.shortcuts);
  // Ref-mirror so the keydown listener can read the latest open-state
  // without re-binding on every change — and without relying on a
  // functional setState updater (those run twice under React StrictMode
  // and would cancel themselves out for `v => !v` toggles).
  const openRef = useRef(open);
  openRef.current = open;

  // While the sheet is open it is a modal for the keyboard too: holding
  // the keymap's modal scope suppresses every binding not marked
  // `inModal` (Space, cam digits, I/O/L, FX pads, …). Trying a key while
  // reading the cheat sheet must never edit the project behind the
  // dialog. Only ?/Esc below stay live.
  useEffect(() => {
    if (!open) return;
    return acquireModalScope("help-overlay");
  }, [open]);

  // "?" lives on different physical keys per layout (Shift+/ on US,
  // Shift+ß on DE, etc). Most browsers normalise `e.key` to "?", but
  // we also fall back to `e.code` so this works regardless of layout
  // or input source — including synthetic events fired in tests.
  function isQuestionMark(e: KeyboardEvent): boolean {
    if (e.key === "?") return true;
    if (!e.shiftKey) return false;
    if (e.key === "/" || e.key === "ß") return true;
    // Physical keys that produce "?" on common layouts.
    return e.code === "Slash" || e.code === "Minus" || e.code === "IntlRo";
  }
  // Both bindings run in-modal (they ARE the modal's controls) and on the
  // capture phase so no bubbling handler can stopPropagation them away.
  // The keymap dispatcher applies the typing-target guard and blocks
  // Ctrl/Cmd/Alt chords; Shift is free (it's how "?" is typed).
  useGlobalShortcut({
    id: "help.toggle",
    match: isQuestionMark,
    shiftInsensitive: true,
    inModal: true,
    capture: true,
    onDown: () => setOpen(!openRef.current),
  });
  useGlobalShortcut({
    id: "help.close",
    keys: ["Escape"],
    inModal: true,
    capture: true,
    preventDefault: false,
    onDown: (e) => {
      if (!openRef.current) return;
      e.preventDefault();
      setOpen(false);
    },
  });

  const groups = groupShortcuts(shortcuts);

  // Conditional render (no AnimatePresence) — exit animations via
  // AnimatePresence have proven flaky here (the portal'd node can stick
  // around with opacity:0 and swallow clicks). Enter is animated with
  // motion.div so we still get the soft fade-in.
  const overlay = open ? (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-testid="help-overlay"
    >
      {/* backdrop */}
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-sunken/60 cursor-default"
      />
      {/* card */}
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className={[
          "relative max-w-[640px] w-full max-h-[85vh]",
          "bg-paper-hi text-ink rounded-lg border border-rule",
          "shadow-emboss flex flex-col overflow-hidden",
        ].join(" ")}
      >
            {/* header */}
            <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-rule/70 bg-paper-deep">
              <div className="flex items-center gap-2">
                <HelpIcon className="text-hot" />
                <h2 className="font-display tracking-label uppercase text-sm text-ink">
                  Keyboard
                </h2>
              </div>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-ink-3 font-mono">
                  <Keycap>?</Keycap>
                  <span className="opacity-60">to toggle</span>
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className={[
                    "h-8 w-8 inline-flex items-center justify-center rounded",
                    "border border-rule/60 bg-paper-hi text-ink-2",
                    "shadow-emboss hover:bg-paper-deep hover:text-ink transition-colors",
                  ].join(" ")}
                  data-testid="help-overlay-close"
                >
                  <XIcon />
                </button>
              </div>
            </header>

            {/* body */}
            <div className="overflow-y-auto px-5 py-3">
              {groups.length === 0 ? (
                <p className="text-sm text-ink-3 py-4">
                  No shortcuts registered yet.
                </p>
              ) : (
                groups.map(({ group, items }) => (
                  <section key={group} className="py-2 first:pt-0 last:pb-0">
                    <h3 className="label mb-1">{group}</h3>
                    <ul className="divide-y divide-rule/40">
                      {items.map((meta) => (
                        <ShortcutRow key={meta.id} meta={meta} />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
      </motion.div>
    </motion.div>
  ) : null;

  if (typeof document === "undefined") return null;
  return createPortal(overlay, document.body);
}
