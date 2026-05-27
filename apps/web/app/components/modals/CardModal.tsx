import { isDefaultCard, type PaymentCard } from "../../lib/cards";
import { clampBillingDay, parseCurrencyInput } from "../../lib/formatting";
import { ModalShell } from "./ModalShell";

interface CardModalProps {
  cards: PaymentCard[];
  newCardLabel: string;
  newCardBillingDay: number;
  onLabelChange: (value: string) => void;
  onBillingDayChange: (value: number) => void;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  onUpdateBillingDay: (id: string, billingDay: number) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function CardModal({
  cards,
  newCardLabel,
  newCardBillingDay,
  onLabelChange,
  onBillingDayChange,
  onAdd,
  onRename,
  onUpdateBillingDay,
  onDelete,
  onClose
}: CardModalProps) {
  return (
    <ModalShell titleId="card-modal-title" sectionLabel="관리" title="카드 관리" onClose={onClose}>
      <div className="card-create">
        <label htmlFor="new-card">카드 이름</label>
        <label htmlFor="new-card-billing-day">결제일</label>
        <input
          id="new-card"
          type="text"
          value={newCardLabel}
          onChange={(event) => onLabelChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onAdd();
            }
          }}
        />
        <input
          id="new-card-billing-day"
          max="31"
          min="1"
          type="number"
          value={newCardBillingDay}
          onChange={(event) => onBillingDayChange(clampBillingDay(parseCurrencyInput(event.target.value)))}
        />
        <button className="secondary-button" type="button" onClick={onAdd}>
          추가
        </button>
      </div>
      <div className="category-list">
        {cards.map((card) => {
          const isDefault = isDefaultCard(card.id);

          return (
            <div className="category-row" key={card.id}>
              <div>
                <label className="sr-only" htmlFor={card.id + "-card-label"}>
                  카드명
                </label>
                <input
                  id={card.id + "-card-label"}
                  disabled={isDefault}
                  type="text"
                  value={card.label}
                  onChange={(event) => onRename(card.id, event.target.value)}
                />
                <small>{card.id}</small>
              </div>
              <div>
                <label className="sr-only" htmlFor={card.id + "-card-billing-day"}>
                  카드 결제일
                </label>
                <input
                  id={card.id + "-card-billing-day"}
                  disabled={isDefault}
                  max="31"
                  min="1"
                  type="number"
                  value={card.billingDay}
                  onChange={(event) => onUpdateBillingDay(card.id, parseCurrencyInput(event.target.value))}
                />
                <small>결제일</small>
              </div>
              <button className="ghost-button" disabled={isDefault} type="button" onClick={() => onDelete(card.id)}>
                삭제
              </button>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
