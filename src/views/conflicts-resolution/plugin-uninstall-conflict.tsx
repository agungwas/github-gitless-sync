import * as React from "react";

export type PluginUninstallChoice = "keep-local" | "accept-uninstall";

export default function PluginUninstallConflict({
  pluginId,
  localPaths,
  onResolve,
}: {
  pluginId: string;
  localPaths: string[];
  onResolve: (choice: PluginUninstallChoice) => void;
}) {
  return (
    <section className="gitless-plugin-uninstall-conflict" role="group" aria-label={`Uninstall conflict for ${pluginId}`}>
      <h2>Plugin removal conflict: {pluginId}</h2>
      <p>Another device removed this plugin, while this device has local changes in:</p>
      <ul>{localPaths.map((path) => <li key={path}>{path}</li>)}</ul>
      <button onClick={() => onResolve("keep-local")}>Keep installed</button>
      <button onClick={() => onResolve("accept-uninstall")}>Uninstall</button>
    </section>
  );
}
