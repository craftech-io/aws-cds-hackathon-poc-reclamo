// A select of the console: a visible label above it, or only an accessible name when the context
// already says what it is (the channel of one row of a table). The value is one of the options, so
// `onChange` hands back the option's own typed value instead of the raw string of the DOM.
import { useId } from "react";
import { ERROR_CLASS, FIELD_CLASS, FIELD_CLASS_COMPACT, HINT_CLASS, LABEL_CLASS } from "./form-classes";

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

type Name =
  /** Shown above the select. */
  | { readonly label: string; readonly ariaLabel?: undefined }
  /** Read by assistive technology only, for a select whose surroundings already name it. */
  | { readonly label?: undefined; readonly ariaLabel: string };

type SelectFieldProps<T extends string> = Name & {
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly name?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  /** `compact` inside a table row. */
  readonly size?: "regular" | "compact";
  /** Width of the select (`min-w-56`); the label wraps it. */
  readonly className?: string;
};

export function SelectField<T extends string>({ label, ariaLabel, value, options, onChange, name, hint, error, disabled, size = "regular", className }: SelectFieldProps<T>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined].filter((part) => part !== undefined).join(" ");
  const select = (
    <select
      id={id}
      name={name}
      aria-label={ariaLabel}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy === "" ? undefined : describedBy}
      className={`${size === "compact" ? FIELD_CLASS_COMPACT : FIELD_CLASS}${className ? ` ${className}` : ""}`}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = options.find((option) => option.value === event.target.value);
        if (next) onChange(next.value);
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
  const messages = (
    <>
      {hint ? (
        <span id={hintId} className={HINT_CLASS}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={ERROR_CLASS}>
          {error}
        </span>
      ) : null}
    </>
  );
  if (label !== undefined) {
    return (
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        {select}
        {messages}
      </label>
    );
  }
  if (!hint && !error) return select;
  return (
    <span className="flex flex-col gap-1">
      {select}
      {messages}
    </span>
  );
}
