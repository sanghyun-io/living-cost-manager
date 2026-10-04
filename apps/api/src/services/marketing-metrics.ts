import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * 마케팅 이벤트 집계 collector (personal insight 캠페인).
 *
 * 개인정보 원칙:
 * - 이벤트는 "UTC 날짜 + 이벤트별 카운트"로만 누적된다. 사용자 ID, 세션, IP,
 *   User-Agent, 요청 타임스탬프, 금액 등 어떤 개인 데이터도 메모리/디스크에 남기지 않는다.
 * - 쓰기는 이 프로세스 안에서 직렬화되고, 디스크에는 temp + fsync + rename 으로
 *   원자적으로 교체된다. 여러 프로세스가 같은 파일을 동시에 쓰면 안 된다(단일 라이터).
 * - 검증/파손/디스크 오류는 항상 fail-closed: 그 이벤트는 거부하고 기존 파일을
 *   절대 덮어쓰지 않는다. 누락은 허용해도 오염된 상태의 덮어쓰기는 허용하지 않는다.
 * - 파일은 오늘(UTC) 포함 최근 MARKETING_METRICS_RETENTION_DAYS 일만 보관한다.
 */

export const MARKETING_EVENT_NAMES = [
  "personal_cost_saved",
  "personal_billing_date_saved",
  "personal_renewal_decision_saved"
] as const;

export type MarketingEventName = (typeof MARKETING_EVENT_NAMES)[number];

/** 공개 계약: `{"event": <이벤트>}` 이외의 어떤 필드도 허용하지 않는다(strict). */
export const marketingEventRequestSchema = z.strictObject({
  event: z.enum(MARKETING_EVENT_NAMES)
});

/** 라우트 경로(API_BASE_PATH prefix 아래에 등록된다). */
export const MARKETING_METRICS_ROUTE_PATH = "/marketing/events";

/** 본문 상한: 유효 본문은 45bytes 내외. 충분히 작은 고정 상한. */
export const MARKETING_METRICS_BODY_LIMIT_BYTES = 256;

/**
 * 전역 rate limit 예산. IP별 분리가 아니라 프로세스 전체가 공유하는 단일 카운터만 쓴다.
 * keyGenerator 가 상수 문자열이라 store 에 IP/UA가 아니라 고정 키 1개만 남는다.
 */
export const MARKETING_METRICS_RATE_LIMIT_MAX = 120;
export const MARKETING_METRICS_RATE_LIMIT_WINDOW_MS = 60_000;
export const MARKETING_METRICS_RATE_LIMIT_KEY = "marketing-events-global";

/** 보존 window: 오늘(UTC) 포함 최근 90일. */
export const MARKETING_METRICS_RETENTION_DAYS = 90;
/** 이벤트 유형·일 상한. */
export const MARKETING_METRICS_MAX_COUNT_PER_EVENT_PER_DAY = 5_000;
/**
 * 일자 총계 상한. 유형별 상한(5,000) X 3 = 15,000 이 아니라 그 **아래**로 둬야
 * 이 상한이 실제로 동작한다(dead code 방지). 초과분은 507 으로 거부되고 파일은 그대로다.
 */
export const MARKETING_METRICS_MAX_EVENTS_PER_DAY = 10_000;
/** 파일에 허용되는 최대 날짜 entry 수(절대 바운드). */
export const MARKETING_METRICS_MAX_DAY_ENTRIES = 90;
/** 집계 파일 최대 크기(bytes). 초과 파일은 parse 하지 않고 거부. */
export const MARKETING_METRICS_MAX_FILE_BYTES = 65_536;
/** 대기열 상한: 이 수가 넘는 요청이 쓰기를 기다리면 새 요청은 백프레셔로 거부. */
export const MARKETING_METRICS_MAX_PENDING_WRITES = 32;
/** 유휴 보존 정리 타이머 점검 주기. */
export const MARKETING_METRICS_IDLE_CLEANUP_INTERVAL_MS = 60_000;
/** 마지막 쓰기 이후 이 시간이 지나야 "유휴"로 본다. */
export const MARKETING_METRICS_IDLE_THRESHOLD_MS = 300_000;

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MarketingMetricsFailureReason =
  | "closed"
  | "queue_full"
  | "daily_event_cap"
  | "daily_total_cap"
  | "serialized_oversized"
  | "file_too_large"
  | "corrupt_file"
  | "read_failed"
  | "write_failed"
  | "directory_unavailable"
  | "unexpected";

/** notices 는 사유 코드 + 개수만 싣는다(경로/본문/헤더 값 등 메타데이터 금지). */
export type MarketingMetricsNoticeReason =
  | MarketingMetricsFailureReason
  | "recovered"
  | "pruned_days"
  | "disabled_by_config"
  | "config_invalid";

export type MarketingMetricsNotice = {
  level: "warn" | "error";
  reason: MarketingMetricsNoticeReason;
  errnoCode: string | null;
  droppedDays?: number;
};

/** 집계를 진행할 수 없는 상태 → 503 (라우트에서 매핑). */
export class MarketingMetricsUnavailableError extends Error {
  readonly reason: MarketingMetricsFailureReason;
  readonly errnoCode: string | null;

  constructor(reason: MarketingMetricsFailureReason, errnoCode?: unknown) {
    // 메시지에도 경로를 넣지 않는다.
    super(`marketing metrics unavailable: ${reason}`);
    this.name = "MarketingMetricsUnavailableError";
    this.reason = reason;
    this.errnoCode = normalizeErrnoCode(errnoCode);
  }
}

/** 상한/대기열 초과 → 507 (저장소 자체는 건강하다). */
export class MarketingMetricsCapacityError extends Error {
  readonly reason: MarketingMetricsFailureReason;

  constructor(reason: MarketingMetricsFailureReason) {
    super(`marketing metrics capacity: ${reason}`);
    this.name = "MarketingMetricsCapacityError";
    this.reason = reason;
  }
}

function normalizeErrnoCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_]{1,16}$/.test(value) ? value : null;
}

function errnoOf(error: unknown): string | null {
  return normalizeErrnoCode((error as { code?: unknown } | null | undefined)?.code);
}

function isEnoent(error: unknown): boolean {
  return errnoOf(error) === "ENOENT";
}

export type MarketingMetricsDayCounts = Partial<Record<MarketingEventName, number>>;

export type MarketingMetricsDay = {
  date: string;
  counts: MarketingMetricsDayCounts;
};

export type MarketingMetricsFile = {
  version: 1;
  days: MarketingMetricsDay[];
};

const EMPTY_FILE: MarketingMetricsFile = { version: 1, days: [] };

const countSchema = z
  .number()
  .int()
  .min(0)
  .max(MARKETING_METRICS_MAX_COUNT_PER_EVENT_PER_DAY);

const metricsDaySchema = z.strictObject({
  date: z.string().regex(UTC_DATE_PATTERN),
  counts: z.strictObject({
    personal_cost_saved: countSchema.optional(),
    personal_billing_date_saved: countSchema.optional(),
    personal_renewal_decision_saved: countSchema.optional()
  })
});

const metricsFileSchema = z.strictObject({
  version: z.literal(1),
  days: z.array(metricsDaySchema).max(MARKETING_METRICS_MAX_DAY_ENTRIES)
});

/**
 * 집계 파일 구조 검증. unknown key / wrong type / version != 1 / 중복 날짜 / 존재하지
 * 않는 달력 날짜 / 상한 초과 는 모두 "corrupt_file" 로 fail-closed 한다.
 * (날짜 순서는 강제하지 않고 쓰기 시 정규화한다.)
 */
export function parseMarketingMetricsFile(
  contents: string,
  maxFileBytes: number = MARKETING_METRICS_MAX_FILE_BYTES
): MarketingMetricsFile {
  if (Buffer.byteLength(contents, "utf8") > maxFileBytes) {
    throw new MarketingMetricsUnavailableError("file_too_large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(contents);
  } catch {
    throw new MarketingMetricsUnavailableError("corrupt_file");
  }

  const parsed = metricsFileSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MarketingMetricsUnavailableError("corrupt_file");
  }

  const seen = new Set<string>();
  const days: MarketingMetricsDay[] = [];

  for (const entry of parsed.data.days) {
    if (!isRealUtcDate(entry.date) || seen.has(entry.date)) {
      throw new MarketingMetricsUnavailableError("corrupt_file");
    }
    seen.add(entry.date);

    const counts: MarketingMetricsDayCounts = {};
    let total = 0;
    for (const eventName of MARKETING_EVENT_NAMES) {
      const value = entry.counts[eventName];
      if (value === undefined) continue;
      total += value;
      if (value > 0) counts[eventName] = value;
    }
    if (total > MARKETING_METRICS_MAX_EVENTS_PER_DAY) {
      throw new MarketingMetricsUnavailableError("corrupt_file");
    }

    days.push({ date: entry.date, counts });
  }

  return { version: 1, days };
}

/** 지정 epoch(ms) 의 UTC 날짜 키. */
export function utcDateKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isRealUtcDate(date: string): boolean {
  if (!UTC_DATE_PATTERN.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const stamp = Date.UTC(year, month - 1, day);
  if (Number.isNaN(stamp)) return false;
  const check = new Date(stamp);
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

function dayDifference(newerKey: string, olderKey: string): number {
  const newer = Date.parse(`${newerKey}T00:00:00.000Z`);
  const older = Date.parse(`${olderKey}T00:00:00.000Z`);
  return Math.round((newer - older) / 86_400_000);
}

function dayTotal(counts: MarketingMetricsDayCounts): number {
  return MARKETING_EVENT_NAMES.reduce((sum, name) => sum + (counts[name] ?? 0), 0);
}

/**
 * 보존 window 밖의 날짜(과거 + 미래)와 영(0)뿐인 날짜를 잘라낸다.
 * 미래 날짜는 클럭 스큐로 생길 수 있는데, 무한 성장을 막기 위해 버린다(집계는 손실).
 */
export function pruneMarketingMetricsDays(
  file: MarketingMetricsFile,
  todayKey: string,
  retentionDays: number = MARKETING_METRICS_RETENTION_DAYS
): { file: MarketingMetricsFile; droppedDays: number } {
  let droppedDays = 0;
  const days: MarketingMetricsDay[] = [];

  for (const entry of file.days) {
    const difference = dayDifference(todayKey, entry.date);
    if (difference < 0 || difference >= retentionDays || dayTotal(entry.counts) === 0) {
      droppedDays += 1;
      continue;
    }
    days.push({ date: entry.date, counts: { ...entry.counts } });
  }

  return { file: { version: 1, days: sortDays(days) }, droppedDays };
}

function sortDays(days: MarketingMetricsDay[]): MarketingMetricsDay[] {
  return [...days].sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
}

/**
 * canonical 직렬화: 날짜 오름차순 + 고정 이벤트 순서 + 0 제외 + 한 줄 compact.
 * 같은 상태는 항상 같은 바이트로 쓴다(결정적).
 * 예: {"version":1,"days":[{"date":"2026-10-05","counts":{"personal_cost_saved":3}}]}
 */
export function serializeMarketingMetricsFile(file: MarketingMetricsFile): string {
  const days = sortDays(file.days)
    .map((entry) => {
      const counts: Record<string, number> = {};
      for (const eventName of MARKETING_EVENT_NAMES) {
        const value = entry.counts[eventName];
        if (value !== undefined && value > 0) counts[eventName] = value;
      }
      return { date: entry.date, counts };
    })
    .filter((entry) => Object.keys(entry.counts).length > 0);

  return JSON.stringify({ version: 1, days });
}

/**
 * 디스크 I/O 경계. 테스트가 지연/오류/손상을 주입할 수 있게 최소 면만 공개한다.
 * 기본 구현: temp 같은 디렉터리 생성 → write → fsync → rename → directory fsync.
 */
export type MarketingMetricsFileSystem = {
  ensureDirectory(directory: string): Promise<void>;
  cleanupTemporary(filePath: string): Promise<void>;
  /** 파일이 없으면 null. */
  statSize(filePath: string): Promise<number | null>;
  readFile(filePath: string): Promise<Buffer>;
  atomicWrite(filePath: string, contents: string): Promise<void>;
};

function assertPrivate(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
      (!directory && stat.nlink !== 1) || !process.getuid || stat.uid !== process.getuid()) {
    throw new Error("unsafe collector storage");
  }
}

function assertIdentity(before: Stats, after: Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("collector storage changed");
}

// Only the dedicated immediate parent is required private. Ancestors such as /tmp
// can be shared; operators must prevent concurrent mutation by other same-UID writers.
async function privateDirectory(directory: string): Promise<Stats> {
  const before = await fs.lstat(directory);
  assertPrivate(before, true);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const after = await handle.stat();
    assertPrivate(after, true); assertIdentity(before, after);
  } finally { await handle.close(); }
  return before;
}

async function privateAggregate(filePath: string): Promise<Stats | null> {
  await privateDirectory(path.dirname(filePath));
  try {
    const stat = await fs.lstat(filePath);
    assertPrivate(stat, false);
    return stat;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function cleanupMarketingTemporary(filePath: string): Promise<void> {
  // Unsafe aggregate evidence must not trigger orphan removal.
  await privateAggregate(filePath);
  const temporary = `${filePath}.tmp`;
  try {
    const stale = await fs.lstat(temporary);
    assertPrivate(stale, false);
    await privateAggregate(filePath);
    assertIdentity(stale, await fs.lstat(temporary));
    await fs.unlink(temporary);
    const directoryHandle = await fs.open(path.dirname(filePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export const nodeMarketingMetricsFileSystem: MarketingMetricsFileSystem = {
  async ensureDirectory(directory) {
    try { await fs.lstat(directory); }
    catch (error) {
      if (!isEnoent(error)) throw error;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await privateDirectory(directory);
  },
  cleanupTemporary: cleanupMarketingTemporary,
  async statSize(filePath) {
    return (await privateAggregate(filePath))?.size ?? null;
  },
  async readFile(filePath) {
    const before = await privateAggregate(filePath);
    if (!before) throw new Error("aggregate disappeared");
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      assertPrivate(stat, false); assertIdentity(before, stat);
      if (!stat.isFile() || stat.size > MARKETING_METRICS_MAX_FILE_BYTES) {
        throw new Error("invalid aggregate file");
      }
      const buffer = Buffer.alloc(MARKETING_METRICS_MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MARKETING_METRICS_MAX_FILE_BYTES) throw new Error("aggregate too large");
      await privateDirectory(path.dirname(filePath));
      const after = await fs.lstat(filePath);
      assertPrivate(after, false); assertIdentity(stat, after);
      return buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  },
  async atomicWrite(filePath, contents) {
    const directory = path.dirname(filePath);
    // Exactly one crash-orphan slot. Requires an operator-owned private directory
    // and ONE writer process; never share this path between replicas.
    const temporary = `${filePath}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let owned = false;
    const parent = await privateDirectory(directory);
    const original = await privateAggregate(filePath);

    try {
      await cleanupMarketingTemporary(filePath);
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const temporaryStat = await handle.stat();
      assertPrivate(temporaryStat, false);
      await handle.close();
      handle = undefined;
      assertIdentity(parent, await privateDirectory(directory));
      const current = await privateAggregate(filePath);
      if (original && current) assertIdentity(original, current);
      else if (original !== current) throw new Error("aggregate changed before publication");
      const temporaryNow = await fs.lstat(temporary);
      assertPrivate(temporaryNow, false); assertIdentity(temporaryStat, temporaryNow);
      await fs.rename(temporary, filePath);

      // Failure after rename is an ambiguous commit: latch unavailable, NEVER retry.
      const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try {
        const stat = await directoryHandle.stat();
        assertPrivate(stat, true); assertIdentity(parent, stat);
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (owned) await cleanupMarketingTemporary(filePath).catch(() => undefined);
    }
  }
};

export type MarketingMetricsStoreOptions = {
  filePath: string;
  fileSystem?: MarketingMetricsFileSystem;
  retentionDays?: number;
  maxCountPerEventPerDay?: number;
  maxEventsPerDay?: number;
  maxFileBytes?: number;
  maxPendingWrites?: number;
  idleCleanupIntervalMs?: number;
  idleThresholdMs?: number;
  /** 테스트용 시계 주입. */
  now?: () => number;
  /**
   * 운영 알림 싱크. 사유 코드와 개수만 전달된다 — 파일 경로, 요청 본문, IP,
   * User-Agent 등 어떤 메타데이터도 여기로 흘러가지 않는다.
   */
  onNotice?: (notice: MarketingMetricsNotice) => void;
};

/** 집계 값은 노출하지 않는다: 가용성/대기열만 보는 상태 스냅샷. */
export type MarketingMetricsStatus = {
  available: boolean;
  reason: MarketingMetricsFailureReason | null;
  pendingWrites: number;
  closed: boolean;
};

/**
 * 단일 프로세스 직렬화 집계 스토어.
 *
 * true source 는 항상 디스크 파일이다. 기록은 [read → validate → prune → increment →
 * atomic write] 한 덩어리로 직렬 체인에서 실행된다. 단일 프로세스 전용이다.
 * Atomic rename does NOT coordinate other processes or external editors.
 */
export class MarketingMetricsStore {
  readonly #filePath: string;
  readonly #fileSystem: MarketingMetricsFileSystem;
  readonly #retentionDays: number;
  readonly #maxCountPerEventPerDay: number;
  readonly #maxEventsPerDay: number;
  readonly #maxFileBytes: number;
  readonly #maxPendingWrites: number;
  readonly #idleIntervalMs: number;
  readonly #idleThresholdMs: number;
  readonly #now: () => number;
  readonly #onNotice: (notice: MarketingMetricsNotice) => void;

  #chain: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #available = true;
  #reason: MarketingMetricsFailureReason | null = null;
  #lastWriteAt = 0;
  #closed = false;
  #initialized = false;
  #fileExpected = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MarketingMetricsStoreOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error("marketing metrics file path must be absolute");
    }

    this.#filePath = options.filePath;
    this.#fileSystem = options.fileSystem ?? nodeMarketingMetricsFileSystem;
    this.#retentionDays = options.retentionDays ?? MARKETING_METRICS_RETENTION_DAYS;
    this.#maxCountPerEventPerDay =
      options.maxCountPerEventPerDay ?? MARKETING_METRICS_MAX_COUNT_PER_EVENT_PER_DAY;
    this.#maxEventsPerDay = options.maxEventsPerDay ?? MARKETING_METRICS_MAX_EVENTS_PER_DAY;
    this.#maxFileBytes = options.maxFileBytes ?? MARKETING_METRICS_MAX_FILE_BYTES;
    this.#maxPendingWrites = Math.max(1, options.maxPendingWrites ?? MARKETING_METRICS_MAX_PENDING_WRITES);
    this.#idleIntervalMs = options.idleCleanupIntervalMs ?? MARKETING_METRICS_IDLE_CLEANUP_INTERVAL_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? MARKETING_METRICS_IDLE_THRESHOLD_MS;
    this.#now = options.now ?? Date.now;
    this.#onNotice = options.onNotice ?? (() => undefined);
  }

  get status(): MarketingMetricsStatus {
    return {
      available: this.#available,
      reason: this.#reason,
      pendingWrites: this.#pendingWrites,
      closed: this.#closed
    };
  }

  /**
   * 기동 시 1회: 디렉터리 보장 → 기존 파일 검증 → 보존 window 정리(변경 시에만 쓰기).
   * 어떤 실패도 throw 하지 않는다. 실패는 fail-closed 상태로 기록되고 이벤트는 503 을
   * 받는다 — 재무 API 전체의 부팅 실패로 번지지 않도록 격리된다.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await this.#serialize(() => this.#initializeLocked());

    if (this.#timer === undefined && !this.#closed && this.#idleIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.#idleTick();
      }, this.#idleIntervalMs);
      this.#timer.unref?.();
    }
  }

  async #initializeLocked(): Promise<void> {
    if (this.#closed) return;

    try {
      await this.#fileSystem.ensureDirectory(path.dirname(this.#filePath));
      // Even a valid empty published aggregate may have a crash orphan. Remove
      // that uncommitted slot at every startup, independent of retention writes.
      await this.#fileSystem.cleanupTemporary(this.#filePath);
    } catch (error) {
      this.#markUnavailable("directory_unavailable", errnoOf(error));
      return;
    }

    let file: MarketingMetricsFile | null;
    try {
      file = await this.#loadFile();
    } catch (error) {
      this.#failClosed(error);
      return;
    }

    const pruned = pruneMarketingMetricsDays(file ?? EMPTY_FILE, utcDateKey(this.#now()), this.#retentionDays);
    this.#markAvailable();
    if (pruned.droppedDays > 0) {
      this.#notice({ level: "warn", reason: "pruned_days", errnoCode: null, droppedDays: pruned.droppedDays });
    }

    // 파일이 없거나 정리가 실제로 일어난 경우에만 canonical 스냅샷을 쓴다.
    // (파손 파일은 위 loadFile 실패에서 이미 return → 절대 덮어쓰지 않는다.)
    if (file === null || pruned.droppedDays > 0) {
      try {
        await this.#persist(pruned.file);
      } catch (error) {
        this.#failClosed(error);
      }
    }
  }

  /**
   * 이벤트 1건 집계. 돌아오면 데이터는 이미 디스크에 원자적으로 반영돼 있다.
   * 실패 시에는 사유 코드만 던진다(요청 본문/헤더 메타데이터 없음).
   */
  async record(event: MarketingEventName): Promise<void> {
    if (this.#closed) throw new MarketingMetricsUnavailableError("closed");
    // Latched until operator repair and process restart. Never automatically retry.
    if (!this.#available) {
      throw new MarketingMetricsUnavailableError(this.#reason ?? "unexpected");
    }

    if (this.#pendingWrites >= this.#maxPendingWrites) {
      throw new MarketingMetricsCapacityError("queue_full");
    }

    this.#pendingWrites += 1;
    try {
      await this.#serialize(async () => {
        try { await this.#applyEvent(event); }
        catch (error) { this.#failClosed(error); throw error; }
      });
    } catch (error) {
      if (error instanceof MarketingMetricsCapacityError) throw error;
      if (error instanceof MarketingMetricsUnavailableError) {
        this.#markUnavailable(error.reason, error.errnoCode);
        throw error;
      }
      this.#markUnavailable("unexpected", errnoOf(error));
      throw new MarketingMetricsUnavailableError("unexpected", errnoOf(error));
    } finally {
      this.#pendingWrites -= 1;
    }
  }

  /**
   * 보존 window 정리(기동/유휴 주기에서 사용). 잘려나간 날이 있을 때만 쓴다.
   * 반환은 지운 날짜 "개수"뿐(집계 값 자체는 어디에도 노출하지 않는다).
   */
  async retainNow(): Promise<{ droppedDays: number; rewritten: boolean }> {
    if (this.#closed) throw new MarketingMetricsUnavailableError("closed");
    if (!this.#available) throw new MarketingMetricsUnavailableError(this.#reason ?? "unexpected");
    if (this.#pendingWrites >= this.#maxPendingWrites) throw new MarketingMetricsCapacityError("queue_full");

    this.#pendingWrites += 1;
    try {
      return await this.#serialize(async () => {
        let file: MarketingMetricsFile | null;
        try {
          file = await this.#loadFile();
        } catch (error) {
          this.#failClosed(error);
          throw this.#asUnavailable(error);
        }

        if (file === null) {
          this.#markAvailable();
          return { droppedDays: 0, rewritten: false };
        }

        const pruned = pruneMarketingMetricsDays(file, utcDateKey(this.#now()), this.#retentionDays);
        this.#markAvailable();
        if (pruned.droppedDays === 0) return { droppedDays: 0, rewritten: false };

        await this.#persist(pruned.file);
        return { droppedDays: pruned.droppedDays, rewritten: true };
      });
    } catch (error) {
      if (error instanceof MarketingMetricsUnavailableError) {
        this.#markUnavailable(error.reason, error.errnoCode);
        throw error;
      }
      if (error instanceof MarketingMetricsCapacityError) throw error;
      this.#markUnavailable("unexpected", errnoOf(error));
      throw new MarketingMetricsUnavailableError("unexpected", errnoOf(error));
    } finally {
      this.#pendingWrites -= 1;
    }
  }

  /** 타이머 정지 + 남은 직렬 작업 드레인. 이후 record 는 fail-closed(closed). */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#chain.catch(() => undefined);
  }

  async #applyEvent(event: MarketingEventName): Promise<void> {
    if (!this.#available) throw new MarketingMetricsUnavailableError(this.#reason ?? "unexpected");
    const todayKey = utcDateKey(this.#now());

    let file: MarketingMetricsFile | null;
    try {
      file = await this.#loadFile();
    } catch (error) {
      if (error instanceof MarketingMetricsUnavailableError) throw error;
      throw new MarketingMetricsUnavailableError("read_failed", errnoOf(error));
    }

    // 읽기/검증이 성공했다면 이전 fail-closed 상태에서 회복된 것이다.
    this.#markAvailable();

    const pruned = pruneMarketingMetricsDays(file ?? EMPTY_FILE, todayKey, this.#retentionDays);
    if (pruned.droppedDays > 0) {
      this.#notice({ level: "warn", reason: "pruned_days", errnoCode: null, droppedDays: pruned.droppedDays });
    }
    const days = pruned.file.days;

    let today = days.find((entry) => entry.date === todayKey);
    if (!today) {
      // 절대 바운드 재확인(리텐션으로 충분하지만 방어적으로).
      if (days.length >= this.#retentionDays) days.shift();
      today = { date: todayKey, counts: {} };
      days.push(today);
    }

    const current = today.counts[event] ?? 0;
    // 상한은 증가 "전에" 검사: 거부되는 이벤트는 디스크를 전혀 건드리지 않는다.
    if (current >= this.#maxCountPerEventPerDay) {
      throw new MarketingMetricsCapacityError("daily_event_cap");
    }
    if (dayTotal(today.counts) >= this.#maxEventsPerDay) {
      throw new MarketingMetricsCapacityError("daily_total_cap");
    }

    const nextFile: MarketingMetricsFile = {
      version: 1,
      days: days.map((entry) =>
        entry.date === todayKey
          ? { date: entry.date, counts: { ...entry.counts, [event]: current + 1 } }
          : { date: entry.date, counts: { ...entry.counts } }
      )
    };

    await this.#persist(nextFile);
  }

  /** 파일 부재는 null, 파손/상한/IO 실패는 Unavailable. */
  async #loadFile(): Promise<MarketingMetricsFile | null> {
    let size: number | null;
    try {
      size = await this.#fileSystem.statSize(this.#filePath);
    } catch (error) {
      throw new MarketingMetricsUnavailableError("read_failed", errnoOf(error));
    }
    if (size === null) {
      if (this.#fileExpected) throw new MarketingMetricsUnavailableError("read_failed");
      return null;
    }
    this.#fileExpected = true;
    // 거대한 파일을 메모리에 올리지 않기: 크기 초과면 parse 조차 하지 않는다.
    if (size > this.#maxFileBytes) throw new MarketingMetricsUnavailableError("file_too_large");

    let buffer: Buffer;
    try {
      buffer = await this.#fileSystem.readFile(this.#filePath);
    } catch (error) {
      throw new MarketingMetricsUnavailableError("read_failed", errnoOf(error));
    }

    try {
      return parseMarketingMetricsFile(buffer.toString("utf8"), this.#maxFileBytes);
    } catch (error) {
      if (error instanceof MarketingMetricsUnavailableError) throw error;
      throw new MarketingMetricsUnavailableError("corrupt_file");
    }
  }

  async #persist(file: MarketingMetricsFile): Promise<void> {
    const serialized = serializeMarketingMetricsFile(file);
    if (Buffer.byteLength(serialized, "utf8") > this.#maxFileBytes) {
      // 우리 직렬화 자체가 상한을 넘으면 쓰지 않고 거부한다(파일 통제 유지).
      throw new MarketingMetricsCapacityError("serialized_oversized");
    }
    try {
      await this.#fileSystem.atomicWrite(this.#filePath, serialized);
    } catch (error) {
      this.#markUnavailable("write_failed", errnoOf(error));
      throw new MarketingMetricsUnavailableError("write_failed", errnoOf(error));
    }
    this.#lastWriteAt = this.#now();
    this.#fileExpected = true;
  }

  /** 프로세스 안에서만 직렬화되는 쓰기 체인. */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #asUnavailable(error: unknown): MarketingMetricsUnavailableError {
    if (error instanceof MarketingMetricsUnavailableError) return error;
    return new MarketingMetricsUnavailableError("unexpected", errnoOf(error));
  }

  #failClosed(error: unknown): void {
    if (error instanceof MarketingMetricsUnavailableError) {
      this.#markUnavailable(error.reason, error.errnoCode);
      return;
    }
    if (error instanceof MarketingMetricsCapacityError) {
      // 상한 문제는 상태를 망가뜨리지 않는다(쓰기를 건너뛴 것).
      this.#notice({ level: "warn", reason: error.reason, errnoCode: null });
      return;
    }
    this.#markUnavailable("unexpected", errnoOf(error));
  }

  #markUnavailable(reason: MarketingMetricsFailureReason, errnoCode: string | null = null): void {
    const changed = this.#available || this.#reason !== reason;
    this.#available = false;
    this.#reason = reason;
    if (changed) this.#notice({ level: "error", reason, errnoCode });
  }

  #markAvailable(): void {
    if (!this.#available) {
      this.#notice({ level: "warn", reason: "recovered", errnoCode: null });
    }
    this.#available = true;
    this.#reason = null;
  }

  async #idleTick(): Promise<void> {
    if (this.#closed || this.#pendingWrites > 0) return;
    // 유휴가 아니면 정리하지 않는다(쓰기와 경쟁하지 않기 위해).
    if (this.#now() - this.#lastWriteAt < this.#idleThresholdMs) return;
    try {
      const result = await this.retainNow();
      if (result.droppedDays > 0) {
        this.#notice({ level: "warn", reason: "pruned_days", errnoCode: null, droppedDays: result.droppedDays });
      }
    } catch {
      // 백그라운드 정리 실패는 retainNow/markUnavailable 안에서 이미 기록된다.
      // 유휴 작업이 프로세스를 죽이거나 중복 로그를 남기지 않도록 여기서 삼킨다.
    }
  }

  #notice(notice: MarketingMetricsNotice): void {
    try {
      this.#onNotice(notice);
    } catch {
      // 알림 실패로 집계를 망가뜨리지 않는다.
    }
  }
}

/**
 * Fastify `disableRequestLogging` predicate.
 *
 * 이 라우트는 성공/거절/오류 어느 경우에도 요청·본문·쿼리를 기록하지 않는다.
 * Fastify 기본 로거는 4xx/5xx 및 404 에서 `req`(url + remoteAddress 등)를 남기기
 * 때문에, marketing events 경로 자체를 무음화한다. 다른 라우트의 보안 로그는
 * 전혀 완화하지 않는다(조건이 붙는 경로만).
 *
 * 인자가 FastifyRequest 라도 raw IncomingMessage 라도 url 을 뽑아낸다
 * (404/bad-url 코드는 raw 를 넘긴다).
 */
export function shouldDisableRequestLogging(candidate: unknown): boolean {
  return isMarketingMetricsRequest(candidate);
}

export function isMarketingMetricsRequest(candidate: unknown): boolean {
  return matchesMarketingMetricsUrl(extractRequestUrl(candidate));
}

function extractRequestUrl(candidate: unknown): string {
  if (typeof candidate === "string") return candidate;
  if (!candidate || typeof candidate !== "object") return "";
  const record = candidate as Record<string, unknown>;
  if (typeof record.url === "string") return record.url;
  const raw = record.raw;
  if (raw && typeof raw === "object") {
    const rawUrl = (raw as Record<string, unknown>).url;
    if (typeof rawUrl === "string") return rawUrl;
  }
  return "";
}

/** prefix 가 붙은 실제 경로(`/living-cost-manager/v1/marketing/events`)도 매칭한다. */
export function matchesMarketingMetricsUrl(url: string): boolean {
  if (url.length === 0) return false;
  const withoutQuery = url.split("?")[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === MARKETING_METRICS_ROUTE_PATH || trimmed.endsWith(MARKETING_METRICS_ROUTE_PATH);
}

/**
 * Sec-GPC / Do Not Track 신호 존중 여부. `Sec-GPC: 1` 이나 `DNT: 1` 중 하나라도
 * 있으면 이벤트를 저장하지 않는다(응답은 저장된 경우와 구별 불가능하게 동일).
 */
export function hasPrivacyOptOutSignal(
  headers: Record<string, string | string[] | undefined>
): boolean {
  return isOptOutValue(headers.dnt) || isOptOutValue(headers["sec-gpc"]);
}

function isOptOutValue(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() === "1";
}

export type MarketingMetricsConfig = {
  /** true 일 때만 라우트를 등록한다. */
  enabled: boolean;
  filePath: string | null;
  /** enabled 이데 등록을 건너뛴 사유(운영 로그용. 경로 값은 넣지 않는다). */
  disabledReason: "not_enabled" | "missing_file" | "relative_path" | null;
};

/**
 * feature flag 해석: `MARKETING_METRICS_ENABLED=true` 이고 절대경로
 * `MARKETING_METRICS_FILE` 이 있을 때만 켠다(default off).
 * 켜는 조건을 만족 못 하면 collector 만 끈다(재무 API 부팅은 계속).
 */
export function resolveMarketingMetricsConfig(env: {
  MARKETING_METRICS_ENABLED: boolean;
  MARKETING_METRICS_FILE?: string | undefined;
}): MarketingMetricsConfig {
  if (!env.MARKETING_METRICS_ENABLED) {
    return { enabled: false, filePath: null, disabledReason: "not_enabled" };
  }

  const configured = typeof env.MARKETING_METRICS_FILE === "string" ? env.MARKETING_METRICS_FILE.trim() : "";
  if (configured.length === 0) {
    return { enabled: false, filePath: null, disabledReason: "missing_file" };
  }
  if (!path.isAbsolute(configured) || configured.includes("\0")) {
    return { enabled: false, filePath: null, disabledReason: "relative_path" };
  }

  return { enabled: true, filePath: configured, disabledReason: null };
}
