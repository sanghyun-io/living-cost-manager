import { isDefaultCategory, type Category } from "../../lib/budget";
import { ModalShell } from "./ModalShell";

interface CategoryModalProps {
  categories: Category[];
  newCategoryLabel: string;
  onLabelChange: (value: string) => void;
  onAdd: () => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function CategoryModal({
  categories,
  newCategoryLabel,
  onLabelChange,
  onAdd,
  onRename,
  onDelete,
  onClose
}: CategoryModalProps) {
  return (
    <ModalShell titleId="category-modal-title" sectionLabel="관리" title="카테고리 관리" onClose={onClose}>
      <div className="category-create">
        <label htmlFor="new-category">새 카테고리</label>
        <input
          id="new-category"
          type="text"
          value={newCategoryLabel}
          onChange={(event) => onLabelChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onAdd();
            }
          }}
        />
        <button className="secondary-button" type="button" onClick={onAdd}>
          추가
        </button>
      </div>
      <div className="category-list">
        {categories.map((category) => {
          const isDefault = isDefaultCategory(category.id);

          return (
            <div className="category-row" key={category.id}>
              <div>
                <label className="sr-only" htmlFor={category.id + "-category-label"}>
                  카테고리명
                </label>
                <input
                  id={category.id + "-category-label"}
                  disabled={isDefault}
                  type="text"
                  value={category.label}
                  onChange={(event) => onRename(category.id, event.target.value)}
                />
                <small>{category.id}</small>
              </div>
              <button className="ghost-button" disabled={isDefault} type="button" onClick={() => onDelete(category.id)}>
                삭제
              </button>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
