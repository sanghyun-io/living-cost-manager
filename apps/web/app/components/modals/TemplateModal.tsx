"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, NumberInput, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { TEMPLATE_SCENARIOS, templateBlueprintSchema, type OwnedTemplate, type TemplateBlueprint } from "@living-cost-manager/shared";
import { ModalShell } from "./ModalShell";
import { parseTemplateShareFragment, templateApi } from "../../lib/templateApi";
import { alignTemplateAmounts, buildTemplateBudget, templateItemsUnchanged } from "../../lib/templates";
import type { LocalBudgetSnapshot } from "../../lib/snapshot";
import type { ServerSession } from "../../lib/serverApi";

interface Props {
  opened: boolean; onOpen: () => void; onClose: () => void;
  session: ServerSession | null; onLogin: () => void;
  canApply: boolean;
  accountCanCreate?: boolean;
  creationUnavailableMessage?: string;
  /** Returns true only when the new local space was actually created. */
  onApply: (blueprint: TemplateBlueprint, snapshot: LocalBudgetSnapshot) => boolean | Promise<boolean>;
  /** Malformed share links surface in the page status (normal UI), not in this dialog. */
  onShareError?: (message: string) => void;
}
type Draft = { items: TemplateBlueprint["items"]; amounts: string[]; income: string };
const copy = (blueprint: TemplateBlueprint): TemplateBlueprint => ({ ...blueprint, items: blueprint.items.map(item => ({ ...item })) });
// Neutral shell used while a shared design is loading or could not be read.
// It is never rendered as if it were the author's content.
const PLACEHOLDER: TemplateBlueprint = { title: "", description: "", authorLabel: "", items: [{ name: "", category: "", periodMonths: 1 }] };
const INVALID_SHARE_MESSAGE = "공유 링크 형식이 올바르지 않습니다. 링크를 다시 확인하거나 작성자에게 새 링크를 요청하세요.";
export function TemplateModal({ opened, onOpen, onClose, session, onLogin, canApply, accountCanCreate = false, creationUnavailableMessage, onApply, onShareError }: Props) {
  const [blueprint, setBlueprint] = useState(() => copy(TEMPLATE_SCENARIOS[0]));
  const [owned, setOwned] = useState<OwnedTemplate[]>([]);
  const [entry, setEntry] = useState<OwnedTemplate | null>(null);
  const [sharedToken, setSharedToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [amounts, setAmounts] = useState<string[]>([]);
  const [income, setIncome] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [rights, setRights] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [status, setStatus] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);
  const [operationBusy, setBusy] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const busy = operationBusy || shareLoading;
  const token = session?.token;
  const tokenRef = useRef(token); tokenRef.current = token;
  const previousOwner = useRef(session?.user.id);
  const operation = useRef(0);
  const mounted = useRef(true);
  const shareErrorHandler = useRef(onShareError); shareErrorHandler.current = onShareError;
  const draft = useRef<Draft>({ items: blueprint.items, amounts, income });
  draft.current = { items: blueprint.items, amounts, income };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const report = (message: string, kind: "info" | "error" = "info") => { setStatus(message); setStatusIsError(kind === "error"); };

  function choose(value: TemplateBlueprint, selected: OwnedTemplate | null = null, publicToken: string | null = null, preserveFrom?: Draft) {
    setBlueprint(copy(value)); setEntry(selected); setSharedToken(publicToken); setUnavailable(false);
    if (preserveFrom) {
      // Save responses may only differ in canonical spelling (NFKC/trim). An
      // amount is kept exactly when its item kept its identity at the same
      // stable index; anything else blanks, so a stale number is never applied
      // to a different item. Income is not item-bound, so the draft survives.
      setAmounts(alignTemplateAmounts(preserveFrom.items, preserveFrom.amounts, value.items));
      setIncome(preserveFrom.income);
    } else { setAmounts(value.items.map(() => "")); setIncome(""); }
    setReviewed(false); setRights(false); setShareUrl(""); setStatus(""); setStatusIsError(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    operation.current++; setBusy(false); setOwned([]);
    // Do not carry a private author's draft across accounts/logout.
    if (previousOwner.current !== session?.user.id) {
      if (previousOwner.current !== undefined) choose(TEMPLATE_SCENARIOS[0]);
      previousOwner.current = session?.user.id;
    }
    if (opened && token) void templateApi.list(token, controller.signal).then(value => {
      if (!controller.signal.aborted && tokenRef.current === token) setOwned(value);
    }).catch(error => { if (!controller.signal.aborted && tokenRef.current === token) report(error instanceof Error ? error.message : "템플릿 목록을 불러오지 못했습니다.", "error"); });
    return () => controller.abort();
  }, [token, opened, session?.user.id]); // selection is intentionally not a reload dependency

  useEffect(() => {
    let controller: AbortController | null = null;
    const read = () => {
      const fragment = parseTemplateShareFragment(window.location.hash);
      if (fragment.kind === "none") return;
      if (fragment.kind === "invalid") {
        // Malformed capability: no API request, no echo of the raw URL value,
        // no misleading dialog. Strip the dead fragment (replaceState keeps
        // back navigation) and let the page status explain it in normal UI.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        shareErrorHandler.current?.(INVALID_SHARE_MESSAGE);
        return;
      }
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      operation.current++; setBusy(false);
      // Neutral disabled shell until the server actually returns the design.
      choose(PLACEHOLDER); onOpen(); setUnavailable(true); setShareLoading(true);
      void templateApi.shared(fragment.token, signal).then(result => {
        if (!signal.aborted) choose(result, null, fragment.token);
      }).catch(error => { if (!signal.aborted) { setUnavailable(true); report(error instanceof Error ? error.message : "공유된 설계도를 불러오지 못했습니다. 링크가 만료·철회되었을 수 있습니다.", "error"); } })
        .finally(() => { if (!signal.aborted) setShareLoading(false); });
    };
    read(); window.addEventListener("hashchange", read);
    return () => { controller?.abort(); window.removeEventListener("hashchange", read); };
  }, []); // hash is a capability, not financial data or a server-rendered route

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const sequence = ++operation.current; const scope = tokenRef.current;
    setBusy(true); setStatus("");
    try { await action(() => mounted.current && sequence === operation.current && scope === tokenRef.current); }
    catch (error) { if (mounted.current && sequence === operation.current && scope === tokenRef.current) report(error instanceof Error ? error.message : "요청에 실패했습니다.", "error"); }
    finally { if (mounted.current && sequence === operation.current && scope === tokenRef.current) setBusy(false); }
  }
  const fresh = (scope: string | undefined) => mounted.current && tokenRef.current === scope;
  async function reload(scope: string, current: () => boolean) {
    const values = await templateApi.list(scope);
    if (!fresh(scope) || !current()) return null;
    setOwned(values); return values;
  }
  const valid = templateBlueprintSchema.safeParse(blueprint);
  const unchanged = entry !== null && JSON.stringify(entry.blueprint) === JSON.stringify(blueprint);
  let budget: LocalBudgetSnapshot | null = null;
  try { if (valid.success) budget = buildTemplateBudget(valid.data, amounts, income); } catch { /* missing amounts remain visibly unset */ }
  const edit = (value: TemplateBlueprint) => { setBlueprint(value); setReviewed(false); setRights(false); setShareUrl(""); setSharedToken(null); };
  const filledCount = blueprint.items.map((_, index) => amounts[index] ?? "").filter(value => value !== "").length;
  const creationAllowed = !session || accountCanCreate;

  return <ModalShell opened={opened} onClose={onClose} sectionLabel="설계도" title="생활비 템플릿" size="lg">
    <Text size="sm" c="dimmed">고정비 항목의 틀을 만들고 공유합니다. 엑셀 수식·변동 지출 장부·판매 결제 기능은 아닙니다. 현재 생활비 데이터는 자동으로 가져오지 않습니다. <a href="/guide/templates/" target="_blank" rel="noopener noreferrer">공유 범위와 만료 정책 안내</a></Text>
    {status ? <Alert color={statusIsError ? "red" : "blue"} role={statusIsError ? "alert" : "status"} aria-live={statusIsError ? "assertive" : "polite"}>{status}</Alert> : null}
    <section aria-label="상황별 템플릿">
      <Title order={3} size={16}>상황별 시작점</Title>
      <Group mt="sm">{TEMPLATE_SCENARIOS.map(value => <Button key={value.title} variant="default" disabled={busy} onClick={() => choose(value)}>{value.title}</Button>)}
        <Button variant="subtle" disabled={busy} onClick={() => choose({ title: "나만의 고정비 설계도", description: "", authorLabel: "", items: [{ name: "새 항목", category: "기타", periodMonths: 1 }] })}>빈 설계도 만들기</Button>
      </Group>
    </section>
    <section aria-label="나만의 템플릿">
      <Title order={3} size={16}>나만의 템플릿</Title>
      {!token ? <Group mt="sm"><Text size="sm">저장·게시에는 이메일을 확인한 계정이 필요합니다.</Text><Button variant="default" onClick={onLogin}>템플릿 저장을 위해 로그인</Button></Group> : <>
        <Text size="sm" c="dimmed">계정당 최대 20개. 생활비 공간의 공유 권한과 별개로 작성자만 편집합니다.</Text>
        <Stack gap="xs" mt="sm">{owned.map(value => <Group key={value.id} justify="space-between">
          <Button variant="subtle" disabled={busy} onClick={() => choose(value.blueprint, value)}>{value.blueprint.title} · 수정 {value.revision}</Button>
          <Group gap="xs">
            {value.published ? <Button variant="default" disabled={busy} onClick={() => void run(async current => { await templateApi.revoke(value, token); if (await reload(token, current)) { setShareUrl(""); report("공유를 철회했습니다. 이미 복사한 설계도는 삭제되지 않습니다."); } })}>공유 철회</Button> : null}
            <Button variant="subtle" color="rose" disabled={busy} aria-label={`${value.blueprint.title} 템플릿 삭제`} onClick={() => { if (window.confirm("템플릿과 게시 링크를 삭제할까요? 이미 복사된 공간은 유지됩니다.")) void run(async current => { await templateApi.remove(value, token); if (await reload(token, current)) { if (entry?.id === value.id) choose(TEMPLATE_SCENARIOS[0]); report("템플릿과 공유를 삭제했습니다."); } }); }}>삭제</Button>
          </Group>
        </Group>)}</Stack>
      </>}
    </section>
    <fieldset disabled={busy || unavailable} className="template-editor">
      <legend>설계도 편집 · 공개할 내용만 직접 준비하세요</legend>
      <Stack gap="sm">
        <TextInput label="템플릿 제목" maxLength={80} value={blueprint.title} onChange={e => edit({ ...blueprint, title: e.currentTarget.value })} />
        <Textarea label="템플릿 설명" maxLength={600} value={blueprint.description} onChange={e => edit({ ...blueprint, description: e.currentTarget.value })} />
        <TextInput label="공개 작성자 표시명 (선택)" maxLength={80} value={blueprint.authorLabel} onChange={e => edit({ ...blueprint, authorLabel: e.currentTarget.value })} />
        {blueprint.items.map((item, i) => <div key={i} className="template-item-editor">
          <TextInput label={`설계 항목 ${i + 1} 이름`} maxLength={80} value={item.name} onChange={e => edit({ ...blueprint, items: blueprint.items.map((row, index) => index === i ? { ...row, name: e.currentTarget.value } : row) })} />
          <TextInput label={`설계 항목 ${i + 1} 카테고리`} maxLength={80} value={item.category} onChange={e => edit({ ...blueprint, items: blueprint.items.map((row, index) => index === i ? { ...row, category: e.currentTarget.value } : row) })} />
          <NumberInput label={`설계 항목 ${i + 1} 주기 (개월)`} min={1} max={120} allowDecimal={false} value={item.periodMonths} onChange={value => edit({ ...blueprint, items: blueprint.items.map((row, index) => index === i ? { ...row, periodMonths: typeof value === "number" ? value : 0 } : row) })} />
          <Button variant="subtle" color="gray" disabled={blueprint.items.length < 2} aria-label={`설계 항목 ${i + 1} 제거`} onClick={() => { edit({ ...blueprint, items: blueprint.items.filter((_, index) => i !== index) }); setAmounts(values => values.filter((_, index) => i !== index)); }}>제거</Button>
        </div>)}
        <Button variant="default" disabled={blueprint.items.length >= 40} onClick={() => { edit({ ...blueprint, items: [...blueprint.items, { name: "새 항목", category: "기타", periodMonths: 1 }] }); setAmounts(values => [...values, ""]); }}>설계 항목 추가</Button>
      </Stack>
    </fieldset>
    {!unavailable && !valid.success ? <Text size="sm" c="rose">제목·이름·카테고리·정수 주기를 확인하세요. 이메일·링크·긴 번호는 넣을 수 없습니다.</Text> : null}
    {unavailable && !shareLoading ? <Text size="sm" c="dimmed">설계도를 확인할 수 없어 편집과 적용은 비활성화됩니다. 위 '상황별 시작점'이나 '나만의 템플릿'으로 새로 시작하거나, 작성자에게 새 링크를 요청하세요.</Text> : null}
    <Group>
      <Button disabled={!token || !valid.success || busy || unavailable} onClick={() => { if (!token) return; void run(async current => {
        const before: Draft = { items: draft.current.items, amounts: [...draft.current.amounts], income: draft.current.income };
        const result = await templateApi.save(blueprint, token, entry ?? undefined);
        if (!fresh(token) || !current()) return;
        const values = await templateApi.list(token);
        if (!fresh(token) || !current()) return;
        setOwned(values);
        const saved = values.find(value => value.id === result.id);
        if (!saved) { report("설계도를 저장했지만 목록 응답에서 찾지 못했습니다. 잠시 후 다시 열어 확인하세요.", "error"); return; }
        // Keep the same blueprint when the server only canonicalized names;
        // blank only the amounts whose item identity really changed so nothing
        // stale can be applied, and never lose the browser-only draft entirely.
        const stable = templateItemsUnchanged(before.items, saved.blueprint.items);
        choose(saved.blueprint, saved, null, before);
        report(stable
          ? "설계도를 계정에 저장했습니다. 입력한 금액과 수입은 그대로 유지되며, 이 브라우저에만 남고 저장·공유되지 않습니다."
          : "설계도를 계정에 저장했습니다. 저장 응답에서 항목 구성이 바뀌어 동일 항목의 금액만 유지했습니다. 새 공간에 적용하기 전 금액을 다시 확인하세요.", stable ? "info" : "error");
      }); } }>{entry ? "템플릿 수정 저장" : "나만의 템플릿 저장"}</Button>
      {entry ? <Button variant="default" disabled={busy} onClick={() => choose(blueprint, null, null, { items: blueprint.items, amounts, income })}>별도 설계도로 복사</Button> : null}
    </Group>
    <section aria-label="공유 미리보기" className="template-preview">
      <Title order={3} size={16}>공유 미리보기</Title>
      <Text fw={600}>{blueprint.title}</Text><Text size="sm">{blueprint.description}</Text>
      <Text size="sm">작성자 표시: {blueprint.authorLabel || "표시 없음"}</Text>
      <ul>{blueprint.items.map((item, i) => <li key={i}>{item.name} · {item.category} · {item.periodMonths}개월</li>)}</ul>
      <Text size="sm" c="dimmed">이 문구가 그대로 공개됩니다. 이름·설명에 개인정보를 적으면 노출될 수 있으며 자동 익명화하지 않습니다. 금액·수입·날짜·카드·계정 ID·갱신 기록은 공유하지 않습니다.</Text>
      <Checkbox mt="sm" label="공개할 모든 문구를 직접 검토했고 개인정보를 넣지 않았습니다" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.currentTarget.checked)} />
      <Checkbox mt="sm" label="직접 제작했거나 공유할 권한이 있는 설계도입니다" checked={rights} disabled={busy} onChange={e => setRights(e.currentTarget.checked)} />
      <Button mt="sm" disabled={!token || !entry || !unchanged || !reviewed || !rights || busy || unavailable} onClick={() => token && entry && void run(async current => { const result = await templateApi.publish(entry, token); if (await reload(token, current)) { setShareUrl(`${window.location.origin}/#template=${result.token}`); report("검토한 저장본을 게시했습니다. 90일 후 접근이 만료되며 재게시하면 이전 링크는 무효입니다. 이미 복사한 설계도는 회수되지 않습니다."); } })}>검토한 저장본 공유 링크 만들기</Button>
      <Text size="xs" c="dimmed" mt="xs">저장 후 게시하세요. 링크를 아는 누구나 읽을 수 있습니다. 철회는 이후 조회를 막지만 이미 복사한 내용까지 회수하지 않습니다. 자세한 정책: <a href="/guide/templates/" target="_blank" rel="noopener noreferrer">템플릿 안내</a></Text>
      {shareUrl ? <TextInput mt="sm" label="공유 링크 (복사해서 전달)" value={shareUrl} readOnly onFocus={e => e.currentTarget.select()} /> : null}
    </section>
    <section aria-label="새 공간에 템플릿 적용" className="template-preview">
      <Title order={3} size={16}>새 공간에 적용</Title>
      <Text size="sm">비어 있는 금액은 0원이 아닙니다. 모든 실제 청구 금액과 월 수입을 직접 입력하세요. 입력한 값은 설계도에 포함되지 않습니다. 로그인 상태에서는 소유 가계부가 없는 계정의 첫 가계부만 서버에 만들 수 있습니다. 기존 가계부는 바꾸지 않습니다. 게스트는 별도 로컬 공간에 적용합니다. 날짜·결제수단은 생성 후 직접 설정합니다.</Text>
      <Stack gap="sm" mt="sm">
        <TextInput label="새 공간 월 수입 (원)" inputMode="numeric" value={income} disabled={busy} onChange={e => setIncome(e.currentTarget.value)} />
        {blueprint.items.map((item, i) => <TextInput key={i} label={`${item.name || `설계 항목 ${i + 1}`} 실제 청구 금액 (원)`} inputMode="numeric" placeholder="직접 입력 · 미입력" value={amounts[i] ?? ""} disabled={busy} onChange={e => { const value = e.currentTarget.value; setAmounts(values => blueprint.items.map((_, index) => index === i ? value : values[index] ?? "")); }} />)}
      </Stack>
      <Text size="xs" c="dimmed" mt="xs">금액 입력 {filledCount}/{blueprint.items.length} · 모든 항목과 수입을 채워야 생성할 수 있습니다 · 실제 0원인 항목에만 0을 입력하세요</Text>
      {!canApply ? <Text size="sm" c="dimmed" mt="sm">현재 공간의 저장·복구 상태를 확인한 뒤 적용하세요. 기존 데이터는 교체하지 않습니다.</Text> : null}
      {session ? <Text size="sm" mt="sm">{creationAllowed ? '계정 연결을 유지한 채 첫 가계부를 만듭니다. 기존 가계부는 변경하지 않습니다.' : creationUnavailableMessage}</Text> : null}
      <Button mt="sm" disabled={!budget || !canApply || !creationAllowed || busy || unavailable || (session !== null && !session.user.emailVerified)} onClick={() => void run(async current => {
        if (sharedToken) await templateApi.shared(sharedToken); // revoked or expired links can no longer be applied
        if (!budget || !creationAllowed || !fresh(token) || !current()) return;
        const applied = await onApply(blueprint, budget);
        if (!fresh(token) || !current()) return;
        // Consume the share capability only when the new space really exists.
        // Close either way: failures surface once as the page-level alert, so
        // the same error is never shown by two dialogs at the same time.
        if (applied && window.location.hash.startsWith("#template=")) window.history.replaceState(null, "", window.location.pathname + window.location.search);
        onClose();
      })}>금액 확인 후 새 공간 만들기</Button>
    </section>
  </ModalShell>;
}
