export type FocusDestination = 'ledger' | 'create' | 'rename' | 'aggregate' | 'sample';
export type FocusIntentHandler = (destination: FocusDestination, source: HTMLElement, nextWorkspaceId?: string) => (completed?: boolean) => void;
type Intent = {
  source: HTMLElement; destination: FocusDestination; fromScope: string; toScope: string;
  completed: boolean; release: () => void;
};

/** One explicit action owns focus until the user moves elsewhere. Survives a
 * loading/remount, but never applies a late response to another account/view. */
export function createFocusIntentController(notify: () => void) {
  let pending: Intent | null = null;
  function cancel(ticket = pending) {
    if (!ticket || ticket !== pending) return;
    pending = null;
    ticket.release();
  }
  return {
    cancel,
    begin(options: Omit<Intent, 'completed' | 'release'>) {
      cancel();
      const doc = options.source.ownerDocument;
      // A non-focused programmatic invocation has no focus to restore.
      if (!options.source.contains(doc.activeElement)) return null;
      const moved = (event: Event) => {
        if (event.target !== doc.body && !options.source.contains(event.target as Node)) cancel(ticket);
      };
      const clickedElsewhere = (event: Event) => {
        if (!options.source.contains(event.target as Node)) cancel(ticket);
      };
      const ticket: Intent = { ...options, completed: false, release: () => {
        doc.removeEventListener('focusin', moved);
        doc.removeEventListener('pointerdown', clickedElsewhere);
      } };
      pending = ticket;
      doc.addEventListener('focusin', moved);
      doc.addEventListener('pointerdown', clickedElsewhere);
      return ticket;
    },
    complete(ticket: Intent | null, completed = true) {
      if (!ticket || ticket !== pending) return;
      if (!completed) { cancel(ticket); return; }
      ticket.completed = true;
      notify();
    },
    flush(scope: string, ready: boolean, targets: Record<FocusDestination, HTMLElement | null>) {
      const ticket = pending;
      if (!ticket) return;
      if (scope !== ticket.fromScope && scope !== ticket.toScope) { cancel(ticket); return; }
      if (!ticket.completed || !ready || scope !== ticket.toScope) return;
      const target = targets[ticket.destination];
      if (!target?.isConnected || target.matches(':disabled') || target.closest('[hidden], [inert]')) return;
      cancel(ticket); // Remove listeners before our own intentional focus event.
      target.focus();
    }
  };
}
