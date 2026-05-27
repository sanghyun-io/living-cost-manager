import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { isDefaultCategory, type Category } from "../../lib/budget";
import { ModalShell } from "./ModalShell";

interface CategoryModalProps {
  opened: boolean;
  categories: Category[];
  newCategoryLabel: string;
  onLabelChange: (value: string) => void;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function CategoryModal({
  opened,
  categories,
  newCategoryLabel,
  onLabelChange,
  onAdd,
  onRename,
  onDelete,
  onClose
}: CategoryModalProps) {
  return (
    <ModalShell opened={opened} sectionLabel="관리" title="카테고리 관리" onClose={onClose}>
      <Group align="flex-end" gap="xs">
        <TextInput
          label="새 카테고리"
          style={{ flex: 1 }}
          value={newCategoryLabel}
          onChange={(event) => onLabelChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onAdd();
            }
          }}
        />
        <Button variant="default" onClick={onAdd}>
          추가
        </Button>
      </Group>
      <Stack gap="xs">
        {categories.map((category) => {
          const isDefault = isDefaultCategory(category.id);
          return (
            <Group key={category.id} gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                aria-label="카테고리명"
                style={{ flex: 1 }}
                disabled={isDefault}
                value={category.label}
                onChange={(event) => onRename(category.id, event.currentTarget.value)}
                description={category.id}
              />
              <Button variant="subtle" color="rose" disabled={isDefault} onClick={() => onDelete(category.id)}>
                삭제
              </Button>
            </Group>
          );
        })}
      </Stack>
    </ModalShell>
  );
}
