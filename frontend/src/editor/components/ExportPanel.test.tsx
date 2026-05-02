import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useEditorStore } from "../store";
import { ExportPanel } from "./ExportPanel";

function mountAt(width: number, height: number) {
  useEditorStore.getState().reset();
  useEditorStore.getState().loadJob({
    id: "j",
    fps: 30,
    duration: 60,
    width,
    height,
    algoOffsetMs: 0,
    driftRatio: 1,
  });
}

describe("<ExportPanel />", () => {
  beforeEach(() => {
    mountAt(1920, 1080);
  });

  test("default preset is custom — Stage shape derives from the first clip", () => {
    render(<ExportPanel onSubmit={() => undefined} submitting={false} />);
    const ex = useEditorStore.getState().exportSpec;
    expect(ex.preset).toBe("custom");
    expect(ex.video_codec).toBe("h264");
  });

  test("WEB preset always sets 16:9 1920×1080 + H.264 + Good", async () => {
    mountAt(1080, 1920);
    render(<ExportPanel onSubmit={() => undefined} submitting={false} />);
    const webTab = screen.getByRole("tab", { name: /WEB/i });
    await userEvent.click(webTab);
    const ex = useEditorStore.getState().exportSpec;
    expect(ex.preset).toBe("web");
    expect(ex.aspectRatio).toBe("16:9");
    expect(ex.resolution).toEqual({ w: 1920, h: 1080 });
    expect(ex.video_codec).toBe("h264");
    expect(ex.video_bitrate_kbps).toBe(3500);
  });

  test("MOBILE preset always sets 9:16 1080×1920 + H.264 + Low", async () => {
    mountAt(3840, 2160);
    render(<ExportPanel onSubmit={() => undefined} submitting={false} />);
    const mobileTab = screen.getByRole("tab", { name: /MOBILE/i });
    await userEvent.click(mobileTab);
    const ex = useEditorStore.getState().exportSpec;
    expect(ex.preset).toBe("mobile");
    expect(ex.aspectRatio).toBe("9:16");
    expect(ex.resolution).toEqual({ w: 1080, h: 1920 });
    expect(ex.video_codec).toBe("h264");
    expect(ex.quality).toBe("low");
  });

  test("ARCHIVE preset keeps the user's aspect + dims, switches to H.265", async () => {
    mountAt(3840, 2160);
    render(<ExportPanel onSubmit={() => undefined} submitting={false} />);
    // Without prior aspect/dims set, archive falls back to 16:9 4K.
    const archiveTab = screen.getByRole("tab", { name: /ARCHIVE/i });
    await userEvent.click(archiveTab);
    const ex = useEditorStore.getState().exportSpec;
    expect(ex.preset).toBe("archive");
    expect(ex.video_codec).toBe("h265");
    expect(ex.aspectRatio).toBe("16:9");
    expect(ex.resolution).toEqual({ w: 3840, h: 2160 });
  });

  test("Render button calls onSubmit", async () => {
    const onSubmit = vi.fn();
    render(<ExportPanel onSubmit={onSubmit} submitting={false} />);
    const btn = screen.getByRole("button", { name: /^Render$/i });
    await userEvent.click(btn);
    expect(onSubmit).toHaveBeenCalled();
  });

  test("submitting disables the Render button", () => {
    render(<ExportPanel onSubmit={() => undefined} submitting={true} />);
    const btn = screen.getByRole("button", { name: /Submitting/i });
    expect(btn).toBeDisabled();
  });
});
