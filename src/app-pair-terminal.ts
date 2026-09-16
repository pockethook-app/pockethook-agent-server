/** Two square QR modules per terminal cell; explicit colors work on light and dark themes. */
export function terminalQRCode(matrix: unknown, columns?: number): string | undefined {
  if (!Array.isArray(matrix) || matrix.length < 1 || matrix.length > 185
    || !matrix.every(row => typeof row === "string" && row.length === matrix.length && /^[01]+$/.test(row))) {
    throw new Error("Could not read the QR image for terminal display.");
  }
  // Wrapping even one row would make the QR unreadable. The PNG remains available.
  if (columns !== undefined && columns > 0 && columns < matrix.length) return undefined;

  const lines: string[] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let line = "";
    for (let x = 0; x < matrix.length; x++) {
      const top = matrix[y][x] === "1";
      const bottom = matrix[y + 1]?.[x] === "1";
      line += top ? (bottom ? "█" : "▀") : (bottom ? "▄" : " ");
    }
    lines.push(`\x1b[38;2;0;0;0m\x1b[48;2;255;255;255m${line}\x1b[0m`);
  }
  return lines.join("\n");
}
