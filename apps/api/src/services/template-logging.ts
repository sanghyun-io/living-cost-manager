// Share capabilities and author-prepared text are not request log identifiers.
// Proxy/CDN access log retention still needs operator review before rollout.
export function isTemplateRequest(candidate: unknown): boolean {
  const record = candidate && typeof candidate === "object" ? candidate as { url?: unknown; raw?: { url?: unknown } } : null;
  const url = typeof candidate === "string" ? candidate : typeof record?.url === "string" ? record.url : typeof record?.raw?.url === "string" ? record.raw.url : "";
  return /(?:^|\/)(?:templates|template-shares)(?:\/|\?|$)/.test(url);
}
