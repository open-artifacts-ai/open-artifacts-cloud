/**
 * Copies `from` to `to` a whole line at a time, each line prefixed. Only a
 * `::add-mask::` line goes out bare: the runner parses workflow commands only
 * at the start of a line, so a prefix would leave the secret unmasked. Every
 * other `::cmd::` (such as `::stop-commands::`) keeps the prefix, so test
 * output cannot switch masking off.
 */
export function prefixLine(p: string, line: string): string {
  return /^[ \t\r]*::add-mask::/.test(line) ? `${line}\n` : `${p}${line}\n`;
}

export function prefixed(
  from: NodeJS.ReadableStream,
  to: { write(s: string): unknown },
  p: string,
) {
  let rest = "";
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) to.write(prefixLine(p, l));
  });
  from.on("end", () => {
    if (rest) to.write(prefixLine(p, rest));
  });
}
