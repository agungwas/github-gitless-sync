import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import UnifiedResolutionBar from "./unified-resolution-bar";

describe("UnifiedResolutionBar", () => {
  it("should render Accept and Discard when only onAccept and onDiscard are provided", () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();

    render(<UnifiedResolutionBar onAccept={onAccept} onDiscard={onDiscard} />);

    const acceptBtn = screen.getByText("Accept");
    const discardBtn = screen.getByText("Discard");

    expect(acceptBtn).toBeDefined();
    expect(discardBtn).toBeDefined();

    // Verify other buttons are NOT rendered
    expect(screen.queryByText("Accept both")).toBeNull();
  });

  it("should render all 4 buttons when multiple callbacks are provided", () => {
    const onAcceptAbove = vi.fn();
    const onAcceptBelow = vi.fn();
    const onAcceptBoth = vi.fn();
    const onDiscardBoth = vi.fn();

    render(
      <UnifiedResolutionBar
        onAcceptAbove={onAcceptAbove}
        onAcceptBelow={onAcceptBelow}
        onAcceptBoth={onAcceptBoth}
        onDiscardBoth={onDiscardBoth}
      />
    );

    expect(screen.getByText("Accept above (Remote)")).toBeDefined();
    expect(screen.getByText("Accept below (Local)")).toBeDefined();
    expect(screen.getByText("Accept both")).toBeDefined();
    expect(screen.getByText("Discard both")).toBeDefined();
  });

  it("should trigger callbacks when buttons are clicked", () => {
    const onAcceptBoth = vi.fn();

    render(<UnifiedResolutionBar onAcceptBoth={onAcceptBoth} />);

    const btn = screen.getByText("Accept both");
    fireEvent.click(btn);

    expect(onAcceptBoth).toHaveBeenCalledTimes(1);
  });
});
