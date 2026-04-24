import { StringDecoder } from "node:string_decoder";

/**
 * Stateful byte-to-trimmed-line decoder used by NDJSON-emitting CLI adapters.
 *
 * Wraps `node:string_decoder` so incomplete multi-byte UTF-8 sequences are
 * buffered across chunk boundaries (without this, a chunk that splits a
 * multi-byte char emits U+FFFD and corrupts any non-ASCII content that
 * unluckily lands on the boundary). Line splitting + trimming + empty-line
 * suppression are collapsed into one helper so the four adapters can drop
 * their copy-pasted `let lineBuffer = ""` + decoder + split/trim blocks.
 *
 * The returned object is independent per call — don't share across streams.
 */
export interface LineDecoder {
  /** Feed a chunk; return all complete, trimmed, non-empty lines. */
  feed(chunk: Buffer): string[];
  /**
   * Flush any buffered bytes as a final trimmed string. Returns `""` when
   * the tail is empty or whitespace-only — callers should check before using.
   */
  flush(): string;
}

export function createLineDecoder(): LineDecoder {
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";
  return {
    feed(chunk: Buffer): string[] {
      lineBuffer += decoder.write(chunk);
      const parts = lineBuffer.split("\n");
      lineBuffer = parts.pop() ?? "";
      const lines: string[] = [];
      for (const raw of parts) {
        const trimmed = raw.trim();
        if (trimmed) lines.push(trimmed);
      }
      return lines;
    },
    flush(): string {
      lineBuffer += decoder.end();
      const trimmed = lineBuffer.trim();
      lineBuffer = "";
      return trimmed;
    },
  };
}
