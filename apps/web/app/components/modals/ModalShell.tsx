import type { ReactNode } from "react";

interface ModalShellProps {
  /** Unique id for the heading, wired to aria-labelledby. */
  titleId: string;
  /** Small uppercase label above the title (e.g. "관리", "클라우드"). */
  sectionLabel: string;
  title: string;
  /** Extra class appended after "category-modal" (e.g. "data-modal", "auth-modal"). */
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared backdrop + dialog + header chrome for all modals.
 *
 * Note: Esc-to-close is intentionally NOT handled here. The Home component owns
 * a single keydown effect that closes all modals at once; adding a listener per
 * shell would double-fire it.
 */
export function ModalShell({ titleId, sectionLabel, title, className, onClose, children }: ModalShellProps) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={className ? `category-modal ${className}` : "category-modal"}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="section-label">{sectionLabel}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            닫기
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
