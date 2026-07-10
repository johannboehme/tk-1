import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireModalScope,
  bindShortcut,
  isTypingTarget,
  modalScopeActive,
} from "./keymap";
import { useShortcutRegistry } from "./registry";

/** Dispatch a real KeyboardEvent on the given target (default: body). */
function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
) {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}
function release(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
) {
  const e = new KeyboardEvent("keyup", { key, bubbles: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const unbinds: Array<() => void> = [];
function bind(...args: Parameters<typeof bindShortcut>) {
  const off = bindShortcut(...args);
  unbinds.push(off);
  return off;
}

beforeEach(() => {
  useShortcutRegistry.setState({ shortcuts: [] });
});
afterEach(() => {
  while (unbinds.length) unbinds.pop()!();
  document.body.innerHTML = "";
});

describe("keymap: key matching + exact-modifier policy", () => {
  it("fires a plain-key binding on the bare key", () => {
    const onDown = vi.fn();
    bind({ id: "t.space", keys: [" "], onDown });
    press(" ");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire plain-key bindings on Ctrl/Cmd/Alt/Shift combos", () => {
    const onDown = vi.fn();
    bind({ id: "t.l", keys: ["l"], onDown });
    press("l", { ctrlKey: true });
    press("l", { metaKey: true });
    press("l", { altKey: true });
    press("l", { shiftKey: true });
    expect(onDown).not.toHaveBeenCalled();
    press("l");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("a required-modifier binding fires only on the exact combo", () => {
    const onDown = vi.fn();
    bind({ id: "t.altleft", keys: ["ArrowLeft"], modifiers: ["alt"], onDown });
    press("ArrowLeft");
    press("ArrowLeft", { altKey: true, ctrlKey: true });
    expect(onDown).not.toHaveBeenCalled();
    press("ArrowLeft", { altKey: true });
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("shiftInsensitive bindings tolerate Shift/CapsLock case changes", () => {
    const onDown = vi.fn();
    bind({ id: "t.i", keys: ["i", "I"], shiftInsensitive: true, onDown });
    press("I", { shiftKey: true }); // Shift+i
    press("I"); // CapsLock+i
    press("i");
    expect(onDown).toHaveBeenCalledTimes(3);
    press("i", { metaKey: true }); // Cmd+i must still be blocked
    expect(onDown).toHaveBeenCalledTimes(3);
  });

  it("matches on e.code when `codes` is given (layout-independent)", () => {
    const onDown = vi.fn();
    bind({ id: "t.s", codes: ["KeyS"], onDown });
    press("s", { code: "KeyS" });
    expect(onDown).toHaveBeenCalledTimes(1);
    press("s", { code: "KeyF" });
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("supports a custom match predicate under the default modifier policy", () => {
    const onDown = vi.fn();
    bind({
      id: "t.q",
      match: (e) => e.key === "?",
      shiftInsensitive: true,
      onDown,
    });
    press("?", { shiftKey: true });
    expect(onDown).toHaveBeenCalledTimes(1);
    press("?", { metaKey: true, shiftKey: true });
    expect(onDown).toHaveBeenCalledTimes(1);
  });
});

describe("keymap: standard guards", () => {
  it("skips keydown while typing in INPUT / TEXTAREA / SELECT / contenteditable", () => {
    const onDown = vi.fn();
    bind({ id: "t.k", keys: ["k"], onDown });
    for (const tag of ["input", "textarea", "select"]) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      press("k", {}, el);
    }
    const ce = document.createElement("div");
    // jsdom doesn't compute isContentEditable from the attribute reliably;
    // define it the way a browser would report it.
    Object.defineProperty(ce, "isContentEditable", { value: true });
    document.body.appendChild(ce);
    press("k", {}, ce);
    expect(onDown).not.toHaveBeenCalled();
    press("k");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("keyup is NOT typing-guarded so holds can't get stuck", () => {
    const onUp = vi.fn();
    bind({ id: "t.v", keys: ["v"], onUp });
    const input = document.createElement("input");
    document.body.appendChild(input);
    release("v", {}, input);
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("swallows key auto-repeat by default, passes it with allowRepeat", () => {
    const onDown = vi.fn();
    const onRepeat = vi.fn();
    bind({ id: "t.norepeat", keys: ["k"], onDown });
    bind({ id: "t.repeat", keys: ["ArrowRight"], allowRepeat: true, onDown: onRepeat });
    press("k", { repeat: true });
    expect(onDown).not.toHaveBeenCalled();
    press("ArrowRight", { repeat: true });
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it("preventDefaults matched events by default, not with preventDefault:false", () => {
    bind({ id: "t.pd", keys: ["a"], onDown: () => {} });
    bind({ id: "t.nopd", keys: ["b"], preventDefault: false, onDown: () => {} });
    expect(press("a").defaultPrevented).toBe(true);
    expect(press("b").defaultPrevented).toBe(false);
    // unmatched events are untouched
    expect(press("c").defaultPrevented).toBe(false);
  });

  it("skips bindings marked unlessKnobFocused while a knob has focus", () => {
    const onDown = vi.fn();
    bind({ id: "t.knob", keys: ["ArrowLeft"], unlessKnobFocused: true, onDown });
    const knob = document.createElement("div");
    knob.dataset.knob = "1";
    knob.tabIndex = 0;
    document.body.appendChild(knob);
    knob.focus();
    press("ArrowLeft", {}, knob);
    expect(onDown).not.toHaveBeenCalled();
    knob.blur();
    press("ArrowLeft");
    expect(onDown).toHaveBeenCalledTimes(1);
  });
});

describe("keymap: modal scope", () => {
  it("suppresses non-modal bindings while a scope is held, allows inModal ones", () => {
    const edit = vi.fn();
    const close = vi.fn();
    bind({ id: "t.edit", keys: ["1"], onDown: edit });
    bind({ id: "t.close", keys: ["Escape"], inModal: true, onDown: close });
    const releaseScope = acquireModalScope("help");
    expect(modalScopeActive()).toBe(true);
    press("1");
    press("Escape");
    expect(edit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    releaseScope();
    expect(modalScopeActive()).toBe(false);
    press("1");
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("releasing one of two held scopes keeps the modal state active", () => {
    const r1 = acquireModalScope("a");
    const r2 = acquireModalScope("a");
    r1();
    expect(modalScopeActive()).toBe(true);
    r2();
    expect(modalScopeActive()).toBe(false);
  });
});

describe("keymap: help registration", () => {
  it("registers the cheat-sheet entry with the binding and removes it on unbind", () => {
    const off = bindShortcut({
      id: "t.help",
      keys: ["g"],
      onDown: () => {},
      help: { keys: ["G"], description: "Do the thing", group: "Edit" },
    });
    const entry = useShortcutRegistry
      .getState()
      .shortcuts.find((s) => s.id === "t.help");
    expect(entry).toBeTruthy();
    expect(entry!.keys).toEqual(["G"]);
    expect(entry!.description).toBe("Do the thing");
    off();
    expect(
      useShortcutRegistry.getState().shortcuts.find((s) => s.id === "t.help"),
    ).toBeUndefined();
  });
});

describe("keymap: DE-layout key policy", () => {
  it.each(["[", "]", "{", "}", "\\", "|", "~", "@", "#"])(
    "rejects binding %s (needs AltGr on a German layout)",
    (key) => {
      expect(() =>
        bindShortcut({ id: `t.bad-${key}`, keys: [key], onDown: () => {} }),
      ).toThrow(/German|AltGr/i);
    },
  );
});

describe("keymap: lifecycle", () => {
  it("unbind is idempotent and stops dispatch", () => {
    const onDown = vi.fn();
    const off = bindShortcut({ id: "t.off", keys: ["m"], onDown });
    press("m");
    off();
    off();
    press("m");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("all matching bindings fire (independent listeners semantics)", () => {
    const a = vi.fn();
    const b = vi.fn();
    bind({ id: "t.a", keys: ["Escape"], preventDefault: false, onDown: a });
    bind({ id: "t.b", keys: ["Escape"], preventDefault: false, onDown: b });
    press("Escape");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("isTypingTarget", () => {
  it("classifies form fields and contenteditable, not window/body", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
  });
});
