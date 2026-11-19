# SQL 转换器系统性修复 · 实施计划

**目标：** 修复 v2.30 换装遗留的 PG→SQLite 方言转换缺陷，使今日概览 3 张卡片、调度器 cadence 提醒等端点恢复正常，并消除同根因的潜在 500。

**Spec/依据：** explorer 实证分析（4 个报错点 SQL 原文 + sql.js 实跑验证的修法）+ oracle 策略审查（规则边界、风险排序、分阶段顺序）。

**关键判断（已验证）：** 全部为历史遗留（commit 794b933，2026-10-11），与本次部署无关；新旧镜像 backend 树哈希相同。

## 边界（oracle 判定）

**进转换器（逐 token 局部重写，安全）：**

- `to_char(x,'FMT')` → strftime；修守卫为 `/[A-Z]/.test(f.replace(/%[YmdHMS]/g,''))`（1 行覆盖 13 处）
- `LEFT(x,n)` → `substr(x,1,n)`，正则须精确要求「逗号+数字」，避免误伤 `LEFT JOIN`
- `EXTRACT(YEAR|MONTH|DAY|DOW|EPOCH FROM x)` → `CAST(strftime(...) AS INT)`（`%w` 周日=0 与 PG DOW 一致）
- `expr * INTERVAL '1 unit'` → 去符号拼接（**必须不带 `+` 前缀**，否则负数返回 NULL）
- `make_interval(<unit> => n)` → 必须连左侧 `expr ± make_interval(...)` 整体匹配，不能硬编码 `'now'`
- `(...)::type` 兜底（修 `exprTail` 或加未消费 `::` 兜底）
- 复合 `INTERVAL '1 month - 1 day'`

**必须改文件（结构/类型语义，正则无法安全表达）：**

- LATERAL 4 处 → 相关标量子查询
- unnest 3 处 → json_each（`t.time` 引用须改 `t.value`）
- generate_series 2 处 → JS 生成 或 递归 CTE
- `~` 2 处 → 手写 GLOB（**不做通用规则**，GLOB 不支持 `{n,m}`/`|`/分组）
- AT TIME ZONE → **参数化时区窗口**（不改返回形状）：把 DB 算的边界变 JS 算的参数，用已有 `local-day.ts` 的 `localMidnightMs`

## 阶段（每阶段可独立回退）

- **阶段 0（前置门禁）**：新增静态编译探针——扫 `backend/src/**/*.ts` 的 `query()` 字面量 → `convertPgToSqliteInner` → 空 schema 库 `db.prepare()` 编译（不执行）。产出完整失败清单 + 残留关键字检测。**先跑出清单再动转换器。**
- **阶段 1**：转换器增量规则，每条配「执行值」断言（不是字符串断言）。顺序：to_char 守卫 → LEFT → EXTRACT → `* INTERVAL` → make_interval 多单位 → `::` 兜底 → 复合 interval。改完重跑阶段 0：失败数须严格减少且不新增。
- **阶段 2**：结构 SQL 改文件（LATERAL / unnest / generate_series / `~`），每文件同步跑既有测试。
- **阶段 3（最高风险，单独）**：时区参数化（medication.service.ts 8 处 + decision-card 1 处）。先落 helper 单测（DST 跳变/重复/跨年/非法 tz），再改。**格式必须与 `normalizeSqliteParam` 一致**（`toISOString().slice(0,19).replace('T',' ')`），否则 UNIQUE 幂等失效→重复剂量行。
- **阶段 4**：验证收口——静态探针 0 残留、4 个端点 200、vitest 全绿、probe-queue-sql 仍绿。

## 停止条件

静态探针 0 残留 + 4 个报错端点正常 + 无新增失败。**不**顺手重构转换器、不统一 date()/datetime()、不补 DISTINCT ON。

## 关键风险

- R1 规则顺序 → 「文本+文本」数值加法 = 静默全表命中（`'2026-11-19' + '2026-11-20'` = 4052）。每条规则必须断执行值。
- R5 `CURRENT_DATE ± INTERVAL` 用 datetime() 而非 date()（PG 返回 timestamp）；`>=` 场景用 date() 会漏掉当天。
- 时区：DST 边界按 `localMidnightMs` 两次迭代法；不引入 `create_function`。

## 验证清单

1. 静态编译探针（新增）：0 失败
2. 转换器回归探针：每条规则断执行值
3. `probe-queue-sql.mjs`、`probe-migrate-chain.mjs`、`probe-upgrade-path.mjs` 仍绿
4. `probe-boot-smoke.mjs` 补 4 个端点断言
5. `pnpm vitest run`（backend）
6. 时区 helper 单测（4 个固定时刻）
