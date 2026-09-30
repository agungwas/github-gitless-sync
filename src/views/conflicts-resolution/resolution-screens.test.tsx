import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictsResolvedScreen,
  NoConflictsScreen,
  ResetAllBar,
} from "./resolution-screens";

// Each tick schedules the next one after React re-rendered, so time has to be
// advanced one second at a time.
const advanceSeconds = (seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }
};

describe("ConflictsResolvedScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is centered both horizontally and vertically", () => {
    render(
      <ConflictsResolvedScreen
        delaySeconds={3}
        onConfirm={() => {}}
        onUndo={() => {}}
      />,
    );
    const container = screen.getByText("All conflicts resolved").parentElement!;
    expect(container.style.display).toBe("flex");
    expect(container.style.alignItems).toBe("center");
    expect(container.style.justifyContent).toBe("center");
    expect(container.style.height).toBe("100%");
  });

  it("confirms once after the countdown", () => {
    const onConfirm = vi.fn();
    render(
      <ConflictsResolvedScreen
        delaySeconds={3}
        onConfirm={onConfirm}
        onUndo={() => {}}
      />,
    );
    expect(screen.getByText("Closing in 3s…")).toBeDefined();

    advanceSeconds(2);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Closing in 1s…")).toBeDefined();

    advanceSeconds(5);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms immediately when OK is clicked, and only once", () => {
    const onConfirm = vi.fn();
    render(
      <ConflictsResolvedScreen
        delaySeconds={3}
        onConfirm={onConfirm}
        onUndo={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("OK"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    advanceSeconds(10);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("undo doesn't confirm", () => {
    const onConfirm = vi.fn();
    const onUndo = vi.fn();
    const { unmount } = render(
      <ConflictsResolvedScreen
        delaySeconds={3}
        onConfirm={onConfirm}
        onUndo={onUndo}
      />,
    );
    fireEvent.click(screen.getByText("Undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);

    // The view is remounted after undoing, the countdown must stop
    unmount();
    advanceSeconds(10);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms right away without a countdown when the delay is 0", () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ConflictsResolvedScreen
        delaySeconds={0}
        onConfirm={onConfirm}
        onUndo={() => {}}
      />,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });
});

describe("NoConflictsScreen", () => {
  it("shows the message without any action", () => {
    render(<NoConflictsScreen />);
    expect(screen.getByText("No conflicts to resolve")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ResetAllBar", () => {
  it("calls onReset", () => {
    const onReset = vi.fn();
    render(<ResetAllBar onReset={onReset} />);
    fireEvent.click(screen.getByText("Reset all conflicts"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
