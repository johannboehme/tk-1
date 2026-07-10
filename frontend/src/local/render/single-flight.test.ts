import { describe, expect, it } from "vitest";
import { createSingleFlight } from "./single-flight";

describe("createSingleFlight", () => {
  it("runs a task and returns its result", async () => {
    const run = createSingleFlight("busy");
    await expect(run(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects a second call while the first is in flight", async () => {
    const run = createSingleFlight("A quick render is already in progress.");
    let release!: () => void;
    const first = run(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    await expect(run(async () => undefined)).rejects.toThrow(
      "A quick render is already in progress.",
    );
    release();
    await first;
  });

  it("releases the lock after the task resolves", async () => {
    const run = createSingleFlight("busy");
    await run(async () => undefined);
    await expect(run(async () => "second")).resolves.toBe("second");
  });

  it("releases the lock after the task rejects", async () => {
    const run = createSingleFlight("busy");
    await expect(
      run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(run(async () => "recovered")).resolves.toBe("recovered");
  });
});
