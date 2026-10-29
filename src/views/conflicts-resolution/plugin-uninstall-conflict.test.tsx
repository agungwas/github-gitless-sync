import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PluginUninstallConflict from "./plugin-uninstall-conflict";

describe("PluginUninstallConflict", () => {
  it("shows both explicit choices and reports the selected resolution", () => {
    const onResolve = vi.fn();
    render(<PluginUninstallConflict
      pluginId="quickadd"
      localPaths={[".obsidian/plugins/quickadd/data.json"]}
      onResolve={onResolve}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Keep installed" }));
    expect(onResolve).toHaveBeenLastCalledWith("keep-local");
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    expect(onResolve).toHaveBeenLastCalledWith("accept-uninstall");
    expect(screen.getByText(".obsidian/plugins/quickadd/data.json")).toBeTruthy();
  });
});
