import { ownedTemplatesSchema, templatePublishedSchema, sharedTemplateSchema, savedTemplateSchema, type TemplateBlueprint, type OwnedTemplate } from "@living-cost-manager/shared";
import { getServerApiBaseUrl } from "./serverApi";
async function request(path: string, token?: string, body?: unknown, method = "GET", signal?: AbortSignal) {
  const base = getServerApiBaseUrl();
  if (!base) throw new Error("서버 연결이 구성되어 있지 않습니다.");
  const response = await fetch(base + path, { method, signal, cache: "no-store", credentials: "omit", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 404 ? "공유가 철회·만료되었거나 존재하지 않습니다." : response.status === 409 ? "다른 편집이나 저장 한도와 충돌했습니다. 새로고침해 확인하세요." : response.status === 403 ? "확인된 이메일 계정이 필요합니다." : `서버 요청에 실패했습니다 (${response.status}). 입력은 유지됩니다.`);
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("응답을 읽을 수 없습니다.");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > (path === "/templates" ? 512 : 100) * 1024) { await reader.cancel(); throw new Error("설계도 응답이 너무 큽니다."); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// A share fragment is a bearer capability, not an identifier to display. The
// browser checks the shape first so malformed/overlong/whitespace values never
// reach the network and the raw URL is never echoed back into the UI.
const shareTokenShape = /^[A-Za-z0-9_-]{43}$/;
export const isTemplateShareToken = (value: string) => shareTokenShape.test(value);
export type TemplateShareFragment = { kind: "none" } | { kind: "invalid" } | { kind: "token"; token: string };
export function parseTemplateShareFragment(hash: string): TemplateShareFragment {
  if (!hash.startsWith("#template=")) return { kind: "none" };
  const value = hash.slice("#template=".length);
  return isTemplateShareToken(value) ? { kind: "token", token: value } : { kind: "invalid" };
}

export const templateApi = {
  async list(token: string, signal?: AbortSignal): Promise<OwnedTemplate[]> { return ownedTemplatesSchema.parse(await request("/templates", token, undefined, "GET", signal)); },
  async save(blueprint: TemplateBlueprint, token: string, entry?: OwnedTemplate) {
    return savedTemplateSchema.parse(await request(entry ? `/templates/${encodeURIComponent(entry.id)}` : "/templates", token, entry ? { blueprint, revision: entry.revision } : { blueprint }, entry ? "PUT" : "POST"));
  },
  async publish(entry: OwnedTemplate, token: string) { return templatePublishedSchema.parse(await request(`/templates/${encodeURIComponent(entry.id)}/publish`, token, { revision: entry.revision, reviewed: true, rightsConfirmed: true }, "POST")); },
  async revoke(entry: OwnedTemplate, token: string) { await request(`/templates/${encodeURIComponent(entry.id)}/share`, token, undefined, "DELETE"); },
  async remove(entry: OwnedTemplate, token: string) { await request(`/templates/${encodeURIComponent(entry.id)}`, token, undefined, "DELETE"); },
  async shared(token: string, signal?: AbortSignal) { if (!isTemplateShareToken(token)) throw new Error("공유 링크 형식이 올바르지 않습니다."); return sharedTemplateSchema.parse(await request(`/template-shares/${token}`, undefined, undefined, "GET", signal)).blueprint; }
};
