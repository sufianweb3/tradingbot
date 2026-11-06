export function downloadFile(
  filename: string,
  contents: string,
  mime = "text/plain;charset=utf-8",
) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function tradesToCsv(
  rows: Array<Record<string, string | number>>,
  columns: Array<{ key: string; label: string }>,
) {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.map((column) => escape(column.label)).join(","),
    ...rows.map((row) =>
      columns.map((column) => escape(row[column.key] ?? "")).join(","),
    ),
  ].join("\n");
}
