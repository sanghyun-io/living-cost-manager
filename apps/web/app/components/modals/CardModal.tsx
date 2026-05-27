import { Button, Checkbox, Group, NumberInput, Stack, TextInput } from "@mantine/core";
import { isDefaultCard, type PaymentCard } from "../../lib/cards";
import { ModalShell } from "./ModalShell";

interface CardModalProps {
  opened: boolean;
  cards: PaymentCard[];
  newCardLabel: string;
  newCardBillingDay: number;
  newCardIsEndOfMonth: boolean;
  onLabelChange: (value: string) => void;
  onBillingDayChange: (value: number) => void;
  onNewCardEndOfMonthChange: (value: boolean) => void;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  onUpdateBillingDay: (id: string, billingDay: number) => void;
  onUpdateEndOfMonth: (id: string, value: boolean) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function toNumber(value: number | string, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function CardModal({
  opened,
  cards,
  newCardLabel,
  newCardBillingDay,
  newCardIsEndOfMonth,
  onLabelChange,
  onBillingDayChange,
  onNewCardEndOfMonthChange,
  onAdd,
  onRename,
  onUpdateBillingDay,
  onUpdateEndOfMonth,
  onDelete,
  onClose
}: CardModalProps) {
  return (
    <ModalShell opened={opened} sectionLabel="관리" title="카드 관리" onClose={onClose}>
      <Group align="flex-end" gap="xs">
        <TextInput
          label="카드 이름"
          style={{ flex: 1 }}
          value={newCardLabel}
          onChange={(event) => onLabelChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onAdd();
            }
          }}
        />
        <NumberInput
          label="결제일"
          w={96}
          min={1}
          max={31}
          hideControls
          clampBehavior="strict"
          disabled={newCardIsEndOfMonth}
          value={newCardBillingDay}
          onChange={(value) => onBillingDayChange(toNumber(value, 1))}
        />
        <Checkbox
          label="말일"
          size="sm"
          checked={newCardIsEndOfMonth}
          onChange={(event) => onNewCardEndOfMonthChange(event.currentTarget.checked)}
        />
        <Button variant="default" onClick={onAdd}>
          추가
        </Button>
      </Group>
      <Stack gap="xs">
        {cards.map((card) => {
          const isDefault = isDefaultCard(card.id);
          return (
            <Group key={card.id} gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                aria-label="카드명"
                style={{ flex: 1 }}
                disabled={isDefault}
                value={card.label}
                onChange={(event) => onRename(card.id, event.currentTarget.value)}
                description={card.id}
              />
              <NumberInput
                aria-label="카드 결제일"
                w={96}
                min={1}
                max={31}
                hideControls
                clampBehavior="strict"
                disabled={isDefault || card.isEndOfMonth}
                value={card.billingDay}
                onChange={(value) => onUpdateBillingDay(card.id, toNumber(value, card.billingDay))}
                description="결제일"
              />
              <Checkbox
                aria-label="말일"
                label="말일"
                size="sm"
                disabled={isDefault}
                checked={card.isEndOfMonth}
                onChange={(event) => onUpdateEndOfMonth(card.id, event.currentTarget.checked)}
              />
              <Button variant="subtle" color="rose" disabled={isDefault} onClick={() => onDelete(card.id)}>
                삭제
              </Button>
            </Group>
          );
        })}
      </Stack>
    </ModalShell>
  );
}
