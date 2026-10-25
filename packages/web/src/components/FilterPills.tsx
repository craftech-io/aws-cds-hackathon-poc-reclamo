// One-choice filter of a list: a row of toggle buttons (`aria-pressed`) inside a named group, each
// with how many rows it would show. `segmented` draws the same buttons as one bordered control, for
// a filter that sits in a row of form fields.
export interface PillOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Rows behind the option, shown as "Todos (12)"; omitted when the list does not know it. */
  readonly count?: number;
}

export type FilterPillsVariant = "pills" | "segmented";

interface FilterPillsProps<T extends string> {
  /** Accessible name of the group ("Estado", "Mostrar"). */
  readonly label: string;
  readonly options: readonly PillOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly variant?: FilterPillsVariant;
}

const GROUP: Readonly<Record<FilterPillsVariant, string>> = {
  pills: "flex flex-wrap gap-2",
  segmented: "flex items-center gap-1 rounded-md border border-mist bg-white p-1",
};

const BUTTON: Readonly<Record<FilterPillsVariant, { readonly on: string; readonly off: string }>> = {
  pills: {
    on: "rounded-full border border-pine bg-pine px-3 py-1 text-sm font-medium text-white",
    off: "rounded-full border border-mist bg-white px-3 py-1 text-sm font-medium text-pine hover:bg-paper",
  },
  segmented: {
    on: "rounded bg-pine px-3 py-1.5 text-sm font-medium text-white",
    off: "rounded px-3 py-1.5 text-sm font-medium text-pine hover:bg-mist",
  },
};

export function FilterPills<T extends string>({ label, options, value, onChange, variant = "pills" }: FilterPillsProps<T>) {
  return (
    <div role="group" aria-label={label} className={GROUP[variant]}>
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button key={option.value} type="button" aria-pressed={pressed} onClick={() => onChange(option.value)} className={pressed ? BUTTON[variant].on : BUTTON[variant].off}>
            {option.label}
            {option.count === undefined ? null : <> ({option.count})</>}
          </button>
        );
      })}
    </div>
  );
}
