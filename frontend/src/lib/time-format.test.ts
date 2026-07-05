import { describe, expect, it } from "vitest";
import { formatTime } from "./time-format";

describe("formatTime", () => {
  it("formats zero", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("formats sub-minute values with padded seconds", () => {
    expect(formatTime(7.9)).toBe("0:07");
    expect(formatTime(59.999)).toBe("0:59");
  });

  it("formats minute values", () => {
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(61.2)).toBe("1:01");
    expect(formatTime(600)).toBe("10:00");
    expect(formatTime(3599)).toBe("59:59");
  });

  it("does not roll hours — minutes keep counting", () => {
    expect(formatTime(3600)).toBe("60:00");
  });

  it("clamps negative and non-finite input to 0:00", () => {
    expect(formatTime(-5)).toBe("0:00");
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
