import { beforeEach, describe, expect, it } from "vitest";
import { useOpsStore } from "./ops-store";

beforeEach(() => {
  useOpsStore.setState({ ops: {} });
});

describe("ops-store · sync", () => {
  it("starts and updates a sync op", () => {
    const { startSyncOp, updateSyncOp } = useOpsStore.getState();
    startSyncOp("job-1", { stage: "loading" });
    updateSyncOp("job-1", { pct: 42, stage: "syncing-cam-1" });
    const op = useOpsStore.getState().ops["job-1"]?.sync;
    expect(op).toMatchObject({ pct: 42, stage: "syncing-cam-1" });
    expect(op?.error).toBeUndefined();
  });

  it("clearSyncOp removes the entry, including the jobId key when no render op", () => {
    useOpsStore.getState().startSyncOp("job-1");
    useOpsStore.getState().clearSyncOp("job-1");
    expect(useOpsStore.getState().ops["job-1"]).toBeUndefined();
  });

  it("clearSyncOp keeps jobId key when render op coexists", () => {
    useOpsStore.getState().startSyncOp("job-1");
    useOpsStore.getState().startRenderOp("job-1");
    useOpsStore.getState().clearSyncOp("job-1");
    expect(useOpsStore.getState().ops["job-1"]?.sync).toBeUndefined();
    expect(useOpsStore.getState().ops["job-1"]?.render).toBeDefined();
  });

  it("failSyncOp sets error on the op (creating one if needed)", () => {
    useOpsStore.getState().failSyncOp("job-1", "boom");
    const op = useOpsStore.getState().ops["job-1"]?.sync;
    expect(op?.error).toBe("boom");
  });

  it("updateSyncOp on a non-existent op is a no-op", () => {
    useOpsStore.getState().updateSyncOp("job-x", { pct: 50 });
    expect(useOpsStore.getState().ops["job-x"]).toBeUndefined();
  });
});

describe("ops-store · render", () => {
  it("startRenderOp clears prior error/done", () => {
    useOpsStore.getState().startRenderOp("job-1");
    useOpsStore.getState().failRenderOp("job-1", "oops");
    useOpsStore.getState().startRenderOp("job-1");
    const op = useOpsStore.getState().ops["job-1"]?.render;
    expect(op?.error).toBeUndefined();
    expect(op?.done).toBe(false);
  });

  it("finishRenderOp marks the op done at 100%", () => {
    useOpsStore.getState().startRenderOp("job-1");
    useOpsStore.getState().finishRenderOp("job-1");
    const op = useOpsStore.getState().ops["job-1"]?.render;
    expect(op).toMatchObject({ pct: 100, stage: "rendered", done: true });
  });

  it("clearRenderOp removes the render op while preserving sync", () => {
    useOpsStore.getState().startSyncOp("job-1");
    useOpsStore.getState().startRenderOp("job-1");
    useOpsStore.getState().clearRenderOp("job-1");
    expect(useOpsStore.getState().ops["job-1"]?.render).toBeUndefined();
    expect(useOpsStore.getState().ops["job-1"]?.sync).toBeDefined();
  });

  it("failRenderOp on an absent op creates a stub failed op", () => {
    useOpsStore.getState().failRenderOp("job-z", "aborted");
    const op = useOpsStore.getState().ops["job-z"]?.render;
    expect(op?.error).toBe("aborted");
  });
});

describe("ops-store · isolation between jobs", () => {
  it("ops for different jobs do not interfere", () => {
    useOpsStore.getState().startSyncOp("job-a", { pct: 10 });
    useOpsStore.getState().startSyncOp("job-b", { pct: 20 });
    useOpsStore.getState().updateSyncOp("job-a", { pct: 99 });
    expect(useOpsStore.getState().ops["job-a"]?.sync?.pct).toBe(99);
    expect(useOpsStore.getState().ops["job-b"]?.sync?.pct).toBe(20);
  });
});
