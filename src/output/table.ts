import { padVisibleEnd, visibleWidth, wrapVisibleText } from "./terminal.js";

export type TableColumn = {
  header: string;
  minWidth: number;
  maxWidth: number;
};

export function renderTable(
  title: string,
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  maxWidth: number
): string {
  if (columns.length === 0) return title;
  const availableWidth = Math.max(20, Math.floor(maxWidth));
  const minimumWidth = tableWidth(columns.map((column) => column.minWidth));
  if (minimumWidth > availableWidth) return renderRecords(title, columns, rows, availableWidth);

  const widths = fitColumnWidths(columns, rows, availableWidth);
  return [
    ...wrapVisibleText(title, availableWidth),
    "",
    renderTableRow(columns.map((column) => column.header), widths),
    `  ${widths.map((width) => "─".repeat(width)).join("  ")}`,
    ...rows.flatMap((row) => renderWrappedTableRow(row, widths))
  ].join("\n");
}

export function defaultTableWidth(): number {
  return Math.max(46, Math.min(process.stdout.columns ?? 100, 140));
}

function fitColumnWidths(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  maxWidth: number
): number[] {
  const widths = columns.map((column, columnIndex) => {
    const contentWidths = rows.flatMap((row) =>
      (row[columnIndex] ?? "").split("\n").map(visibleWidth)
    );
    const maxContentWidth = Math.max(visibleWidth(column.header), ...contentWidths);
    return Math.min(column.maxWidth, Math.max(column.minWidth, maxContentWidth));
  });
  while (tableWidth(widths) > maxWidth) {
    const shrink = widths.map((width, index) => ({
      index,
      spare: width - (columns[index]?.minWidth ?? width)
    })).sort((left, right) => right.spare - left.spare)[0];
    if (shrink === undefined || shrink.spare <= 0) break;
    widths[shrink.index] = (widths[shrink.index] ?? 1) - 1;
  }
  return widths;
}

function renderWrappedTableRow(row: readonly string[], widths: readonly number[]): string[] {
  const cells = widths.map((width, index) => wrapVisibleText(row[index] ?? "", width));
  const height = Math.max(...cells.map((cell) => cell.length));
  return Array.from({ length: height }, (_, lineIndex) =>
    renderTableRow(cells.map((cell) => cell[lineIndex] ?? ""), widths)
  );
}

function renderTableRow(cells: readonly string[], widths: readonly number[]): string {
  return `  ${cells.map((cell, index) => padVisibleEnd(cell, widths[index] ?? 1)).join("  ").trimEnd()}`;
}

function tableWidth(widths: readonly number[]): number {
  return 2 + widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2;
}

function renderRecords(
  title: string,
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  maxWidth: number
): string {
  const indexColumn = columns[0]?.header === "#" ? 0 : undefined;
  const primaryColumn = indexColumn === 0 && columns.length > 1 ? 1 : 0;
  const detailColumns = columns.map((_, index) => index)
    .filter((index) => index !== indexColumn && index !== primaryColumn);
  const labelWidth = Math.max(0, ...detailColumns.map((index) => visibleWidth(columns[index]?.header ?? "")));
  const lines = [...wrapVisibleText(title, maxWidth), ""];

  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push("");
    const indexValue = indexColumn === undefined ? "" : row[indexColumn] ?? "";
    const primaryValue = row[primaryColumn] ?? "";
    const primaryPrefix = `  ${indexValue.length === 0 ? "" : `${indexValue}  `}`;
    const primaryLines = wrapVisibleText(primaryValue, Math.max(1, maxWidth - visibleWidth(primaryPrefix)));
    lines.push(`${primaryPrefix}${primaryLines[0] ?? ""}`.trimEnd());
    lines.push(...primaryLines.slice(1).map((line) => `${" ".repeat(visibleWidth(primaryPrefix))}${line}`));

    for (const columnIndex of detailColumns) {
      const value = row[columnIndex] ?? "";
      if (value.length === 0) continue;
      const header = columns[columnIndex]?.header ?? "";
      const prefix = `     ${padVisibleEnd(header, labelWidth)}  `;
      const wrapped = wrapVisibleText(value, Math.max(1, maxWidth - visibleWidth(prefix)));
      lines.push(`${prefix}${wrapped[0] ?? ""}`.trimEnd());
      lines.push(...wrapped.slice(1).map((line) => `${" ".repeat(visibleWidth(prefix))}${line}`));
    }
  });
  return lines.join("\n");
}
