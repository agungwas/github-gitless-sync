import * as React from "react";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import DiffView from "./diff-view";
import FilesTabBar from "./files-tab-bar";
import {
  ConflictsResolvedScreen,
  NoConflictsScreen,
  ResetAllBar,
} from "../resolution-screens";

const SplitView = ({
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
  const [currentFileIndex, setCurrentFileIndex] = React.useState(0);
  const currentFile = files.at(currentFileIndex);

  const onConflictResolved = () => {
    // Remove the file from the conflicts to resolve
    const remainingFiles = files.filter(
      (_, index) => index !== currentFileIndex,
    );
    setFiles(remainingFiles);
    // Keep track of the resolved conflict
    onFileResolved({
      filePath: currentFile!.filePath,
      content: currentFile!.localContent,
    });
    // Select the previous file only if we're not already at the start
    if (currentFileIndex > 0) {
      setCurrentFileIndex(currentFileIndex - 1);
    }
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
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
        }}
      >
        {files.length < totalCount && <ResetAllBar onReset={onReset} />}
        <FilesTabBar
          files={files.map((f) => f.filePath)}
          currentFile={currentFile?.filePath || ""}
          setCurrentFileIndex={setCurrentFileIndex}
        />
        <div
          style={{
            overflow: "auto",
            flex: 1,
          }}
        >
          <DiffView
            remoteText={currentFile?.remoteContent || ""}
            localText={currentFile?.localContent || ""}
            onRemoteTextChange={(content: string) => {
              const tempFiles = [...files];
              tempFiles[currentFileIndex].remoteContent = content;
              setFiles(tempFiles);
            }}
            onLocalTextChange={(content: string) => {
              const tempFiles = [...files];
              tempFiles[currentFileIndex].localContent = content;
              setFiles(tempFiles);
            }}
            onConflictResolved={onConflictResolved}
          />
        </div>
      </div>
    </React.StrictMode>
  );
};

export default SplitView;
