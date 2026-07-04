const SEGMENT_WILDCARD = "*";
const DEEP_WILDCARD = "**";
const MAX_PATTERN_LENGTH = 500;

// Two-pointer "star bookmark" matcher (same family as the classic Wildcard
// Matching algorithm) -- NOT a backtracking regex. Worst case O(n*m): each
// retry strictly advances the bookmarked text index, so no (patternIdx,
// textIdx) pair is ever revisited. This is what makes it safe against
// wildcard-heavy patterns that would catastrophically backtrack a regex engine.
function matchSegment(patternSegment: string, textSegment: string): boolean {
  let patternIdx = 0;
  let textIdx = 0;
  let starPatternIdx = -1;
  let starTextIdx = -1;

  while (textIdx < textSegment.length) {
    if (patternIdx < patternSegment.length && patternSegment[patternIdx] === SEGMENT_WILDCARD) {
      starPatternIdx = patternIdx;
      starTextIdx = textIdx;
      patternIdx++;
    } else if (
      patternIdx < patternSegment.length &&
      patternSegment[patternIdx] === textSegment[textIdx]
    ) {
      patternIdx++;
      textIdx++;
    } else if (starPatternIdx !== -1) {
      patternIdx = starPatternIdx + 1;
      starTextIdx++;
      textIdx = starTextIdx;
    } else {
      return false;
    }
  }

  while (patternIdx < patternSegment.length && patternSegment[patternIdx] === SEGMENT_WILDCARD) {
    patternIdx++;
  }
  return patternIdx === patternSegment.length;
}

// DP over segment sequences: "**" may consume zero or more whole segments.
// O(patternSegments.length * pathSegments.length) -- both are small (tens,
// not thousands) for any realistic vault path, so this stays trivially fast
// even with many "**" tokens.
function matchSegmentSequence(patternSegments: string[], pathSegments: string[]): boolean {
  const matchesUpTo: boolean[][] = Array.from({ length: patternSegments.length + 1 }, () =>
    new Array(pathSegments.length + 1).fill(false),
  );
  matchesUpTo[0][0] = true;

  for (let patternIdx = 0; patternIdx <= patternSegments.length; patternIdx++) {
    for (let pathIdx = 0; pathIdx <= pathSegments.length; pathIdx++) {
      if (patternIdx === 0 && pathIdx === 0) continue;

      if (patternIdx > 0 && patternSegments[patternIdx - 1] === DEEP_WILDCARD) {
        matchesUpTo[patternIdx][pathIdx] =
          matchesUpTo[patternIdx - 1][pathIdx] ||
          (pathIdx > 0 && matchesUpTo[patternIdx][pathIdx - 1]);
      } else if (patternIdx > 0 && pathIdx > 0) {
        matchesUpTo[patternIdx][pathIdx] =
          matchesUpTo[patternIdx - 1][pathIdx - 1] &&
          matchSegment(patternSegments[patternIdx - 1], pathSegments[pathIdx - 1]);
      }
    }
  }

  return matchesUpTo[patternSegments.length][pathSegments.length];
}

export function matchesGlobPattern(pattern: string, filePath: string): boolean {
  const isDirPattern = pattern.endsWith("/");
  const patternBody = isDirPattern ? pattern.slice(0, -1) : pattern;
  const patternSegments = patternBody.split("/");
  if (isDirPattern) {
    // Trailing "/" means "this dir and everything under it" -- equivalent to
    // an implicit "**" after the dir's own segments.
    patternSegments.push(DEEP_WILDCARD);
  }
  return matchSegmentSequence(patternSegments, filePath.split("/"));
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed === "") return false;
    if (trimmed.length > MAX_PATTERN_LENGTH) return false;
    try {
      return matchesGlobPattern(trimmed, filePath);
    } catch {
      return false;
    }
  });
}

export function isExcludedPath(
  filePath: string,
  excludePatterns: string[],
  includePatterns: string[],
): boolean {
  return matchesAny(filePath, excludePatterns) && !matchesAny(filePath, includePatterns);
}
