import { expect, test, vi } from "vitest";
import { newestImportRecovery, saveRecovery } from "../app/lib/recoveryStorage";

test("bounded owned recovery retention preserves unknown backups and newest copy on quota", () => {
  const storage = Object.create({
    getItem(this: Record<string, string>, key: string) { return this[key] ?? null; },
    setItem(this: Record<string, string>, key: string, value: string) { this[key] = value; },
    removeItem(this: Record<string, string>, key: string) { delete this[key]; }
  }) as Storage;
  storage.setItem("user:recovery:unknown", "untouched");
  storage.setItem("user:corrupt:legacy", "provenance");
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    for (let i = 0; i < 6; i++) saveRecovery(storage, "user", "import", String(i));
    expect(Object.keys(storage).filter(key => key.includes(":v1:import:"))).toHaveLength(3);
    expect(newestImportRecovery(storage, "user")).toBe("5");
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveRecovery(storage, "user", "import", "new")).toThrow("quota");
    expect(newestImportRecovery(storage, "user")).toBe("5");
    write.mockRestore();
    expect(storage.getItem("user:recovery:unknown")).toBe("untouched");
    expect(storage.getItem("user:corrupt:legacy")).toBe("provenance");
    saveRecovery(storage, "user", "corrupt", "broken JSON");
    saveRecovery(storage, "user", "corrupt", "broken JSON");
    expect(Object.keys(storage).filter(key => key.includes(":v1:corrupt:"))).toHaveLength(1);
  } finally { clock.mockRestore(); }
});
