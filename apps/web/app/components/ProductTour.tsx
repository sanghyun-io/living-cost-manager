"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { useProductTour } from '../lib/useProductTour';

const selectors = [
  '[data-product-tour="add"]',
  '[data-product-tour="due"], [data-product-tour="due-help"]',
  '[data-product-tour="data"]',
] as const;
export function getTourTarget(step: number, signedIn: boolean): HTMLElement | null {
  // Static selectors only; no customer data is interpolated into selectors.
  const selector = step === 3 ? signedIn ? selectors[2] : '[data-product-tour="login"]' : selectors[step];
  const targets = selector ? Array.from(document.querySelectorAll<HTMLElement>(selector)) : [];
  const fallback = document.querySelector<HTMLElement>(selectors[0]);
  return targets.find(element => element.isConnected && element.getClientRects().length > 0) ??
    (fallback?.isConnected && fallback.getClientRects().length > 0 ? fallback : null);
}
const copy = [
  ['항목 추가', '항목 추가나 빠른 추가로 고정비를 입력할 수 있어요. 안내만 넘겨도 항목이 만들어지지는 않습니다.'],
  ['납부일 확인', '기준 납부일을 입력하면 다음 납부일을 확인할 수 있어요. 날짜가 없으면 미확인으로 표시됩니다.'],
  ['브라우저 저장과 백업', '편집 내용은 이 브라우저에 저장됩니다. 데이터 관리에서 백업 파일을 내보내 안전하게 보관할 수 있어요.'],
] as const;
type Rect = { top: number; left: number; width: number; height: number };
export function ProductTour({ tour, signedIn, paused, readOnly = false }: { tour: ReturnType<typeof useProductTour>; signedIn: boolean; paused: boolean; readOnly?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [modalPresent, setModalPresent] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tourTarget, setTourTarget] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 320, height: 600 });
  const card = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const titleId = useId();
  const finish = useRef(tour.finish);
  finish.current = tour.finish;
  const active = tour.step !== null && !paused && !modalPresent;
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (tour.step === null && !tour.invitation) return;
    let frame = 0;
    let observedTarget: HTMLElement | null = null;
    const update = () => {
      frame = 0;
      const modal = !!document.querySelector('[role="dialog"][aria-modal="true"]');
      setModalPresent(modal);
      const v = window.visualViewport;
      setViewport({ left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight });
      const target = tour.step !== null && !paused && !modal ? getTourTarget(tour.step, signedIn) : null;
      setTourTarget(target);
      if (target !== observedTarget) {
        if (observedTarget) resize.unobserve(observedTarget);
        if (target) resize.observe(target);
        observedTarget = target;
      }
      const bounds = target?.getBoundingClientRect();
      setRect(bounds ? { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height } : null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new MutationObserver(schedule);
    // Mantine modal content is nested inside its own portal. Do not observe
    // style/description attributes, which this portal itself updates.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'data-product-tour'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect();
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [tour.step, tour.invitation, signedIn, paused]);
  useEffect(() => {
    if (!active || tour.step === null) return;
    const target = tourTarget;
    const helpBefore = target?.getAttribute('aria-describedby');
    if (target) {
      const ids = new Set((helpBefore ?? '').split(/\s+/).filter(Boolean));
      ids.add(descriptionId); target.setAttribute('aria-describedby', [...ids].join(' '));
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    function escape(event: KeyboardEvent) {
      // Bubble only: existing modal handlers have priority, and pause never consumes Escape.
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        event.preventDefault(); finish.current();
      }
    }
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      if (target) {
        const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== descriptionId);
        if (ids.length) target.setAttribute('aria-describedby', ids.join(' ')); else target.removeAttribute('aria-describedby');
      }
    };
  }, [active, tour.step, tourTarget, descriptionId]);
  useEffect(() => {
    if (active && tour.step === 0) card.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [active, tour.step]);
  if (!mounted) return null;
  const atTop = active && rect && rect.top + rect.height / 2 > viewport.top + viewport.height / 2;
  const position = { left: viewport.left + 8, bottom: 'auto', top: atTop ? viewport.top + 8 : viewport.top + viewport.height - 8, width: Math.min(400, viewport.width - 16), maxHeight: viewport.height - 16, transform: atTop ? 'none' : 'translateY(-100%)' };
  const text = tour.step === 3 ? signedIn
    ? ['선택형 클라우드 동기화', '데이터 관리에서 필요할 때 직접 동기화할 수 있어요. 안내를 완료해도 가계부가 업로드되지는 않습니다.']
    : ['선택형 로그인', '로그인 없이도 이 브라우저에서 사용할 수 있어요. 계정을 이용한 클라우드 동기화는 선택 사항이며 여기서 자동 실행되지 않습니다.']
    : copy[tour.step ?? 0];
  const title = tour.step === 3 && signedIn ? '선택형 클라우드 동기화' : text[0];
  const description = readOnly && tour.step === 0 ? '여기가 항목을 추가하는 위치입니다. 보기 전용 가계부에서는 편집할 수 없지만 안내는 계속 볼 수 있어요.' : text[1];
  return createPortal(<div className="product-tour-layer">
    {active && rect ? <div className="product-tour-highlight" aria-hidden="true" style={rect} /> : null}
    {active ? <div ref={card} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={descriptionId} className="product-tour-card" style={position}>
      <div className="product-tour-heading"><span aria-live="polite">{(tour.step ?? 0) + 1} / 4 · <strong id={titleId}>{title}</strong></span><button type="button" onClick={() => tour.finish()} aria-label="둘러보기 닫기">닫기</button></div>
      <p id={descriptionId}>{description}</p>
      <div className="product-tour-actions">
        <button type="button" onClick={() => tour.finish()}>건너뛰기</button>
        <button type="button" onClick={tour.back} disabled={tour.step === 0}>이전</button>
        <button type="button" onClick={tour.step === 3 ? () => tour.finish(true) : tour.next}>{tour.step === 3 ? '완료' : '다음'}</button>
      </div>
    </div> : tour.invitation && !paused && !modalPresent ? <div className="product-tour-card product-tour-invitation" style={position} role="region" aria-label="선택형 둘러보기">
      <span>간단히 둘러볼까요?</span>
      <button type="button" onClick={event => tour.start(event.currentTarget)}>시작</button>
      <button type="button" onClick={() => tour.finish()}>건너뛰기</button>
    </div> : null}
  </div>, document.body);
}
