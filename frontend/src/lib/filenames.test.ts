import { describe, expect, it } from "vitest";
import {
  defaultJobTitle,
  downloadFilename,
  stripFileExtension,
} from "./filenames";

describe("stripFileExtension", () => {
  it("strips a common media extension", () => {
    expect(stripFileExtension("take-1.mp4")).toBe("take-1");
    expect(stripFileExtension("song.wav")).toBe("song");
    expect(stripFileExtension("clip.3gp")).toBe("clip");
    expect(stripFileExtension("movie.MOV")).toBe("movie");
  });

  it("strips only the last extension", () => {
    expect(stripFileExtension("mix.final.mp4")).toBe("mix.final");
  });

  it("leaves names without an extension alone", () => {
    expect(stripFileExtension("My Song")).toBe("My Song");
  });

  it("does not treat a trailing version number as an extension", () => {
    expect(stripFileExtension("Take 1.2")).toBe("Take 1.2");
  });

  it("keeps dot-leading names intact", () => {
    expect(stripFileExtension(".mp4")).toBe(".mp4");
  });
});

describe("defaultJobTitle (#143)", () => {
  it("uses the master audio's name — the song is the project's identity", () => {
    expect(defaultJobTitle("neon-nights.wav", "take-1.mp4")).toBe(
      "neon-nights",
    );
  });

  it("falls back to the first video's name when the audio name is empty", () => {
    expect(defaultJobTitle("   ", "take-1.mp4")).toBe("take-1");
  });

  it("falls back to a generic title when both names are empty", () => {
    expect(defaultJobTitle("", "")).toBe("Untitled session");
  });
});

describe("downloadFilename (#142)", () => {
  it("does not double the extension when the base already ends in .mp4", () => {
    expect(downloadFilename("take-1.mp4")).toBe("take-1.mp4");
  });

  it("appends .mp4 to a clean title", () => {
    expect(downloadFilename("My Song")).toBe("My Song.mp4");
  });

  it("falls back to 'export' for an empty base", () => {
    expect(downloadFilename("   ")).toBe("export.mp4");
  });
});
