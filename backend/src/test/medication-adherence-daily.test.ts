import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Checkbox 74 - the per-day aggregation must reuse the same window/timezone
 * semantics as `getAdherence` and stay user/profile-scoped. Pending doses are
 * excluded, so they can never inflate a doctor-facing number.
 *
 * 注意（SQLite 适配）：`scheduled_for` 存 UTC 时刻串，本地日归属无法在 SQL 里用
 * `AT TIME ZONE` 表达，因此聚合改在 JS 完成。断言仍锁定同一组语义约束：
 * 窗口按用户时区的本地日边界、只计 taken/skipped/missed、按本地日分组。
 */

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("../db/index.js", () => ({
  query: dbQuery,
  waitForDb: vi.fn(),
  getClient: vi.fn(),
}));

import { getAdherenceDaily } from "../services/medication.service.js";

interface QueryCall {
  sql: string;
  params: unknown[];
}

function calls(): QueryCall[] {
  const rawCalls = dbQuery.mock.calls as unknown as Array<[string, unknown[]?]>;
  return rawCalls.map(([sql, params]) => ({ sql, params: params ?? [] }));
}

beforeEach(() => {
  dbQuery.mockReset();
  dbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM user_configs")) {
      return { rows: [{ timezone: "Asia/Shanghai" }], rowCount: 1 };
    }
    // Asia/Shanghai = UTC+8：本地 2026-09-01 00:00 == UTC 2026-08-31 16:00
    return {
      rows: [
        { scheduled_for: "2026-08-31 16:30:00", status: "taken" }, // 本地 09-01
        { scheduled_for: "2026-09-01 01:00:00", status: "taken" }, // 本地 09-01
        { scheduled_for: "2026-09-01 02:00:00", status: "missed" }, // 本地 09-01
        { scheduled_for: "2026-09-01 16:30:00", status: "taken" }, // 本地 09-02
        { scheduled_for: "2026-09-01 17:00:00", status: "skipped" }, // 本地 09-02
        { scheduled_for: "2026-09-02 03:00:00", status: "pending" }, // 本地 09-02，pending 不计
      ],
      rowCount: 6,
    };
  });
});

describe("getAdherenceDaily (checkbox 74)", () => {
  it("maps per-day counts and scopes the window to user + local timezone", async () => {
    const daily = await getAdherenceDaily(7, "2026-09-01", "2026-09-03");
    expect(daily).toEqual([
      { date: "2026-09-01", taken: 2, skipped: 0, missed: 1 },
      { date: "2026-09-02", taken: 1, skipped: 1, missed: 0 },
    ]);

    const doseCall = calls().find((entry) =>
      entry.sql.includes("medication_doses d"),
    );
    expect(doseCall).toBeDefined();
    // 窗口边界由 JS 按本地日换算成 UTC 时刻串（Asia/Shanghai = UTC+8）
    expect(doseCall?.params.slice(0, 3)).toEqual([
      7,
      "2026-08-31 16:00:00",
      "2026-09-03 16:00:00",
    ]);
    expect(doseCall?.sql).toContain(
      "d.status IN ('taken', 'skipped', 'missed')",
    );
    expect(doseCall?.sql).not.toContain("m.profile_id");
  });

  it("appends the profile predicate only when a profile is requested", async () => {
    await getAdherenceDaily(7, "2026-09-01", "2026-09-03", { profileId: 11 });
    const doseCall = calls().find((entry) =>
      entry.sql.includes("medication_doses d"),
    );
    expect(doseCall?.params).toEqual([
      7,
      "2026-08-31 16:00:00",
      "2026-09-03 16:00:00",
      11,
    ]);
    expect(doseCall?.sql).toContain("m.profile_id = $4");
  });

  it("returns an empty array for an empty period", async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM user_configs")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    expect(await getAdherenceDaily(7, "2026-09-01", "2026-09-03")).toEqual([]);
  });
});
