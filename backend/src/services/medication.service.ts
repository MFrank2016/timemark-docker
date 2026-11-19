import { query } from "../db/index.js";
import { localMidnightMs } from "./agent/local-day.js";
import {
  MEDICATION_REFILL_DAYS,
  MEDICATION_SNOOZE_MINUTES,
  buildDoseSnoozeKey,
  computeDaysOfSupply,
  normalizeMedicationTimes,
  shiftCalendarDays,
} from "@timemark/shared";
import type {
  AdherenceBucket,
  AdherenceReport,
  CreateMedicationInput,
  DoseStatus,
  LogDoseInput,
  MedicationAdherence,
  MedicationDoseRecord,
  MedicationRecord,
  RefillItem,
  RefillReason,
  TodayDose,
  UpdateMedicationInput,
} from "@timemark/shared";

/**
 * 家庭用药服务（D3，checkbox 71/72）�? *
 * 约定�?habit/expiry 服务相同�? * - 所有读写按 user_id 限定；他人的�?= null / 0，由路由映射 404�? * - 剂量�?medication.schedule_times 在「用户（或档案）时区」的本地日生成，
 *   `scheduled_for` 是绝对时刻；UNIQUE(medication_id, scheduled_for) 让物化幂等�? * - 从不自动把剂量标�?taken：只有用户显式记录才 taken/skipped；一天结束后�? *   pending 的才由每日任务补记为 missed�? * - 提醒与记�?ONLY：不做医疗建议、不接药房、不对数据做 AI 推断�? */

type Raw = Record<string, unknown>;

const DEFAULT_TZ = "Asia/Shanghai";

function parseYmdText(value: unknown): string | null {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function parseIsoText(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  return s.length > 0 ? s : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mapMedication(row: Raw): MedicationRecord {
  const form = String(row.form ?? "tablet");
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    profile_id: row.profile_id == null ? null : Number(row.profile_id),
    name: String(row.name ?? ""),
    dosage: row.dosage == null ? null : String(row.dosage),
    form: ([
      "tablet",
      "capsule",
      "liquid",
      "injection",
      "patch",
      "drops",
      "other",
    ].includes(form)
      ? form
      : "other") as MedicationRecord["form"],
    schedule_times: normalizeMedicationTimes(row.schedule_times),
    schedule_days: Array.isArray(row.schedule_days)
      ? (row.schedule_days as unknown[])
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v))
      : null,
    start_date: parseYmdText(row.start_date) ?? "",
    end_date: parseYmdText(row.end_date),
    stock_quantity: toNumberOrNull(row.stock_quantity),
    stock_unit: row.stock_unit == null ? null : String(row.stock_unit),
    units_per_dose: toNumberOrNull(row.units_per_dose) ?? 1,
    refill_threshold: toNumberOrNull(row.refill_threshold),
    prescriber: row.prescriber == null ? null : String(row.prescriber),
    pharmacy: row.pharmacy == null ? null : String(row.pharmacy),
    notes: row.notes == null ? null : String(row.notes),
    is_active: row.is_active !== false,
    is_critical: row.is_critical === true,
    created_at: parseIsoText(row.created_at),
    updated_at: parseIsoText(row.updated_at),
  };
}

export function mapDose(row: Raw): MedicationDoseRecord {
  const status = String(row.status ?? "pending");
  return {
    id: Number(row.id),
    medication_id: Number(row.medication_id),
    user_id: Number(row.user_id),
    scheduled_for: parseIsoText(row.scheduled_for) ?? "",
    logged_at: parseIsoText(row.logged_at),
    status: (["taken", "skipped", "missed", "pending"].includes(status)
      ? status
      : "pending") as DoseStatus,
    note: row.note == null ? null : String(row.note),
    created_at: parseIsoText(row.created_at),
  };
}

async function getUserTimezone(userId: number): Promise<string> {
  const result = await query(
    "SELECT timezone FROM user_configs WHERE user_id = $1",
    [userId],
  );
  const tz = result.rows[0]?.timezone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_TZ;
}

/** 用户 / 档案时区（档案配置了时区优先�?*/
export async function getMedicationTimezone(
  userId: number,
  profileId: number | null | undefined,
): Promise<string> {
  if (profileId != null) {
    const result = await query(
      "SELECT timezone FROM profiles WHERE id = $1 AND user_id = $2",
      [profileId, userId],
    );
    const tz = result.rows[0]?.timezone;
    if (typeof tz === "string" && tz.trim()) return tz.trim();
  }
  return getUserTimezone(userId);
}

function localTodayYmd(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * 本地「某日 + HH:mm」→ UTC 绝对时刻字符串 `YYYY-MM-DD HH:MM:SS`。
 *
 * PG 的 `($1::date + t.time::time) AT TIME ZONE tz` 在 SQLite 无法表达，
 * 改为在 JS 侧用 `localMidnightMs`（已处理 DST 两次迭代）算出当地零点，
 * 再加上时分偏移。输出格式必须与 `normalizeSqliteParam` 一致（无 T 无 Z），
 * 否则 UNIQUE(medication_id, scheduled_for) 幂等失效 → 重复剂量行。
 */
function localTimeToUtcStamp(
  ymd: string,
  hhmm: string,
  timeZone: string,
): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm).trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const ms = localMidnightMs(ymd, timeZone) + hh * 3_600_000 + mm * 60_000;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** 本地日的 [00:00, 次日 00:00) UTC 边界，供 `scheduled_for >= ? AND < ?` 使用。 */
function localDayWindowUtc(ymd: string, timeZone: string): [string, string] {
  const start = localMidnightMs(ymd, timeZone);
  const end = localMidnightMs(shiftCalendarDays(ymd, 1) as string, timeZone);
  const fmt = (ms: number) =>
    new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  return [fmt(start), fmt(end)];
}

/** UTC 时刻串（`YYYY-MM-DD HH:MM:SS`）→ 该时刻在 timeZone 的本地日期 `YYYY-MM-DD`。 */
function utcStampToLocalYmd(stamp: unknown, timeZone: string): string | null {
  if (stamp == null || stamp === "") return null;
  const ms = Date.parse(String(stamp).replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return null;
  return localTodayYmd(new Date(ms), timeZone);
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listMedications(
  userId: number,
  opts: { active?: boolean; profileId?: number | null } = {},
): Promise<MedicationRecord[]> {
  const activeClause =
    opts.active === undefined
      ? ""
      : opts.active
        ? " AND is_active = TRUE"
        : " AND is_active = FALSE";
  const params: number[] = [userId];
  let profileClause = "";
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = " AND profile_id = $2";
  }
  const result = await query(
    `SELECT * FROM medications WHERE user_id = $1${activeClause}${profileClause} ORDER BY created_at ASC, id ASC`,
    params,
  );
  return (result.rows as Raw[]).map(mapMedication);
}

export async function getMedication(
  userId: number,
  id: number,
): Promise<MedicationRecord | null> {
  const result = await query(
    "SELECT * FROM medications WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  const row = result.rows[0] as Raw | undefined;
  return row ? mapMedication(row) : null;
}

export async function createMedication(
  userId: number,
  input: CreateMedicationInput,
): Promise<MedicationRecord> {
  const result = await query(
    `INSERT INTO medications
       (user_id, profile_id, name, dosage, form, schedule_times, schedule_days, start_date, end_date,
        stock_quantity, stock_unit, units_per_dose, refill_threshold, prescriber, pharmacy, notes, is_active, is_critical)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 1::numeric), $13, $14, $15, $16, COALESCE($17, TRUE), COALESCE($18, FALSE))
     RETURNING *`,
    [
      userId,
      input.profileId ?? null,
      input.name,
      input.dosage ?? null,
      input.form ?? "tablet",
      normalizeMedicationTimes(input.scheduleTimes ?? []),
      input.scheduleDays
        ? [...new Set(input.scheduleDays)].sort((a, b) => a - b)
        : null,
      input.startDate,
      input.endDate ?? null,
      input.stockQuantity ?? null,
      input.stockUnit ?? null,
      input.unitsPerDose ?? null,
      input.refillThreshold ?? null,
      input.prescriber ?? null,
      input.pharmacy ?? null,
      input.notes ?? null,
      input.isActive ?? null,
      input.isCritical ?? null,
    ],
  );
  return mapMedication(result.rows[0] as Raw);
}

export async function updateMedication(
  userId: number,
  id: number,
  input: UpdateMedicationInput,
): Promise<MedicationRecord | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  const set = (column: string, value: unknown): void => {
    updates.push(`${column} = $${idx++}`);
    values.push(value);
  };

  if (input.name !== undefined) set("name", input.name);
  if (input.dosage !== undefined) set("dosage", input.dosage ?? null);
  if (input.form !== undefined) set("form", input.form);
  if (input.scheduleTimes !== undefined)
    set("schedule_times", normalizeMedicationTimes(input.scheduleTimes));
  if (input.scheduleDays !== undefined) {
    set(
      "schedule_days",
      input.scheduleDays
        ? [...new Set(input.scheduleDays)].sort((a, b) => a - b)
        : null,
    );
  }
  if (input.startDate !== undefined) set("start_date", input.startDate);
  if (input.endDate !== undefined) set("end_date", input.endDate ?? null);
  if (input.stockQuantity !== undefined)
    set("stock_quantity", input.stockQuantity ?? null);
  if (input.stockUnit !== undefined) set("stock_unit", input.stockUnit ?? null);
  if (input.unitsPerDose !== undefined)
    set("units_per_dose", input.unitsPerDose);
  if (input.refillThreshold !== undefined)
    set("refill_threshold", input.refillThreshold ?? null);
  if (input.prescriber !== undefined)
    set("prescriber", input.prescriber ?? null);
  if (input.pharmacy !== undefined) set("pharmacy", input.pharmacy ?? null);
  if (input.notes !== undefined) set("notes", input.notes ?? null);
  if (input.isActive !== undefined) set("is_active", input.isActive);
  if (input.isCritical !== undefined) set("is_critical", input.isCritical);
  if (input.profileId !== undefined) set("profile_id", input.profileId ?? null);

  if (updates.length === 0) return getMedication(userId, id);

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id, userId);
  const result = await query(
    `UPDATE medications SET ${updates.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
    values,
  );
  const row = result.rows[0] as Raw | undefined;
  return row ? mapMedication(row) : null;
}

export async function deleteMedication(
  userId: number,
  id: number,
): Promise<boolean> {
  const result = await query(
    "DELETE FROM medications WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* 剂量物化 / 补记 missed                                              */
/* ------------------------------------------------------------------ */

/**
 * 为某一天物化剂量（幂等）：每个 schedule_times 生成一�?pending�? * 时区取档案优先、否则用户时区。`schedule_days` �?/ 起止日期外的药品不生成�? * 返回新插入的行数（已存在的不计）�? */
export async function materializeDosesForDate(
  targetYmd: string,
  userId?: number,
): Promise<number> {
  // SQLite 不支持 AT TIME ZONE / LATERAL unnest / array_length：
  // 改为 JS 侧展开 schedule_times 并计算绝对时刻，再逐条幂等插入。
  // 时区取「档案优先，否则用户」，与 PG 版 COALESCE(p.timezone, uc.timezone, $3) 等价。
  const rows = await query(
    `SELECT m.id, m.user_id, m.schedule_times, m.schedule_days,
            COALESCE(p.timezone, uc.timezone, $3) AS tz
     FROM medications m
     LEFT JOIN user_configs uc ON uc.user_id = m.user_id
     LEFT JOIN profiles p ON p.id = m.profile_id
     WHERE m.is_active = TRUE
       AND m.schedule_times IS NOT NULL
       AND json_array_length(m.schedule_times) > 0
       AND m.start_date <= $1
       AND (m.end_date IS NULL OR m.end_date >= $1)
       AND ($2 IS NULL OR m.user_id = $2)`,
    [targetYmd, userId ?? null, DEFAULT_TZ],
  );

  // PG 的 EXTRACT(DOW FROM date)：周日=0。JS getUTCDay() 同语义。
  const dow = new Date(`${targetYmd}T00:00:00Z`).getUTCDay();
  let inserted = 0;

  for (const raw of rows.rows as Array<Record<string, unknown>>) {
    const daysRaw = raw.schedule_days;
    if (daysRaw != null) {
      let days: unknown = daysRaw;
      if (typeof days === "string") {
        try {
          days = JSON.parse(days);
        } catch {
          days = null;
        }
      }
      if (Array.isArray(days) && !days.map(Number).includes(dow)) continue;
    }

    let times: unknown = raw.schedule_times;
    if (typeof times === "string") {
      try {
        times = JSON.parse(times);
      } catch {
        times = [];
      }
    }
    if (!Array.isArray(times)) continue;

    const tz =
      typeof raw.tz === "string" && raw.tz.trim() ? raw.tz.trim() : DEFAULT_TZ;
    for (const t of times) {
      const stamp = localTimeToUtcStamp(targetYmd, String(t), tz);
      if (!stamp) continue;
      const r = await query(
        `INSERT INTO medication_doses (medication_id, user_id, scheduled_for, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (medication_id, scheduled_for) DO NOTHING
         RETURNING id`,
        [raw.id, raw.user_id, stamp],
      );
      inserted += r.rows.length;
    }
  }
  return inserted;
}

/**
 * 每日物化：为每支药品在它自己的时区里物化「今�?.. 今天+daysAhead」的剂量
 * （默认覆盖今天与明天，供提醒�?/today 直接命中）。幂等：UNIQUE 冲突直接跳过�? * 若给�?userId，只处理该用户的药品�? */
export async function materializeUpcomingDoses(
  userId?: number,
  daysAhead = 1,
): Promise<number> {
  // SQLite 无 AT TIME ZONE / generate_series / LATERAL unnest / array_length。
  // 改为：先按药品各自的时区算出「本地今天」，再在 JS 里展开 [0..daysAhead] × schedule_times，
  // 逐条幂等插入。语义与 PG 版一致（每支药用自己的时区判断今天与星期）。
  const rows = await query(
    `SELECT m.id, m.user_id, m.schedule_times, m.schedule_days,
            COALESCE(p.timezone, uc.timezone, $1) AS tz
     FROM medications m
     LEFT JOIN user_configs uc ON uc.user_id = m.user_id
     LEFT JOIN profiles p ON p.id = m.profile_id
     WHERE m.is_active = TRUE
       AND m.schedule_times IS NOT NULL
       AND json_array_length(m.schedule_times) > 0
       AND ($2 IS NULL OR m.user_id = $2)`,
    [DEFAULT_TZ, userId ?? null],
  );

  const span = Math.max(0, Math.trunc(daysAhead));
  const now = new Date();
  let inserted = 0;

  for (const raw of rows.rows as Array<Record<string, unknown>>) {
    const tz =
      typeof raw.tz === "string" && raw.tz.trim() ? raw.tz.trim() : DEFAULT_TZ;
    const localToday = localTodayYmd(now, tz);

    let daysRaw: unknown = raw.schedule_days;
    if (typeof daysRaw === "string") {
      try {
        daysRaw = JSON.parse(daysRaw);
      } catch {
        daysRaw = null;
      }
    }
    const allowedDays = Array.isArray(daysRaw) ? daysRaw.map(Number) : null;

    let times: unknown = raw.schedule_times;
    if (typeof times === "string") {
      try {
        times = JSON.parse(times);
      } catch {
        times = [];
      }
    }
    if (!Array.isArray(times)) continue;

    for (let n = 0; n <= span; n += 1) {
      const ymd = shiftCalendarDays(localToday, n) as string;
      const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
      if (allowedDays && !allowedDays.includes(dow)) continue;
      for (const t of times) {
        const stamp = localTimeToUtcStamp(ymd, String(t), tz);
        if (!stamp) continue;
        const r = await query(
          `INSERT INTO medication_doses (medication_id, user_id, scheduled_for, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (medication_id, scheduled_for) DO NOTHING
           RETURNING id`,
          [raw.id, raw.user_id, stamp],
        );
        inserted += r.rows.length;
      }
    }
  }
  return inserted;
}

/** 365 天剂量历史保留（与 todo_completions / habit_logs 一致），由 daily-maintenance 调用 */
export async function purgeOldMedicationDoses(
  retentionDays = 365,
): Promise<number> {
  // SQLite 无 `int * interval`：改为 JS 算出截止时刻，SQL 只做字符串比较。
  const days = Math.max(1, Math.trunc(retentionDays));
  const cutoff = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const result = await query(
    `DELETE FROM medication_doses WHERE scheduled_for < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}

/**
 * 每日收尾：把「所属用户时区里今天已经开始」之前仍 pending 的剂量补记为 missed。
 * 今天尚未结束（用户本地当天）的 pending 不处理，提醒仍有机会发出。
 */
export async function markMissedDoses(): Promise<number> {
  // SQLite 不支持 `UPDATE ... FROM ... JOIN` 与 AT TIME ZONE：
  // 先取每支药的本地零点（UTC 时刻），再按 medication_id 分组批量更新。
  const rows = await query(
    `SELECT m.id AS medication_id,
            COALESCE(p.timezone, uc.timezone, $1) AS tz
     FROM medications m
     LEFT JOIN user_configs uc ON uc.user_id = m.user_id
     LEFT JOIN profiles p ON p.id = m.profile_id`,
    [DEFAULT_TZ],
  );

  const now = new Date();
  let missed = 0;
  for (const raw of rows.rows as Array<Record<string, unknown>>) {
    const tz =
      typeof raw.tz === "string" && raw.tz.trim() ? raw.tz.trim() : DEFAULT_TZ;
    const todayStart = new Date(localMidnightMs(localTodayYmd(now, tz), tz))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const r = await query(
      `UPDATE medication_doses
       SET status = 'missed'
       WHERE medication_id = $1 AND status = 'pending' AND scheduled_for < $2
       RETURNING id`,
      [raw.medication_id, todayStart],
    );
    missed += r.rows.length;
  }
  return missed;
}

/**
 * 「今天」的剂量：先幂等物化今天，再按时区窗口取回（含药品摘要），按时间升序�? */
export async function getTodayDoses(
  userId: number,
  opts: { profileId?: number | null; now?: Date } = {},
): Promise<TodayDose[]> {
  const now = opts.now ?? new Date();
  const timeZone = await getMedicationTimezone(userId, opts.profileId ?? null);
  const today = localTodayYmd(now, timeZone);
  await materializeDosesForDate(today, userId);

  // SQLite 不支持 `date_trunc(... AT TIME ZONE ...)`：
  // 改为 JS 算出本地日的 [00:00, 次日 00:00) UTC 边界，SQL 只做字符串比较。
  // 返回行集合与 PG 版完全一致（只是边界从 DB 算变 JS 算）。
  const [dayStart, dayEnd] = localDayWindowUtc(today, timeZone);

  const params: unknown[] = [userId, dayStart, dayEnd];
  let profileClause = "";
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = " AND m.profile_id = $4";
  }
  const result = await query(
    `SELECT d.*, m.name, m.dosage, m.form, m.units_per_dose, m.stock_unit, m.is_critical, m.profile_id
     FROM medication_doses d
     JOIN medications m ON m.id = d.medication_id
     WHERE d.user_id = $1
       AND d.scheduled_for >= $2
       AND d.scheduled_for < $3
       ${profileClause}
     ORDER BY d.scheduled_for ASC, d.id ASC`,
    params,
  );
  return (result.rows as Raw[]).map((row) => {
    const formRaw = String(row.form ?? "tablet");
    return {
      ...mapDose(row),
      medication: {
        id: Number(row.medication_id),
        name: String(row.name ?? ""),
        dosage: row.dosage == null ? null : String(row.dosage),
        form: ([
          "tablet",
          "capsule",
          "liquid",
          "injection",
          "patch",
          "drops",
          "other",
        ].includes(formRaw)
          ? formRaw
          : "other") as TodayDose["medication"]["form"],
        units_per_dose: toNumberOrNull(row.units_per_dose) ?? 1,
        stock_unit: row.stock_unit == null ? null : String(row.stock_unit),
        is_critical: row.is_critical === true,
        profile_id: row.profile_id == null ? null : Number(row.profile_id),
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* 剂量记录（幂�?+ 库存�?                                            */
/* ------------------------------------------------------------------ */

export type LogDoseResult =
  | { status: "ok"; dose: MedicationDoseRecord; stockQuantity: number | null }
  | { status: "not_found" }
  | { status: "future_dose"; scheduledFor: string };

/**
 * 记录剂量 taken/skipped。幂等：
 * - 只有从「非 taken」变�?taken 才扣库存；taken �?taken 不重复扣�? * - taken �?skipped 会把库存加回（保持库存与记录一致）�? * - 未来剂量一律拒绝（scheduled_for 晚于当前时刻）�? * - stock_quantity �?GREATEST(0, �? 兜底，绝不越过数据库�?>= 0 约束�? */
export async function logDose(
  userId: number,
  doseId: number,
  input: LogDoseInput,
  now: Date = new Date(),
): Promise<LogDoseResult> {
  const owned = await query(
    `SELECT d.id, d.status, d.scheduled_for, d.medication_id, m.units_per_dose
     FROM medication_doses d
     JOIN medications m ON m.id = d.medication_id
     WHERE d.id = $1 AND d.user_id = $2`,
    [doseId, userId],
  );
  const current = owned.rows[0] as Raw | undefined;
  if (!current) return { status: "not_found" };

  const scheduledFor = parseIsoText(current.scheduled_for) ?? "";
  const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
  if (scheduledDate && scheduledDate.getTime() > now.getTime()) {
    return { status: "future_dose", scheduledFor };
  }

  const previousStatus = String(current.status ?? "pending");
  const unitsPerDose = toNumberOrNull(current.units_per_dose) ?? 1;

  const updated = await query(
    `UPDATE medication_doses
     SET status = $1, logged_at = CURRENT_TIMESTAMP, note = $2
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [input.status, input.note ?? null, doseId, userId],
  );
  const dose = mapDose(updated.rows[0] as Raw);

  let stockQuantity: number | null = null;
  const shouldDecrement =
    input.status === "taken" && previousStatus !== "taken";
  const shouldRestore =
    input.status === "skipped" && previousStatus === "taken";
  if (shouldDecrement || shouldRestore) {
    const delta = shouldDecrement ? unitsPerDose : -unitsPerDose;
    const stock = await query(
      `UPDATE medications
       SET stock_quantity = max(0, stock_quantity - $1), updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 AND stock_quantity IS NOT NULL
       RETURNING stock_quantity`,
      [delta, Number(current.medication_id), userId],
    );
    stockQuantity = toNumberOrNull(
      (stock.rows[0] as Raw | undefined)?.stock_quantity,
    );
  } else {
    const stock = await query(
      "SELECT stock_quantity FROM medications WHERE id = $1 AND user_id = $2",
      [Number(current.medication_id), userId],
    );
    stockQuantity = toNumberOrNull(
      (stock.rows[0] as Raw | undefined)?.stock_quantity,
    );
  }

  return { status: "ok", dose, stockQuantity };
}

/* ------------------------------------------------------------------ */
/* 稍后提醒（checkbox 73）                                             */
/* ------------------------------------------------------------------ */

export type SnoozeDoseResult =
  | { status: "ok"; doseId: number; snoozedUntil: string }
  | { status: "not_found" }
  | { status: "already_logged" };

/**
 * 请求「稍后提醒」：记录一条 pending 的 snooze claim（键含 snoozeAt），提醒任务在
 * 到点时再发一条并写 `med:snooze-sent#…` 去重。已记录（taken/skipped/missed）的
 * 剂量不允许稍后提醒——它已经结束了。
 */
export async function snoozeDose(
  userId: number,
  doseId: number,
  now: Date = new Date(),
): Promise<SnoozeDoseResult> {
  const owned = await query(
    "SELECT id, status FROM medication_doses WHERE id = $1 AND user_id = $2",
    [doseId, userId],
  );
  const row = owned.rows[0] as Raw | undefined;
  if (!row) return { status: "not_found" };
  if (String(row.status) !== "pending") return { status: "already_logged" };

  const snoozedUntil = new Date(
    now.getTime() + MEDICATION_SNOOZE_MINUTES * 60_000,
  ).toISOString();
  await query(
    `INSERT INTO reminder_send_claims (event_id, trigger_date) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [doseId, buildDoseSnoozeKey(doseId, snoozedUntil)],
  );
  return { status: "ok", doseId, snoozedUntil };
}

/* ------------------------------------------------------------------ */
/* 依从性                                                              */
/* ------------------------------------------------------------------ */

function emptyBucket(): AdherenceBucket {
  return {
    taken: 0,
    skipped: 0,
    missed: 0,
    total: 0,
    percentage: 0,
    currentStreak: 0,
  };
}

function finalizeBucket(bucket: AdherenceBucket): AdherenceBucket {
  bucket.total = bucket.taken + bucket.skipped + bucket.missed;
  bucket.percentage =
    bucket.total > 0 ? Math.round((bucket.taken / bucket.total) * 100) : 0;
  return bucket;
}

/**
 * �?`to` 往前数「全部服用」的连续天数：某天有剂量�?�? taken�? skipped�? missed
 * 才计入；遇到没有剂量的日子停止�? */
function computeStreak(
  byDate: Map<string, { taken: number; skipped: number; missed: number }>,
  to: string,
): number {
  let streak = 0;
  let cursor: string | null = to;
  let guard = 0;
  while (cursor && guard < 3660) {
    guard += 1;
    const day = byDate.get(cursor);
    if (!day) break;
    if (day.taken > 0 && day.skipped === 0 && day.missed === 0) {
      streak += 1;
    } else {
      break;
    }
    cursor = shiftCalendarDays(cursor, -1);
  }
  return streak;
}

/**
 * 依从性：区间内每药品与整体的 taken/skipped/missed 计数、百分比与当前连胜�? * pending 不计入分母；percentage = round(taken / total * 100)，total=0 �?0�? */
export async function getAdherence(
  userId: number,
  from: string,
  to: string,
  opts: { profileId?: number | null } = {},
): Promise<AdherenceReport> {
  const timeZone = await getMedicationTimezone(userId, opts.profileId ?? null);
  // SQLite 不支持 `to_char(... AT TIME ZONE ...)`：改为 SQL 只取 scheduled_for，
  // 由 JS 换算成本地日期后分组（本地日归属需要时区信息，SQL 无法表达）。
  const [rangeStart, rangeEnd] = (() => {
    const start = new Date(localMidnightMs(from, timeZone))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const end = new Date(localMidnightMs(shiftCalendarDays(to, 1) as string, timeZone))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    return [start, end];
  })();
  const params: unknown[] = [userId, rangeStart, rangeEnd];
  let profileClause = "";
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = " AND m.profile_id = $4";
  }
  const result = await query(
    `SELECT d.medication_id, m.name, d.scheduled_for, d.status
     FROM medication_doses d
     JOIN medications m ON m.id = d.medication_id
     WHERE d.user_id = $1
       AND d.scheduled_for >= $2
       AND d.scheduled_for < $3
       ${profileClause}
     ORDER BY d.medication_id ASC, d.scheduled_for ASC`,
    params,
  );

  const perMed = new Map<
    number,
    {
      name: string;
      bucket: AdherenceBucket;
      byDate: Map<string, { taken: number; skipped: number; missed: number }>;
    }
  >();
  const overallByDate = new Map<
    string,
    { taken: number; skipped: number; missed: number }
  >();
  const overall = emptyBucket();

  for (const row of result.rows as Raw[]) {
    const medicationId = Number(row.medication_id);
    const name = String(row.name ?? "");
    // dose_date 原先由 SQL 的 to_char(AT TIME ZONE) 给出；现在由 JS 按时区换算。
    const date = utcStampToLocalYmd(row.scheduled_for, timeZone);
    const status = String(row.status ?? "pending");
    if (!date) continue;

    const entry = perMed.get(medicationId) ?? {
      name,
      bucket: emptyBucket(),
      byDate: new Map(),
    };
    if (status === "taken" || status === "skipped" || status === "missed") {
      entry.bucket[status] += 1;
      overall[status] += 1;
      const day = entry.byDate.get(date) ?? { taken: 0, skipped: 0, missed: 0 };
      day[status] += 1;
      entry.byDate.set(date, day);
      const oday = overallByDate.get(date) ?? {
        taken: 0,
        skipped: 0,
        missed: 0,
      };
      oday[status] += 1;
      overallByDate.set(date, oday);
    }
    perMed.set(medicationId, entry);
  }

  const medications: MedicationAdherence[] = [...perMed.entries()].map(
    ([medicationId, entry]) => {
      const bucket = finalizeBucket(entry.bucket);
      bucket.currentStreak = computeStreak(entry.byDate, to);
      return { medicationId, name: entry.name, ...bucket };
    },
  );

  const overallFinal = finalizeBucket(overall);
  overallFinal.currentStreak = computeStreak(overallByDate, to);

  return { from, to, overall: overallFinal, medications };
}

/** 医生报告的「每日明细」一行：某本地日的已结算剂量数（pending 不计入）。 */
export interface AdherenceDailyPoint {
  date: string;
  taken: number;
  skipped: number;
  missed: number;
}

/**
 * 区间内按「本地日」聚合的 taken/skipped/missed（checkbox 74 每日明细）。
 *
 * 与 `getAdherence` 使用同一时区解析、同一窗口语义（`[from, to]` 的本地日闭区间）
 * 与同一 profile 过滤；唯一差别是聚合粒度。percent 等百分比仍由 `getAdherence` 给出，
 * 这里绝不重复实现百分比/连胜的计算。
 */
export async function getAdherenceDaily(
  userId: number,
  from: string,
  to: string,
  opts: { profileId?: number | null } = {},
): Promise<AdherenceDailyPoint[]> {
  const timeZone = await getMedicationTimezone(userId, opts.profileId ?? null);
  // SQLite 不支持 `to_char(... AT TIME ZONE ...)` 与 FILTER 里的 cast：
  // 改为 SQL 只取 scheduled_for + status，JS 换算本地日期并聚合。
  const [rangeStart, rangeEnd] = (() => {
    const start = new Date(localMidnightMs(from, timeZone))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const end = new Date(localMidnightMs(shiftCalendarDays(to, 1) as string, timeZone))
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    return [start, end];
  })();
  const params: unknown[] = [userId, rangeStart, rangeEnd];
  let profileClause = "";
  if (opts.profileId != null) {
    params.push(opts.profileId);
    profileClause = " AND m.profile_id = $4";
  }
  const result = await query(
    `SELECT d.scheduled_for, d.status
     FROM medication_doses d
     JOIN medications m ON m.id = d.medication_id
     WHERE d.user_id = $1
       AND d.scheduled_for >= $2
       AND d.scheduled_for < $3
       AND d.status IN ('taken', 'skipped', 'missed')
       ${profileClause}`,
    params,
  );
  // 原 SQL 用 GROUP BY 让 DB 聚合；现在行已取回，在 JS 里按本地日聚合（需时区换算）。
  const byDate = new Map<
    string,
    { taken: number; skipped: number; missed: number }
  >();
  for (const row of result.rows as Raw[]) {
    const date = utcStampToLocalYmd(row.scheduled_for, timeZone);
    const status = String(row.status ?? "");
    if (!date) continue;
    if (status !== "taken" && status !== "skipped" && status !== "missed")
      continue;
    const day = byDate.get(date) ?? { taken: 0, skipped: 0, missed: 0 };
    day[status] += 1;
    byDate.set(date, day);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

/* ------------------------------------------------------------------ */
/* 补货提醒                                                            */
/* ------------------------------------------------------------------ */

/**
 * 需要补货的药品：库存低�?refill_threshold，或预计可维持天�?< 7�? * 可维持天�?= 库存 / (每次用量 × 平均每天次数)；无法推算（无库�?PRN）时只按阈值�? * 天数保留两位小数�? */
export async function getRefills(
  userId: number,
  opts: { profileId?: number | null } = {},
): Promise<RefillItem[]> {
  const medications = await listMedications(userId, {
    active: true,
    profileId: opts.profileId ?? null,
  });
  const items: RefillItem[] = [];
  for (const med of medications) {
    if (med.stock_quantity == null) continue;
    const days = computeDaysOfSupply(
      med.stock_quantity,
      med.units_per_dose,
      med.schedule_times,
      med.schedule_days,
    );
    const daysOfSupply = days == null ? null : Math.round(days * 100) / 100;
    const belowThreshold =
      med.refill_threshold != null && med.stock_quantity < med.refill_threshold;
    const belowDays =
      daysOfSupply != null && daysOfSupply < MEDICATION_REFILL_DAYS;
    if (!belowThreshold && !belowDays) continue;
    const reason: RefillReason =
      belowThreshold && belowDays
        ? "both"
        : belowThreshold
          ? "threshold"
          : "days_of_supply";
    items.push({
      medicationId: med.id,
      name: med.name,
      profile_id: med.profile_id,
      stockQuantity: med.stock_quantity,
      stockUnit: med.stock_unit,
      unitsPerDose: med.units_per_dose,
      refillThreshold: med.refill_threshold,
      daysOfSupply,
      reason,
    });
  }
  return items;
}
