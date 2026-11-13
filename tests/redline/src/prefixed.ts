/**
 * Copies `from` to `to` a whole line at a time, each line prefixed. A line that
 * starts with `::` is a GitHub Actions workflow command (`::add-mask::`, ...):
 * the runner parses those only at the start of a line, so they go out bare.
 */
export function prefixLine(p: string, line: string): string {
  return /^[ \t\r]*::/.test(line) ? `${line}\n` : `${p}${line}\n`;
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
