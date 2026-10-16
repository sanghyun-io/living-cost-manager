import { forwardRef, useState } from "react";
import { TextInput, type TextInputProps } from "@mantine/core";

interface FixedCostNameInputProps extends Omit<TextInputProps, "value" | "defaultValue" | "onChange" | "onFocus" | "onBlur"> {
  value: string;
  onNameChange: (name: string) => void;
}

// Keep raw typing visible while the parent still normalizes/saves every change.
// In particular, a trailing space must survive until the next character turns
// it into an internal space. Blur only reveals the latest canonical prop value.
export const FixedCostNameInput = forwardRef<HTMLInputElement, FixedCostNameInputProps>(
  function FixedCostNameInput({ value, onNameChange, ...props }, ref) {
    const [focused, setFocused] = useState(false);
    const [draft, setDraft] = useState(value);
    return <TextInput
      {...props}
      ref={ref}
      value={focused ? draft : value}
      onFocus={() => { setDraft(value); setFocused(true); }}
      onChange={event => {
        const next = event.currentTarget.value;
        setDraft(next);
        onNameChange(next);
      }}
      onBlur={() => setFocused(false)}
    />;
  }
);
