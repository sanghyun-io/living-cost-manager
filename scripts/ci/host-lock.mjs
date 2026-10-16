// LCM-scoped host advisory lock.
//
// Scope honesty (policy ci-cd-github-actions-macmini-runner-policy.md, 안전 기준 6):
// GitHub `concurrency` 직렬화는 같은 저장소 내에서만 작동하고, 이 락도 LCM CI
// 잡(script를 호출하는 job) 사이에서만 공유 호스트 자원(임시 Postgres 클러스터
// 디렉터리·포트)을 직렬화한다. 다른 저장소의 러너·스크립트가 이 락을 참조하지
// 않는 한 저장소 간·호스트 단위 직렬화를 제공하지 않으며 그런 중앙 큐는 존재하지
// 않는다. 락 디렉터리는 CI 전용 OS 계정 홈(0700) 안에 있어 다른 OS 계정은
// 접근하지 못한다.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STALE_AFTER_MS = 45 * 60 * 1000; // job timeout(30m) + 여유

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(lockDir, { timeoutMs = 8 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readOwner(lockDir);
      const lockStat = await stat(lockDir).catch(() => null);
      const age = lockStat ? Date.now() - lockStat.mtimeMs : Infinity;
      if (owner && owner.uid === process.getuid() && !await pidAlive(owner.pid) && age > STALE_AFTER_MS / 4) {
        // 같은 CI 계정 죽은 프로세스의 잔여 락만 회수한다(타 계정 락은 절대 제거하지 않는다).
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (owner && owner.uid !== process.getuid()) {
        throw new Error(`host-lock held by different uid (${owner.uid}); refusing to interfere`);
      }
      if (owner && owner.uid === process.getuid() && await pidAlive(owner.pid) && age < STALE_AFTER_MS) {
        if (Date.now() >= deadline) throw new Error("host-lock wait timeout");
        await sleep(2000);
        continue;
      }
      if (age >= STALE_AFTER_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("host-lock wait timeout");
      await sleep(2000);
      continue;
    }
    // 락 생성 성공: 오너 기록(uid/pid/시각) — 회수 판단 전용, 비밀 없음.
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ uid: process.getuid(), pid: process.pid, at: new Date().toISOString() }) + "\n",
      { mode: 0o600 }
    );
    return { lockDir, release: () => releaseLock(lockDir) };
  }
}

async function readOwner(lockDir) {
  try {
    return JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function releaseLock(lockDir) {
  const owner = await readOwner(lockDir);
  if (!owner || owner.uid !== process.getuid()) return; // 타 계정 락은 건드리지 않음
  await rm(lockDir, { recursive: true, force: true }).catch(() => {});
}
