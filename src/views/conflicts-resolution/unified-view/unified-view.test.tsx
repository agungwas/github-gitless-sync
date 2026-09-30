import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UnifiedView from "./unified-view";

const files = () => [
  { filePath: "a.md", remoteContent: "remote a", localContent: "local a" },
  { filePath: "b.md", remoteContent: "remote b", localContent: "local b" },
];

const renderView = (overrides: Record<string, unknown> = {}) => {
  const props = {
    initialFiles: files(),
    totalCount: 2,
    autoCloseDelay: 3,
    onFileResolved: vi.fn(),
    onConfirm: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(<UnifiedView {...(props as any)} />);
  return props;
};

describe("UnifiedView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every resolved file and only confirms after the countdown", () => {
    const props = renderView();

    fireEvent.click(screen.getAllByText("Accept all local")[0]);
    expect(props.onFileResolved).toHaveBeenLastCalledWith({
      filePath: "a.md",
      content: "local a",
    });
    expect(screen.getByText("b.md")).toBeDefined();
    expect(screen.queryByText("All conflicts resolved")).toBeNull();

    fireEvent.click(screen.getByText("Accept all remote"));
    expect(props.onFileResolved).toHaveBeenLastCalledWith({
      filePath: "b.md",
      content: "remote b",
    });
    expect(screen.getByText("All conflicts resolved")).toBeDefined();
    expect(props.onConfirm).not.toHaveBeenCalled();

    // Each tick schedules the next one after React re-rendered
    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("offers to reset everything once a file has been resolved", () => {
    const props = renderView();
    expect(screen.queryByText("Reset all conflicts")).toBeNull();

    fireEvent.click(screen.getAllByText("Accept all local")[0]);
    fireEvent.click(screen.getByText("Reset all conflicts"));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("shows the no conflicts message when there never were conflicts", () => {
    renderView({ initialFiles: [], totalCount: 0 });
    expect(screen.getByText("No conflicts to resolve")).toBeDefined();
  });

  it("starts from the unresolved files only", () => {
    const props = renderView({
      initialFiles: [files()[1]],
      totalCount: 2,
    });
    expect(screen.queryByText("a.md")).toBeNull();
    expect(screen.getByText("b.md")).toBeDefined();
    // One file was already resolved before the view was opened
    expect(screen.getByText("Reset all conflicts")).toBeDefined();
    expect(props.onFileResolved).not.toHaveBeenCalled();
  });
});
