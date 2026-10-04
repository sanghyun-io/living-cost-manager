// Only this versioned, application-owned namespace is eligible for retention.
// Historical/unknown backups are never removed. Keep three per kind; on quota
// pressure retain the newest existing copy until the replacement is durable.
export function saveRecovery(storage: Storage, userKey: string, kind: "import" | "corrupt", value: string) {
  const prefix = `${userKey}:recovery:v1:${kind}:`;
  const keys = Object.keys(storage).filter(key => key.startsWith(prefix) && /^\d+-[0-9a-f-]{36}$/.test(key.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length).split("-")[0]) - Number(a.slice(prefix.length).split("-")[0]));
  // Identical corrupt sources do not need another copy on every reload.
  if (kind === "corrupt" && keys.some(key => storage.getItem(key) === value)) return;
  // Monotonic per-kind timestamp also orders back-to-back writes in the same
  // millisecond (and writes after a backwards wall-clock adjustment).
  const timestamp = Math.max(Date.now(), keys[0] ? Number(keys[0].slice(prefix.length).split("-")[0]) + 1 : 0);
  const key = `${prefix}${timestamp}-${crypto.randomUUID()}`;
  try { storage.setItem(key, value); }
  catch (error) {
    for (const old of keys.slice(1)) storage.removeItem(old);
    try { storage.setItem(key, value); } catch { throw error; }
  }
  for (const old of keys.slice(2)) storage.removeItem(old);
}

export function newestImportRecovery(storage: Storage, userKey: string) {
  const prefix = `${userKey}:recovery:`;
  const timestamp = (key: string) => Number(key.slice(prefix.length).replace(/^v1:import:/, "").split(/[:-]/)[0]);
  const keys = Object.keys(storage).filter(key => key.startsWith(prefix) &&
    (/^\d+:import$/.test(key.slice(prefix.length)) || /^v1:import:\d+-[0-9a-f-]{36}$/.test(key.slice(prefix.length))))
    .sort((a, b) => timestamp(b) - timestamp(a));
  return keys[0] ? storage.getItem(keys[0]) : null;
}
