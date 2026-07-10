/**
 * Central keyboard dispatcher for all global (window-level) shortcuts.
 *
 * Every surface that used to hand-roll its own `window.addEventListener`
 * registers a declarative `KeyBinding` here instead. The dispatcher owns
 * the standard guards exactly once:
 *
 *   - typing target      — keydown is skipped while an INPUT / TEXTAREA /
 *                          SELECT / contenteditable has focus. Keyup is
 *                          deliberately NOT guarded so hold-gestures can't
 *                          get stuck when focus moves mid-hold.
 *   - exact modifiers    — a binding fires only when precisely its declared
 *                          modifiers are held. Plain-key bindings therefore
 *                          never react to browser chords (Cmd/Ctrl+L, Cmd+I,
 *                          Cmd+Arrow …). `shiftInsensitive` opts a binding
 *                          out of the Shift check so letter keys keep working
 *                          under Shift/CapsLock (performance surface).
 *   - key auto-repeat    — swallowed (with preventDefault) unless the
 *                          binding sets `allowRepeat` (arrow-key scrubbing).
 *   - modal scope        — while any scope is held (help overlay open),
 *                          only `inModal` bindings fire.
 *   - knob focus         — bindings with `unlessKnobFocused` stay quiet
 *                          while a Knob has focus (it owns the arrow keys).
 *
 * A binding may also carry its cheat-sheet entry (`help`), so behavior and
 * documentation come from the same declaration and can no longer drift.
 *
 * German-layout invariant: keys that need AltGr on a DE layout
 * (`[ ] { } \ | ~ @ #`) are rejected at bind time — this is the single
 * enforcement point for the "shortcuts must work on a German keyboard"
 * rule.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { registerShortcut } from "./registry";

export type ShortcutModifier = "shift" | "alt" | "meta" | "ctrl";

export interface ShortcutHelp {
  /** Visible key labels for the cheat sheet, e.g. ["Space"], ["⌥←", "⌥→"]. */
  keys: string[];
  /** English, present-tense description of what the shortcut does. */
  description: string;
  /** Grouping label, e.g. "Transport", "Cameras", "FX". */
  group?: string;
  /** Optional inline SVG icon (16×16 line-style, currentColor). */
  icon?: ReactNode;
}

export interface KeyBinding {
  /** Stable unique identifier. Also keys the cheat-sheet entry. */
  id: string;
  /** Match against `e.key` (character produced — layout dependent). */
  keys?: string[];
  /** Match against `e.code` (physical key — layout independent). */
  codes?: string[];
  /**
   * Custom predicate for matches the two lists can't express (e.g. "?"
   * which lives on different physical keys per layout). Still subject to
   * the standard guards and the modifier policy.
   */
  match?: (e: KeyboardEvent) => boolean;
  /**
   * Modifiers that MUST be held. Any modifier not listed must NOT be
   * held (exact-modifier policy). Default: plain key, no modifiers.
   */
  modifiers?: ShortcutModifier[];
  /**
   * Ignore the Shift key in the modifier policy. For letter bindings that
   * list both cases (["i", "I"]) so Shift/CapsLock don't break them.
   */
  shiftInsensitive?: boolean;
  /** Let key auto-repeat through (default: swallowed). */
  allowRepeat?: boolean;
  /** Keep firing while a modal scope (help overlay) is active. */
  inModal?: boolean;
  /** Skip while a Knob (`data-knob`) has focus — it owns its own keys. */
  unlessKnobFocused?: boolean;
  /**
   * Dispatch during the capture phase (before bubbling handlers can
   * stopPropagation). Modal owners use this; default is bubble.
   */
  capture?: boolean;
  /**
   * preventDefault on every matched keydown (default true). Set false
   * when the handler decides conditionally — then call
   * `e.preventDefault()` yourself once you actually consume the key.
   */
  preventDefault?: boolean;
  onDown?: (e: KeyboardEvent) => void;
  /** Keyup counterpart. Matched by key/code only — no guards, so a hold
   *  started on keydown is always released. */
  onUp?: (e: KeyboardEvent) => void;
  /** Cheat-sheet entry, registered/removed together with the binding. */
  help?: ShortcutHelp;
}

/** Canonical "user is typing" guard — the single copy for the whole app. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    t.isContentEditable === true
  );
}

// ─── Modal scope ─────────────────────────────────────────────────────────
// Held scopes suppress every binding that isn't marked `inModal`. Stored
// as a list (not a Set) so double-acquire with the same id — StrictMode
// double-mounts — balances out release-for-release.

const modalScopes: string[] = [];

/** Hold a modal scope. Returns a release fn; releasing twice is a no-op. */
export function acquireModalScope(id: string): () => void {
  modalScopes.push(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = modalScopes.indexOf(id);
    if (i !== -1) modalScopes.splice(i, 1);
  };
}

export function modalScopeActive(): boolean {
  return modalScopes.length > 0;
}

// ─── DE-layout key policy ────────────────────────────────────────────────

const ALTGR_ON_DE = new Set(["[", "]", "{", "}", "\\", "|", "~", "@", "#"]);

function validateBinding(b: KeyBinding): void {
  for (const k of b.keys ?? []) {
    if (ALTGR_ON_DE.has(k)) {
      throw new Error(
        `Shortcut "${b.id}" binds "${k}", which needs AltGr on a German ` +
          `keyboard layout. Pick an alphanumeric key, arrows, or modifiers.`,
      );
    }
  }
  if (!b.keys?.length && !b.codes?.length && !b.match) {
    throw new Error(`Shortcut "${b.id}" declares no keys, codes, or match().`);
  }
}

// ─── Matching ────────────────────────────────────────────────────────────

function modifiersOk(b: KeyBinding, e: KeyboardEvent): boolean {
  const req = b.modifiers ?? [];
  if (e.ctrlKey !== req.includes("ctrl")) return false;
  if (e.metaKey !== req.includes("meta")) return false;
  if (e.altKey !== req.includes("alt")) return false;
  if (!b.shiftInsensitive && e.shiftKey !== req.includes("shift")) return false;
  return true;
}

function keyMatches(b: KeyBinding, e: KeyboardEvent): boolean {
  if (b.keys && b.keys.includes(e.key)) return true;
  if (b.codes && b.codes.includes(e.code)) return true;
  if (b.match && b.match(e)) return true;
  return false;
}

function knobFocused(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae?.dataset?.knob;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────
// One shared set of window listeners (lazily installed while at least one
// binding exists) instead of one listener pair per surface. Bindings are
// stored as getter thunks so the React hook can swap the live binding —
// with fresh prop/state closures — without re-registering.

type BindingRef = () => KeyBinding;
const bindings = new Set<BindingRef>();

function dispatch(e: KeyboardEvent, type: "down" | "up", capture: boolean) {
  // Snapshot: handlers may bind/unbind during iteration.
  for (const get of [...bindings]) {
    const b = get();
    if ((b.capture ?? false) !== capture) continue;
    if (!keyMatches(b, e)) continue;

    if (type === "up") {
      // Keyup releases holds — no guards on purpose (see KeyBinding.onUp).
      b.onUp?.(e);
      continue;
    }

    if (!b.onDown) continue;
    if (!modifiersOk(b, e)) continue;
    if (isTypingTarget(e.target)) continue;
    if (b.unlessKnobFocused && knobFocused()) continue;
    if (modalScopeActive() && !b.inModal) continue;
    const pd = b.preventDefault ?? true;
    if (e.repeat && !b.allowRepeat) {
      if (pd) e.preventDefault();
      continue;
    }
    if (pd) e.preventDefault();
    b.onDown(e);
  }
}

const onKeyDownCapture = (e: KeyboardEvent) => dispatch(e, "down", true);
const onKeyDownBubble = (e: KeyboardEvent) => dispatch(e, "down", false);
const onKeyUpCapture = (e: KeyboardEvent) => dispatch(e, "up", true);
const onKeyUpBubble = (e: KeyboardEvent) => dispatch(e, "up", false);

let listenersInstalled = false;
function syncListeners() {
  const want = bindings.size > 0;
  if (want === listenersInstalled) return;
  listenersInstalled = want;
  if (want) {
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDownBubble, false);
    window.addEventListener("keyup", onKeyUpCapture, true);
    window.addEventListener("keyup", onKeyUpBubble, false);
  } else {
    window.removeEventListener("keydown", onKeyDownCapture, true);
    window.removeEventListener("keydown", onKeyDownBubble, false);
    window.removeEventListener("keyup", onKeyUpCapture, true);
    window.removeEventListener("keyup", onKeyUpBubble, false);
  }
}

/** Low-level registration: dispatch only, no help entry. */
function addBinding(get: BindingRef): () => void {
  validateBinding(get());
  bindings.add(get);
  syncListeners();
  return () => {
    bindings.delete(get);
    syncListeners();
  };
}

function helpMeta(b: KeyBinding) {
  const h = b.help!;
  return {
    id: b.id,
    keys: h.keys,
    description: h.description,
    group: h.group,
    icon: h.icon,
  };
}

/**
 * Register a global shortcut imperatively (from inside an effect that owns
 * closure state for a multi-key gesture). Returns an unbind fn — call it
 * in the effect's cleanup. If `help` is present, the cheat-sheet entry is
 * registered/removed alongside.
 */
export function bindShortcut(binding: KeyBinding): () => void {
  const offDispatch = addBinding(() => binding);
  const offHelp = binding.help ? registerShortcut(helpMeta(binding)) : null;
  return () => {
    offDispatch();
    offHelp?.();
  };
}

/**
 * React-hook variant for one-shot shortcuts declared at component level.
 * The dispatch registration is mount-once, but handlers/matching always
 * see the binding from the LATEST render (ref swap), so closures over
 * props/state stay fresh without listener churn. The cheat-sheet entry
 * re-registers when its text changes (contextual descriptions).
 */
export function useGlobalShortcut(binding: KeyBinding): void {
  const ref = useRef(binding);
  ref.current = binding;

  useEffect(() => addBinding(() => ref.current), []);

  const h = binding.help;
  const helpKeys = h?.keys.join(" ");
  useEffect(() => {
    if (!ref.current.help) return;
    return registerShortcut(helpMeta(ref.current));
    // Primitive fields only — `binding` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding.id, helpKeys, h?.description, h?.group, h?.icon]);
}
