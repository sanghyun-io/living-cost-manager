import { describe, expect, test, vi } from 'vitest';
import { createFocusIntentController, type FocusDestination } from '../app/lib/focusIntent';

// The controller uses only these DOM operations. Browser focus, native disabled
// controls, remounts, and keyboard paths are separately covered by the audit.
function fixture() {
  const listeners = new Map<string, Set<(event: { target: unknown }) => void>>();
  const doc: any = { body: {}, activeElement: null,
    addEventListener: (name: string, fn: any) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener: (name: string, fn: any) => listeners.get(name)?.delete(fn) };
  const dispatch = (name: string, target: unknown) => { for (const fn of [...listeners.get(name) ?? []]) fn({ target }); };
  const element = () => {
    const el: any = { ownerDocument: doc, isConnected: true, disabled: false, hidden: false,
      contains: (other: unknown) => other === el,
      matches: () => el.disabled,
      closest: () => el.hidden ? {} : null,
      focus: vi.fn(() => { doc.activeElement = el; dispatch('focusin', el); }) };
    return el;
  };
  const source = element(), target = element();
  doc.activeElement = source;
  const notify = vi.fn(), controller = createFocusIntentController(notify);
  const targets: Record<FocusDestination, HTMLElement | null> = { ledger: target, create: target, rename: target, aggregate: target, sample: target };
  const begin = (destination: FocusDestination = 'ledger', toScope = 'a:two') => controller.begin({ source, destination, fromScope: 'a:one', toScope });
  return { doc, listeners, dispatch, element, source, target, notify, controller, targets, begin };
}

describe('action-owned keyboard focus restoration', () => {
  test('switch waits for completed transition and authoritative loaded destination', () => {
    const f = fixture(), ticket = f.begin();
    f.controller.flush('a:two', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    f.controller.complete(ticket);
    f.source.isConnected = false; f.doc.activeElement = f.doc.body;
    f.controller.flush('a:one', true, f.targets);
    f.controller.flush('a:two', false, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    f.controller.flush('a:two', true, f.targets);
    expect(f.target.focus).toHaveBeenCalledTimes(1);
    f.controller.flush('a:two', true, f.targets); // Ordinary rerender never refocuses.
    expect(f.target.focus).toHaveBeenCalledTimes(1);
  });

  test.each(['create', 'rename', 'aggregate', 'sample'] as const)('%s completion restores its enabled trigger, not BODY', destination => {
    const f = fixture(), ticket = f.begin(destination, 'a:one');
    f.target.disabled = true; f.doc.activeElement = f.doc.body;
    f.controller.complete(ticket);
    f.controller.flush('a:one', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    f.target.disabled = false;
    f.controller.flush('a:one', true, f.targets);
    expect(f.target.focus).toHaveBeenCalledTimes(1);
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  test.each(['focusin', 'pointerdown'])('user %s elsewhere cancels a late query without stealing focus', event => {
    const f = fixture(), ticket = f.begin('aggregate', 'a:one'), elsewhere = f.element();
    f.doc.activeElement = elsewhere; f.dispatch(event, elsewhere);
    f.controller.complete(ticket); f.controller.flush('a:one', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  test('another account, book or sample view cancels the ticket even if old scope returns', () => {
    for (const scope of ['b:one', 'a:three', 'a:sample']) {
      const f = fixture(), ticket = f.begin();
      f.controller.flush(scope, false, f.targets);
      f.controller.complete(ticket); f.controller.flush('a:two', true, f.targets);
      expect(f.target.focus).not.toHaveBeenCalled();
    }
  });

  test('intentional pointer interaction on BODY cancels, unlike incidental disabled-control blur', () => {
    const f = fixture(), ticket = f.begin('aggregate', 'a:one');
    f.doc.activeElement = f.doc.body; f.dispatch('pointerdown', f.doc.body);
    f.controller.complete(ticket); f.controller.flush('a:one', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
  });

  test('new action invalidates old completion; failed creation does not move the retry field', () => {
    const f = fixture(), old = f.begin(), current = f.begin('create', 'a:one');
    f.controller.complete(old); f.controller.flush('a:two', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    f.controller.complete(current, false); f.controller.flush('a:one', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
  });

  test('detached, hidden or inert targets never receive focus', () => {
    const f = fixture(), ticket = f.begin(); f.controller.complete(ticket);
    f.target.isConnected = false; f.controller.flush('a:two', true, f.targets);
    f.target.isConnected = true; f.target.hidden = true; f.controller.flush('a:two', true, f.targets);
    f.targets.ledger = null; f.controller.flush('a:two', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
    f.controller.cancel();
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  test('invocation without trigger/form focus does not create an autofocus intent', () => {
    const f = fixture(); f.doc.activeElement = f.doc.body;
    expect(f.begin()).toBeNull();
    f.controller.flush('a:two', true, f.targets);
    expect(f.target.focus).not.toHaveBeenCalled();
  });
});
