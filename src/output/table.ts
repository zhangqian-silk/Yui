export type TableColumn = {
  header: string;
  minWidth: number;
  maxWidth: number;
};

export function renderTable(title: string, columns: TableColumn[], rows: string[][], maxWidth: number): string {
  const widths = fitColumnWidths(columns, rows, maxWidth);
  const separator = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderedRows = [
    separator,
    renderTableRow(columns.map((column) => column.header), widths),
    separator,
    ...rows.flatMap((row) => renderWrappedTableRow(row, widths)),
    separator
  ];

  return [title, ...renderedRows].join("\n");
}

export function defaultTableWidth(): number {
  return Math.max(46, Math.min(process.stdout.columns ?? 100, 140));
}

function fitColumnWidths(columns: TableColumn[], rows: string[][], maxWidth: number): number[] {
  const widths = columns.map((column, columnIndex) => {
    const maxContentWidth = Math.max(
      column.header.length,
      ...rows.map((row) => (row[columnIndex] ?? "").length)
    );

    return Math.min(column.maxWidth, Math.max(column.minWidth, maxContentWidth));
  });
  const tableOverhead = columns.length * 3 + 1;
  const minimumTotalWidth = columns.reduce((sum, column) => sum + column.minWidth, tableOverhead);

  if (minimumTotalWidth >= maxWidth) {
    return columns.map((column) => column.minWidth);
  }

  while (widths.reduce((sum, width) => sum + width, tableOverhead) > maxWidth) {
    const shrinkIndex = widths
      .map((width, index) => ({ index, spare: width - columns[index].minWidth }))
      .sort((left, right) => right.spare - left.spare)[0];

    if (shrinkIndex === undefined || shrinkIndex.spare <= 0) {
      break;
    }

    widths[shrinkIndex.index] -= 1;
  }

  return widths;
}

function renderWrappedTableRow(row: string[], widths: number[]): string[] {
  const wrappedCells = row.map((cell, index) => wrapCell(cell, widths[index]));
  const height = Math.max(...wrappedCells.map((cell) => cell.length));
  const lines: string[] = [];

  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    lines.push(renderTableRow(wrappedCells.map((cell) => cell[lineIndex] ?? ""), widths));
  }

  return lines;
}

function renderTableRow(cells: string[], widths: number[]): string {
  return `|${cells.map((cell, index) => ` ${cell.padEnd(widths[index])} `).join("|")}|`;
}

function wrapCell(value: string, width: number): string[] {
  const words = value.length === 0 ? [""] : value.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const chunks = chunkWord(word, width);

    for (const chunk of chunks) {
      if (current.length === 0) {
        current = chunk;
        continue;
      }

      if (current.length + 1 + chunk.length <= width) {
        current = `${current} ${chunk}`;
        continue;
      }

      lines.push(current);
      current = chunk;
    }
  }

  if (current.length > 0 || lines.length === 0) {
    lines.push(current);
  }

  return lines;
}

function chunkWord(word: string, width: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }

  return chunks.length === 0 ? [""] : chunks;
}
