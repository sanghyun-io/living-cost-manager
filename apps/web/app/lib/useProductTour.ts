"use client";
import { useEffect, useRef, useState } from 'react';
import { createTourApi, createTourController, createTourStorage, type TourAccount } from './productTour';

export function useProductTour({ scope, transition, account, ready }: { scope: string; transition: string; account: TourAccount | null; ready: boolean }) {
  const [, update] = useState(0);
  const [step, setStep] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const identity = JSON.stringify([ready, scope, transition, account?.token, account?.baseUrl]);
  const entered = useRef('');
  const controller = useRef<ReturnType<typeof createTourController> | null>(null);
  if (!controller.current) controller.current = createTourController(createTourStorage(() => window.localStorage), createTourApi(), () => update(n => n + 1));
  useEffect(() => {
    entered.current = identity;
    setStep(null);
    void controller.current!.enter(ready ? scope : '', ready ? account : null);
    return () => controller.current!.cancel();
  }, [ready, scope, transition, account?.token, account?.baseUrl]);
  function restoreFocus() {
    const element = opener.current;
    requestAnimationFrame(() => {
      const target = element?.isConnected ? element : document.querySelector<HTMLElement>('[data-product-tour-opener]');
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
  }
  return {
    step: ready && entered.current === identity ? step : null,
    invitation: ready && entered.current === identity && controller.current.invitation,
    start(element?: HTMLElement) {
      if (!ready || entered.current !== identity) return;
      opener.current = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      controller.current!.dismissInvitation(); setStep(0);
    },
    next() { setStep(value => value === null ? null : Math.min(3, value + 1)); },
    back() { setStep(value => value === null ? null : Math.max(0, value - 1)); },
    finish(completed = false) { if (!ready || entered.current !== identity) return; controller.current!.finish(completed ? 'completed' : 'skipped'); setStep(null); restoreFocus(); }
  };
}
