// Truncates large file reads by preserving the head (imports/declarations) and
// the tail (exports/closing braces), while eliding the middle. This gives the
// LLM the overall structure and interfaces without burning tokens on
// thousands of lines of implementation details.
//
// Limits:
// - Keeps first 200 lines
// - Keeps last 100 lines
// - Skips if total lines < 400

const MAX_HEAD_LINES = 200;
const MAX_TAIL_LINES = 100;
const MIN_TRUNCATE_LINES = MAX_HEAD_LINES + MAX_TAIL_LINES + 100; // Require at least 100 lines to elide

export function fileRead(text) {
  if (!text) return text;

  // Fast check to avoid splitting if the text is short
  // Assuming average line length of 80 chars, MIN_TRUNCATE_LINES is ~32K chars.
  if (text.length < MIN_TRUNCATE_LINES * 20) return text;

  const lines = text.split("\n");
  if (lines.length <= MIN_TRUNCATE_LINES) return text;

  const head = lines.slice(0, MAX_HEAD_LINES);
  const tail = lines.slice(lines.length - MAX_TAIL_LINES);
  const elidedCount = lines.length - MAX_HEAD_LINES - MAX_TAIL_LINES;

  const summary = `\n... [${elidedCount} lines truncated by kRouter RTK fileRead filter] ...\n`;

  return [...head, summary, ...tail].join("\n");
}
