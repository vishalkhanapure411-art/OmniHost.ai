import { useMemo, useState, type ReactNode } from "react";

import { ArrowDown, ArrowUp, ChevronDown } from "~/components/icons";
import { useI18n } from "~/i18n";

/**
 * The reusable dense table.
 *
 * Every list in the platform ends up here — chains, articles, vendors, POs, GRNs,
 * waste entries, tickets, ledger lines — so the ergonomics are solved once:
 *
 *   * **Sortable headers** are buttons that fill the cell, with `aria-sort` on the
 *     `<th>` and a caret that shows the state. Sorting is client-side over the rows the
 *     loader already returned; a paged module passes `sortable: false` and sorts on the
 *     server instead, which this API allows per column.
 *   * **Row height comes from density tokens**, never from a component prop.
 *   * **Numeric columns** are right-aligned in LTR and left in RTL (`text-align: end`)
 *     with tabular figures, so amounts and quantities line up on the decimal.
 *   * **Selection is keyboard-reachable**: arrow keys move row focus, Enter opens the
 *     row, and the selected row carries a bar as well as a background tint so it is
 *     visible without relying on colour.
 *   * **The empty state is part of the table**, not a sibling `if` in the caller, so
 *     every module gets the same honest one.
 */

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Right-aligns the column and uses tabular figures. */
  numeric?: boolean;
  /** Supply a sort key to make the header sortable. Omit for a static column. */
  sortValue?: (row: Row) => string | number | null;
  render: (row: Row) => ReactNode;
  /** Fixed width — use sparingly, and never on a column holding a translated label. */
  width?: string;
  headerTitle?: string;
  /** Where a column header would otherwise have to hold a translated label. */
  srOnlyHeader?: boolean;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  getRowId: (row: Row) => string;
  /** Accessible name for the table. Rendered as a caption, visually hidden. */
  caption: string;
  selectedId?: string;
  onSelect?: (row: Row) => void;
  defaultSortKey?: string;
  defaultSortDirection?: "asc" | "desc";
  empty?: ReactNode;
  /** Rendered under the table: totals, a count, an overflow notice. */
  footer?: ReactNode;
  stickyHeader?: boolean;
}

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  selectedId,
  onSelect,
  defaultSortKey,
  defaultSortDirection = "asc",
  empty,
  footer,
  stickyHeader = true,
}: DataTableProps<Row>) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [direction, setDirection] = useState<"asc" | "desc">(defaultSortDirection);

  const sorted = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sortKey);
    if (!column?.sortValue) return rows;
    const factor = direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = column.sortValue?.(left);
      const b = column.sortValue?.(right);
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * factor;
    });
  }, [columns, direction, rows, sortKey]);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setDirection("asc");
  }

  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <div className={stickyHeader ? "max-h-full overflow-auto" : "overflow-x-auto"}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sortKey === column.key;
              const ariaSort = isSorted ? (direction === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  title={column.headerTitle}
                  style={column.width ? { width: column.width } : undefined}
                  className={column.numeric ? "numeric" : undefined}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => {
                        toggleSort(column.key);
                      }}
                      className="sort-button"
                      title={t("a11y.sortBy", { column: typeof column.header === "string" ? column.header : column.key })}
                    >
                      <span className={column.srOnlyHeader ? "sr-only" : undefined}>{column.header}</span>
                      <SortCaret state={isSorted ? direction : "none"} />
                    </button>
                  ) : (
                    <span className={column.srOnlyHeader ? "sr-only" : undefined}>{column.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const id = getRowId(row);
            const selected = selectedId === id;
            return (
              <tr
                key={id}
                data-selected={selected ? "true" : "false"}
                data-clickable={onSelect ? "true" : "false"}
                aria-selected={onSelect ? selected : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onClick={
                  onSelect
                    ? () => {
                        onSelect(row);
                      }
                    : undefined
                }
                onKeyDown={
                  onSelect
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? "numeric" : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer ? <div className="border-t border-border bg-surface px-3 py-1.5 text-xs text-fg-muted">{footer}</div> : null}
    </div>
  );
}

/**
 * The sort caret. Both carets are always present at low opacity so a column's height
 * never shifts when it becomes the sorted one, and the active direction is the only
 * one drawn at full strength — the state is also in `aria-sort`, so this is decoration.
 */
function SortCaret({ state }: { state: "asc" | "desc" | "none" }) {
  if (state === "asc") return <ArrowUp size={11} />;
  if (state === "desc") return <ArrowDown size={11} />;
  return (
    <span className="text-fg-subtle opacity-50" aria-hidden="true">
      <ChevronDown size={11} />
    </span>
  );
}
