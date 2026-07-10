/**
 * Unit tests for the OPFS write helper's error semantics (#119).
 *
 * The real OPFS API only exists in the browser; these tests exercise the
 * extracted `writeAndClose` helper with fake writables so we can prove
 * that a failing `write()` (e.g. QuotaExceededError) is NOT masked by the
 * follow-up `close()` rejection — the original error must propagate to
 * the caller so the Upload banner can say "storage is full" instead of a
 * generic stream error.
 */
import { describe, expect, it, vi } from "vitest";
import { writeAndClose } from "./opfs";

function quotaError(): DOMException {
  return new DOMException("Quota exceeded", "QuotaExceededError");
}

describe("writeAndClose", () => {
  it("writes then closes on the happy path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    await writeAndClose({ write, close }, new Blob(["x"]));
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates the original write error even when close() rejects too", async () => {
    const write = vi.fn().mockRejectedValue(quotaError());
    const close = vi.fn().mockRejectedValue(new TypeError("stream errored"));
    await expect(
      writeAndClose({ write, close }, new Blob(["x"])),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("prefers abort() over close() after a failed write and still rethrows the write error", async () => {
    const write = vi.fn().mockRejectedValue(quotaError());
    const abort = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockRejectedValue(new TypeError("stream errored"));
    await expect(
      writeAndClose({ write, close, abort }, new Blob(["x"])),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(abort).toHaveBeenCalledTimes(1);
    // abort() already discarded the stream — close() must not run on top.
    expect(close).not.toHaveBeenCalled();
  });

  it("swallows an abort() rejection so the write error still wins", async () => {
    const write = vi.fn().mockRejectedValue(quotaError());
    const abort = vi.fn().mockRejectedValue(new TypeError("abort failed"));
    const close = vi.fn().mockRejectedValue(new TypeError("close failed"));
    await expect(
      writeAndClose({ write, close, abort }, new Blob(["x"])),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("propagates a close() error when the write itself succeeded", async () => {
    // close() flushes to disk — a quota error surfacing there is real and
    // must not be swallowed.
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockRejectedValue(quotaError());
    await expect(
      writeAndClose({ write, close }, new Blob(["x"])),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
  });
});
