import * as React from "react";

const screenStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  margin: "20px 0",
  fontWeight: "var(--h2-weight)",
  fontSize: "var(--h2-size)",
  lineHeight: "var(--line-height-tight)",
};

const subtitleStyle: React.CSSProperties = {
  margin: "20px 0",
  fontSize: "var(--font-text-size)",
  color: "var(--text-muted)",
  lineHeight: "var(--line-height-tight)",
};

/// Shown when the conflicts view has nothing to resolve, for example when it
/// gets opened manually while there are no conflicts.
export const NoConflictsScreen = () => (
  <div style={screenStyle}>
    <div style={titleStyle}>No conflicts to resolve</div>
    <div style={subtitleStyle}>That's good, keep going</div>
  </div>
);

/// Shown after the last conflict has been resolved. Counts down and then
/// confirms the resolutions automatically, unless the user undoes them.
/// With a delay of 0 it confirms right away.
export const ConflictsResolvedScreen = ({
  delaySeconds,
  onConfirm,
  onUndo,
}: {
  delaySeconds: number;
  onConfirm: () => void;
  onUndo: () => void;
}) => {
  const [remaining, setRemaining] = React.useState(delaySeconds);
  const confirmedRef = React.useRef(false);

  const confirm = React.useCallback(() => {
    if (confirmedRef.current) {
      return;
    }
    confirmedRef.current = true;
    onConfirm();
  }, [onConfirm]);

  React.useEffect(() => {
    if (remaining <= 0) {
      confirm();
      return;
    }
    const timeout = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timeout);
  }, [remaining, confirm]);

  if (delaySeconds <= 0) {
    return null;
  }

  return (
    <div style={screenStyle}>
      <div style={titleStyle}>All conflicts resolved</div>
      <div style={subtitleStyle}>Closing in {remaining}s…</div>
      <div style={{ display: "flex", gap: "var(--size-4-4)" }}>
        <button
          style={{
            backgroundColor: "var(--interactive-accent)",
            color: "var(--text-on-accent)",
          }}
          onClick={confirm}
        >
          OK
        </button>
        <button onClick={onUndo}>Undo</button>
      </div>
    </div>
  );
};

/// Bar with the action to restore every conflict, shown once at least
/// one file has been resolved.
export const ResetAllBar = ({ onReset }: { onReset: () => void }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "flex-end",
      padding: "var(--size-4-2) var(--size-4-4)",
      borderBottom: "1px solid var(--background-modifier-border)",
    }}
  >
    <button onClick={onReset}>Reset all conflicts</button>
  </div>
);
