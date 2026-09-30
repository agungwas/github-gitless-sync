import * as React from "react";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import DiffView from "./diff-view";
import {
  ConflictsResolvedScreen,
  NoConflictsScreen,
  ResetAllBar,
} from "../resolution-screens";

const UnifiedView = ({
  initialFiles,
  totalCount,
  autoCloseDelay,
  onFileResolved,
  onConfirm,
  onReset,
}: {
  // Conflicts that still need to be resolved
  initialFiles: ConflictFile[];
  // All the conflicts found by the sync, including the already resolved ones
  totalCount: number;
  autoCloseDelay: number;
  onFileResolved: (resolution: ConflictResolution) => void;
  onConfirm: () => void;
  onReset: () => void;
}) => {
  const [files, setFiles] = React.useState(initialFiles);

  const onConflictResolved = (fileIndex: number, content: string) => {
    // Remove the file from the conflicts to resolve
    setFiles(files.filter((_, index) => index !== fileIndex));
    // Keep track of the resolved conflict
    onFileResolved({
      filePath: files[fileIndex].filePath,
      content,
    });
  };

  const renderConflict = (file: ConflictFile, index: number) => {
    return (
      <div
        key={file.filePath}
        style={{
          width: "100%",
          paddingTop: "var(--size-4-4)",
          paddingBottom: "var(--size-4-4)",
          borderBottom: "1px solid var(--background-modifier-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="inline-title"
          style={{
            width: "100%",
            paddingLeft: "var(--size-4-8)",
            paddingRight: "var(--size-4-8)",
          }}
        >
          {file.filePath}
        </div>
        <DiffView
          initialRemoteText={file.remoteContent || ""}
          initialLocalText={file.localContent || ""}
          onConflictResolved={(content: string) => {
            onConflictResolved(index, content);
          }}
        />
      </div>
    );
  };

  if (files.length === 0) {
    return (
      <React.StrictMode>
        {totalCount === 0 ? (
          <NoConflictsScreen />
        ) : (
          // We solved all conflicts, once confirmed we can resume syncing
          <ConflictsResolvedScreen
            delaySeconds={autoCloseDelay}
            onConfirm={onConfirm}
            onUndo={onReset}
          />
        )}
      </React.StrictMode>
    );
  }

  return (
    <React.StrictMode>
      <div
        className="gitless-conflict-scroll"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
          paddingBottom: "100px",
        }}
      >
        {files.length < totalCount && <ResetAllBar onReset={onReset} />}
        {files.map(renderConflict)}
      </div>
    </React.StrictMode>
  );
};

export default UnifiedView;
