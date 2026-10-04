/**
 * Progress logging for long-running steps. A Log is just a line sink; the
 * commands decide where it goes (indented under the current PR).
 */
export type Log = (line: string) => void;

export const silent: Log = () => {};

/** Indented, timestamped lines on stdout — e.g. under a "[3/10] #2711" header. */
export function stepLogger(indent = "      "): Log {
  return (line) => {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`${indent}${t} ${line}`);
  };
}

export const kb = (chars: number) => `${Math.round(chars / 1024)}KB`;
export const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
/** Rough token estimate (~4 chars/token), e.g. "800" or "21k". */
export const tokens = (chars: number) => {
  const t = Math.round(chars / 4);
  return t < 1000 ? String(t) : `${Math.round(t / 1000)}k`;
};
