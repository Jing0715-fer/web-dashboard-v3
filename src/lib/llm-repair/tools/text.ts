/**
 * Text decoding + display sanitizing for the LLM repair agent.
 *
 * Why this module exists (incident: SciWrite · prod · start, 12-step budget
 * exhausted WITHOUT ever reading the actual error):
 *   Real-world build/CI logs are frequently NOT clean UTF-8 text:
 *     - Windows PowerShell `>` redirection writes UTF-16LE (with BOM)
 *     - Windows cmd.exe `>` writes the OEM/ANSI code page (GBK, CP437, …)
 *     - next/vite/npm output is full of ANSI color escape sequences
 *   The old `readFileSync(path, 'utf8')` + NUL-check pipeline classified all
 *   of these as "binary/non-UTF8 — cannot display", so the agent burned 10 of
 *   its 12 tool steps trying to read one build log with shell tricks
 *   (findstr, powershell, `type | more` — the pager hung) and never reached
 *   an actual fix. Decoding logs properly in the read tool removes the entire
 *   failure class: step 1 reads the log, step 2+ fixes the reported error.
 *
 * Exports:
 *   - decodeTextBuffer(buf):     best-effort Buffer → string (UTF-16 BOM +
 *     no-BOM heuristic, UTF-8 BOM strip; invalid bytes become U+FFFD, ASCII
 *     error lines stay readable either way)
 *   - stripAnsiAndControls(s):   removes ANSI CSI/OSC sequences and stray C0
 *     control characters so logs render as clean text; reports whether it
 *     changed anything
 *   - countReplacementChars(s):  how many U+FFFD survived decoding — callers
 *     surface this as an honest "non-UTF8, best-effort" note instead of
 *     refusing the file
 */

// ---- decoding -----------------------------------------------------------

/** Decode a raw file buffer to text with the encodings real logs use.
 *  NUL bytes are PRESERVED in the output (for genuinely binary files the
 *  caller's binary check must still fire); UTF-16 decode removes them
 *  implicitly because high bytes of ASCII become part of the code unit. */
export function decodeTextBuffer(buf: Buffer): string {
  if (buf.length === 0) return '';

  // 1. UTF-16 with BOM — PowerShell `>` redirection default on Windows.
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le');
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16BE: byte-swap each code unit, then decode as LE.
      const swapped = Buffer.from(buf.subarray(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const b = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = b;
      }
      return swapped.toString('utf16le');
    }
  }

  // 2. UTF-16LE WITHOUT BOM heuristic: ASCII-heavy text places a 0x00 at
  //    every odd offset. Require a high odd-position NUL density and almost
  //    no even-position NULs — arbitrary binary data fails the second half
  //    and falls through to UTF-8 (where the caller's NUL check catches it).
  const sample = buf.subarray(0, 4096);
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 1) oddNul++;
      else evenNul++;
    }
  }
  const oddSlots = Math.max(1, Math.floor(sample.length / 2));
  if (oddNul > oddSlots * 0.2 && evenNul < oddSlots * 0.02) {
    return buf.toString('utf16le');
  }

  // 3. UTF-8 (with BOM stripped). Invalid sequences decode as U+FFFD — the
  //    ASCII error lines inside OEM-codepage logs remain fully readable.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

// ---- display sanitizing --------------------------------------------------

/**
 * ANSI escape sequences (CSI "ESC[…m", OSC "ESC]…BEL/ST", two-char ESC X)
 * plus stray C0 control characters (\x0b, \x0c, leftover NULs, …) make logs
 * unreadable and made the old binary check misfire. Tab/newline/CR are kept.
 */
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsiAndControls(s: string): { text: string; stripped: boolean } {
  const text = s.replace(ANSI_ESCAPE_RE, '').replace(CONTROL_CHARS_RE, '');
  return { text, stripped: text.length !== s.length };
}

/** Count U+FFFD replacement characters — the honest "how much was
 *  undecodable" metric for non-UTF8 (OEM codepage) logs. */
export function countReplacementChars(s: string): number {
  return (s.match(/\ufffd/g) || []).length;
}
