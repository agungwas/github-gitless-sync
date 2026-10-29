import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UnifiedView from "./unified-view/unified-view";
import SplitView from "./split-view/split-view";
import { ConflictFile } from "../../sync-manager";

describe.each([
  { name: "unified", View: UnifiedView },
  { name: "split", View: SplitView },
])("plugin uninstall confirmation in $name view", ({ View }) => {
  afterEach(cleanup);

  it.each([
    { choice: "keep-local", label: "Keep installed" },
    { choice: "accept-uninstall", label: "Uninstall" },
  ])("preserves $choice until confirmation", ({ choice, label }) => {
    const path = ".obsidian/plugins/quickadd/manifest.json";
    const files: ConflictFile[] = [{
      filePath: path,
      localContent: '{"id":"quickadd","version":"2.32.1"}',
      remoteContent: "",
      pluginUninstall: {
        pluginId: "quickadd", localPaths: [path], changedPaths: [path],
      },
    }];
    const onFileResolved = vi.fn();
    const onConfirm = vi.fn();
    render(<View initialFiles={files} totalCount={1} autoCloseDelay={3}
      onFileResolved={onFileResolved} onConfirm={onConfirm} onReset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onFileResolved).toHaveBeenCalledWith({
      filePath: path, content: files[0].localContent, pluginUninstallChoice: choice,
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("All conflicts resolved")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
