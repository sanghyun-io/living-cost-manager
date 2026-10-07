import { useRef } from "react";
import { ActionIcon, Menu } from "@mantine/core";

export function FixedCostRowActions({ name, opened, onChange, onDuplicate }: {
  name: string;
  opened: boolean;
  onChange: (opened: boolean) => void;
  onDuplicate: () => void;
}) {
  const target = useRef<HTMLButtonElement>(null);
  return (
    // Keep actions inside the ledger fieldset so edit/save guards also disable the menu.
    <Menu opened={opened} onChange={onChange} position="bottom-end" width={120} withinPortal={false} returnFocus={false}>
      <Menu.Target>
        <ActionIcon ref={target} variant="subtle" color="gray" size={32} aria-label={`${name} 더보기`}>
          <span aria-hidden="true">⋯</span>
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Tab") event.stopPropagation();
          // Tab continues from this row instead of trapping the user in the menu.
          // Duplication deliberately does not restore focus: revealItem focuses the copy.
          target.current?.focus();
          onChange(false);
        }
      }}>
        <Menu.Item aria-label={`${name} 복제`} onClick={() => {
          onChange(false);
          if (target.current && !target.current.matches(":disabled")) onDuplicate();
        }}>복제</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
