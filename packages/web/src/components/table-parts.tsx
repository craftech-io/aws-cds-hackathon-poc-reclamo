// The pieces Table and DataTable share: the frame with its caption, the header row and the cells of
// one row, so a change to how a console table looks lands in one place.
import type { ReactNode } from "react";
import type { Column } from "./Table";

/** `card` stands on its own; `inset` sits inside a Section, which is already a card; `plain` has no frame. */
export type TableVariant = "card" | "inset" | "plain";

interface Look {
  readonly frame: string;
  readonly head: string;
  readonly headCell: string;
  readonly cell: string;
  /** Cells aligned to the top, for rows whose cells differ in height. */
  readonly top: boolean;
  readonly row: string;
}

const HEAD = "bg-paper text-left text-xs uppercase tracking-wide text-slate";

const LOOKS: Readonly<Record<TableVariant, Look>> = {
  card: { frame: "overflow-x-auto rounded-card border border-mist bg-white shadow-card", head: HEAD, headCell: "px-4 py-3 font-semibold", cell: "px-4 py-3", top: false, row: "hover:bg-paper" },
  inset: { frame: "overflow-x-auto rounded-card border border-mist", head: HEAD, headCell: "px-4 py-3 font-semibold", cell: "px-4 py-3", top: true, row: "hover:bg-paper" },
  plain: { frame: "overflow-x-auto", head: "text-left text-xs uppercase tracking-wide text-slate", headCell: "py-2", cell: "py-2", top: false, row: "" },
};

export function rowClass(variant: TableVariant): string {
  return LOOKS[variant].row;
}

interface TableFrameProps {
  readonly variant: TableVariant;
  readonly caption?: string;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function TableFrame({ variant, caption, footer, children }: TableFrameProps) {
  return (
    <div className={LOOKS[variant].frame}>
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
      {footer ? <div className="border-t border-mist px-4 py-3">{footer}</div> : null}
    </div>
  );
}

interface TableHeadProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly variant: TableVariant;
  /** A header cell before the columns (the select-all checkbox). */
  readonly lead?: ReactNode;
}

export function TableHead<Row>({ columns, variant, lead }: TableHeadProps<Row>) {
  const look = LOOKS[variant];
  return (
    <thead className={look.head}>
      <tr>
        {lead}
        {columns.map((column) => (
          <th key={column.id} scope="col" className={`${look.headCell} ${column.align === "right" ? "text-right" : ""}`}>
            {column.header}
          </th>
        ))}
      </tr>
    </thead>
  );
}

interface RowCellsProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly row: Row;
  readonly variant: TableVariant;
  /** Top-aligned cells whatever the variant says (an inbox row with badges and lines). */
  readonly top?: boolean;
}

export function RowCells<Row>({ columns, row, variant, top = false }: RowCellsProps<Row>) {
  const look = LOOKS[variant];
  const valign = top || look.top ? "align-top" : "";
  return (
    <>
      {columns.map((column) => (
        <td key={column.id} className={`${look.cell} ${valign} ${column.align === "right" ? "text-right tabular-nums" : ""}`}>
          {column.cell(row)}
        </td>
      ))}
    </>
  );
}
