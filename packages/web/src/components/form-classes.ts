// Classes of the console's form controls. A control inside an uppercase label resets the label's
// typography, so what a person types is shown as typed.
const FIELD_BASE = "rounded-md border border-mist bg-white text-sm font-normal normal-case tracking-normal text-ink disabled:bg-paper";
export const FIELD_CLASS = `${FIELD_BASE} px-3 py-2`;
/** The same control inside a table row, where a full-height field would stretch the row. */
export const FIELD_CLASS_COMPACT = `${FIELD_BASE} px-2 py-1`;
export const LABEL_CLASS = "flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate";
export const HINT_CLASS = "text-xs font-normal normal-case tracking-normal text-slate";
export const ERROR_CLASS = "text-xs font-normal normal-case tracking-normal text-danger";
