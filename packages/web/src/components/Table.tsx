import { Fragment, type ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { RowCells, TableFrame, TableHead, type TableVariant, rowClass } from "./table-parts";

export interface Column<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: "left" | "right";
}

interface TableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly keyOf: (row: Row) => string;
  readonly emptyTitle: string;
  readonly caption?: string;
  readonly variant?: TableVariant;
  /** A full-width row under the row (a receipt, a template's text); `null` while it is closed. */
  readonly detail?: (row: Row) => ReactNode;
}

export function Table<Row>({ columns, rows, keyOf, emptyTitle, caption, variant = "card", detail }: TableProps<Row>) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} />;
  return (
    <TableFrame variant={variant} caption={caption}>
      <TableHead columns={columns} variant={variant} />
      <tbody className="divide-y divide-mist">
        {rows.map((row) => {
          const extra = detail?.(row);
          return (
            <Fragment key={keyOf(row)}>
              <tr className={rowClass(variant)}>
                <RowCells columns={columns} row={row} variant={variant} />
              </tr>
              {extra === undefined || extra === null ? null : (
                <tr>
                  <td colSpan={columns.length} className="bg-paper px-4 py-3">
                    {extra}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </TableFrame>
  );
}
