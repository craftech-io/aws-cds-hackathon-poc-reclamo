// Table of an inbox: the columns of Table plus, optionally, a checkbox per row for batch actions
// and a row that opens its detail. The row is focusable and opens with Enter, and the checkbox
// never opens the row, so selecting and reading stay separate gestures.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import type { Column } from "./Table";
import { RowCells, TableFrame, TableHead } from "./table-parts";

export interface RowSelection<Row> {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  /** Rows that cannot be selected show no checkbox (e.g. a case that is not an approval). */
  readonly isSelectable: (row: Row) => boolean;
  /** Accessible name of each row's checkbox: "Seleccionar 2A". */
  readonly labelOf: (row: Row) => string;
  readonly allLabel: string;
}

interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly keyOf: (row: Row) => string;
  readonly emptyTitle: string;
  readonly emptyLead?: string;
  readonly caption?: string;
  readonly selection?: RowSelection<Row>;
  readonly onRowClick?: (row: Row) => void;
  /** Key of the row whose detail is open: highlighted. */
  readonly activeKey?: string;
  readonly footer?: ReactNode;
}

function SelectAll<Row>({ rows, keyOf, selection }: { readonly rows: readonly Row[]; readonly keyOf: (row: Row) => string; readonly selection: RowSelection<Row> }) {
  const ref = useRef<HTMLInputElement>(null);
  const keys = rows.filter(selection.isSelectable).map(keyOf);
  const count = keys.filter((key) => selection.selected.has(key)).length;
  const all = keys.length > 0 && count === keys.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  const toggle = (checked: boolean) => {
    const next = new Set(selection.selected);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    selection.onChange(next);
  };
  return <input ref={ref} type="checkbox" aria-label={selection.allLabel} checked={all} disabled={keys.length === 0} onChange={(event) => toggle(event.target.checked)} className="size-4 accent-seal-deep" />;
}

export function DataTable<Row>({ columns, rows, keyOf, emptyTitle, emptyLead, caption, selection, onRowClick, activeKey, footer }: DataTableProps<Row>) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} {...(emptyLead !== undefined ? { lead: emptyLead } : {})} />;

  const toggle = (key: string, checked: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (checked) next.add(key);
    else next.delete(key);
    selection.onChange(next);
  };
  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onRowClick?.(row);
  };

  return (
    <TableFrame variant="card" caption={caption} footer={footer}>
      <TableHead
        columns={columns}
        variant="card"
        lead={
          selection ? (
            <th scope="col" className="w-10 px-4 py-3">
              <SelectAll rows={rows} keyOf={keyOf} selection={selection} />
            </th>
          ) : null
        }
      />
      <tbody className="divide-y divide-mist">
        {rows.map((row) => {
          const key = keyOf(row);
          const active = key === activeKey;
          return (
            <tr
              key={key}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => onKey(event, row) : undefined}
              className={`${onRowClick ? "cursor-pointer" : ""} ${active ? "bg-seal-soft" : "hover:bg-paper"}`}
            >
              {selection ? (
                <td className="w-10 px-4 py-3" onClick={(event) => event.stopPropagation()}>
                  {selection.isSelectable(row) ? (
                    <input
                      type="checkbox"
                      aria-label={selection.labelOf(row)}
                      checked={selection.selected.has(key)}
                      onChange={(event) => toggle(key, event.target.checked)}
                      className="size-4 accent-seal-deep"
                    />
                  ) : null}
                </td>
              ) : null}
              <RowCells columns={columns} row={row} variant="card" top />
            </tr>
          );
        })}
      </tbody>
    </TableFrame>
  );
}
