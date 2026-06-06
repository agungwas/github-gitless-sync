import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DiffView from "./diff-view";

describe("Unified DiffView", () => {
  it("should have flexWrap: 'wrap' on the bottom buttons container to prevent mobile overflow", () => {
    render(
      <DiffView
        initialRemoteText="remote"
        initialLocalText="local"
        onConflictResolved={() => {}}
      />
    );

    // Find the 'Reset conflicts' button and check its parent container's style
    const resetButton = screen.getByText("Reset conflicts");
    const container = resetButton.parentElement;

    expect(container).toBeDefined();
    expect(container?.style.display).toBe("flex");
    expect(container?.style.flexWrap).toBe("wrap"); // This should fail before the fix
  });
});
