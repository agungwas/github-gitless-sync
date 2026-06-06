import * as React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

import diff, { DiffChunk } from "../diff";
import { createRangesStateField } from "./ranges-state-field";
import {
  createLineDecorations,
  createResolutionDecorations,
} from "./decorations";

interface DiffViewProps {
  initialRemoteText: string;
  initialLocalText: string;
  onConflictResolved: (content: string) => void;
}

/// Create a unique document that combines text from the remote
/// and the local document depending on the diff chunks.
/// This returns a single string of the combined documents and the
/// ranges that specify whether a certain document range comes from
/// remote, local or both documents, so we can highlight them.
const createUnifiedDocument = (
  remoteText: string,
  localText: string,
  diffChunks: DiffChunk[],
): { doc: string; lineRanges: ConflictRange[] } => {
  const sortedChunks = [...diffChunks].sort(
    (a, b) => a.startLeftLine - b.startLeftLine,
  );

  const remoteLines = remoteText.split(/\r?\n/);
  const localLines = localText.split(/\r?\n/);

  let result: string[] = [];
  let lineRanges: ConflictRange[] = [];
  let linePosition = 0;
  let currentRange: ConflictRange | null = null;

  let remoteTextLine = 1;
  let localTextLine = 1;

  const addLine = (line: string, source: "remote" | "local" | "both") => {
    result.push(line);

    const startPos = linePosition;
    const endPos = linePosition + line.length;

    if (currentRange && currentRange.source === source) {
      // Extend existing range
      currentRange.to = endPos;
    } else {
      // Create new range
      if (currentRange) {
        lineRanges.push(currentRange);
      }
      currentRange = { from: startPos, to: endPos, source };
    }

    // Move position to start of next line
    linePosition = endPos + 1; // +1 for newline
  };

  // Process each chunk
  for (const chunk of sortedChunks) {
    // Add common lines before the chunk
    while (
      remoteTextLine < chunk.startLeftLine &&
      localTextLine < chunk.startRightLine
    ) {
      addLine(remoteLines[remoteTextLine - 1], "both");
      remoteTextLine++;
      localTextLine++;
    }

    // Add removed lines (from old text)
    for (let i = remoteTextLine; i < chunk.endLeftLine; i++) {
      addLine(remoteLines[i - 1], "remote");
    }

    // Add added lines (from new text)
    for (let i = localTextLine; i < chunk.endRightLine; i++) {
      addLine(localLines[i - 1], "local");
    }

    // Update line pointers
    remoteTextLine = chunk.endLeftLine;
    localTextLine = chunk.endRightLine;
  }

  // Add remaining common lines after the last chunk
  while (
    remoteTextLine <= remoteLines.length &&
    localTextLine <= localLines.length
  ) {
    if (
      remoteTextLine > remoteLines.length ||
      localTextLine > localLines.length
    )
      break;
    addLine(remoteLines[remoteTextLine - 1], "both");
    remoteTextLine++;
    localTextLine++;
  }

  // Add the final range if there is one
  if (currentRange) {
    lineRanges.push(currentRange);
  }

  return { doc: result.join("\n"), lineRanges };
};

const DiffView: React.FC<DiffViewProps> = ({
  initialRemoteText,
  initialLocalText,
  onConflictResolved,
}) => {
  const editorViewRef = React.useRef<EditorView | null>(null);

  // Memoize so these are stable references across re-renders.
  // Without this, lineRanges would be a new array on every render (e.g. when
  // setHasConflicts fires), causing the extensions useMemo below to recompute
  // and recreate the rangesStateField with original values — resetting all
  // conflict resolution progress and blanking the editor.
  const { diffChunks, doc, lineRanges } = React.useMemo(() => {
    const chunks = diff(initialRemoteText, initialLocalText);
    const unified = createUnifiedDocument(initialRemoteText, initialLocalText, chunks);
    return { diffChunks: chunks, doc: unified.doc, lineRanges: unified.lineRanges };
  }, [initialRemoteText, initialLocalText]);

  const [hasConflicts, setHasConflicts] = React.useState(diffChunks.length > 0);
  const [resetKey, setResetKey] = React.useState(0);

  const resetConflicts = () => {
    setResetKey((prev) => prev + 1);
    setHasConflicts(diffChunks.length > 0);
  };

  // Use a ref instead of useMemo to guarantee extensions stability.
  // React's useMemo is a performance hint, not a semantic guarantee — it may
  // discard and recompute the value even when deps haven't changed. If that
  // happens mid-session, react-codemirror calls view.reconfigure(), which
  // re-initialises the StateField with the original lineRanges (positions
  // based on the full original document) while the current doc is already
  // shorter due to user resolution actions. The decoration compute then calls
  // lineAt() with an out-of-bounds position and throws RangeError.
  // The component is keyed on resetKey, so a reset triggers a full remount
  // and this ref is naturally re-initialised to null.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensionsRef = React.useRef<any[] | null>(null);
  if (extensionsRef.current === null) {
    const conflictRangesField = createRangesStateField(lineRanges);
    extensionsRef.current = [
      conflictRangesField,
      createLineDecorations(conflictRangesField),
      createResolutionDecorations(
        conflictRangesField,
        () => editorViewRef.current!,
      ),
      EditorView.updateListener.of((update) => {
        const conflictRanges = update.state.field(conflictRangesField);
        const hasUnsolved = conflictRanges.some(
          (range) => range.source === "remote" || range.source === "local",
        );
        setHasConflicts(hasUnsolved);
      }),
      EditorView.editable.of(true),
      EditorView.theme({
        "&": {
          backgroundColor: "var(--background-primary)",
          color: "var(--text-normal)",
          borderTop: "1px solid var(--background-modifier-border)",
          borderBottom: "1px solid var(--background-modifier-border)",
        },
        ".cm-content": {
          padding: 0,
          caretColor: "var(--caret-color)",
          fontSize: "var(--font-text-size)",
          fontFamily: "var(--font-text)",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "var(--text-selection)",
        },
        "&.cm-focused": {
          outline: 0,
        },
        "&.cm-focused .cm-cursor": {
          borderLeftColor: "var(--text-normal)",
        },
        ".cm-addedLine": {
          backgroundColor: "rgba(var(--color-green-rgb, 71, 167, 71), 0.15)",
        },
        ".cm-deletedLine": {
          backgroundColor: "rgba(var(--color-red-rgb, 251, 70, 76), 0.15)",
        },
      }),
    ];
  }
  const extensions = extensionsRef.current;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <CodeMirror
        key={resetKey}
        value={doc}
        theme="none"
        basicSetup={false}
        extensions={extensions}
        onCreateEditor={(view: EditorView) => {
          editorViewRef.current = view;
        }}
      />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "var(--size-4-4)",
          paddingTop: "var(--size-4-4)",
        }}
      >
        <button onClick={() => onConflictResolved(initialRemoteText)}>
          Accept all remote
        </button>
        <button onClick={() => onConflictResolved(initialLocalText)}>
          Accept all local
        </button>
        <button onClick={resetConflicts}>Reset conflicts</button>
        <button
          style={
            hasConflicts
              ? {}
              : {
                  backgroundColor: "var(--interactive-accent)",
                  color: "var(--text-on-accent)",
                }
          }
          disabled={hasConflicts}
          onClick={() => {
            const content = editorViewRef.current!.state.doc.toString();
            onConflictResolved(content);
          }}
        >
          Resolve conflict
        </button>
      </div>
    </div>
  );
};

export default DiffView;
