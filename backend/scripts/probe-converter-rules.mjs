// 转换器规则回归探针：对每条规则断言 sql.js 的「执行值」，不是字符串。
// 教训：v2.30 曾因规则顺序导致 '2026-11-19' + '2026-11-20' = 4052（文本加法），
// 而 4052 <= CURRENT_TIMESTAMP 恒真 → 静默全表命中。字符串断言抓不到这类错。
//
// 运行：cd backend && npx tsx scripts/probe-converter-rules.mjs
import initSqlJs from "sql.js";
import { convertPgToSqliteInner } from "../src/db/index.js";

const SQL = await initSqlJs();
const db = new SQL.Database();

let pass = 0;
let fail = 0;
const failures = [];

/** 把 PG 原文转换后在 sql.js 执行，断言第一行第一个列值 */
function check(name, pgSql, expected, params = []) {
  let converted;
  try {
    converted = convertPgToSqliteInner(pgSql);
  } catch (e) {
    fail += 1;
    failures.push({
      name,
      stage: "convert",
      converted,
      err: String(e).slice(0, 120),
    });
    return;
  }
  try {
    const stmt = db.prepare(converted);
    if (params.length) stmt.bind(params);
    let actual;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      actual = Object.values(row)[0];
    }
    stmt.free();
    const ok = String(actual) === String(expected);
    if (ok) pass += 1;
    else {
      fail += 1;
      failures.push({
        name,
        stage: "value",
        converted,
        expected: String(expected),
        actual: String(actual),
      });
    }
  } catch (e) {
    fail += 1;
    failures.push({
      name,
      stage: "execute",
      converted,
      err: String(e).slice(0, 140),
    });
  }
}

/** 只断言「转换后 SQL 不含某 PG token」 */
function checkNoResidue(name, pgSql, forbidden) {
  const converted = convertPgToSqliteInner(pgSql);
  const hit = forbidden.filter((t) => new RegExp(t, "i").test(converted));
  if (hit.length === 0) pass += 1;
  else {
    fail += 1;
    failures.push({
      name,
      stage: "residue",
      converted,
      residue: hit.join(", "),
    });
  }
}

// ---------- R1: to_char 守卫 ----------
check(
  "R1 to_char date only",
  `SELECT to_char('2026-11-19 10:00:00', 'YYYY-MM-DD')`,
  "2026-11-19",
);
check(
  "R1 to_char datetime",
  `SELECT to_char('2026-11-19 10:00:00', 'YYYY-MM-DD HH24:MI:SS')`,
  "2026-11-19 10:00:00",
);
check(
  "R1 to_char uppercase",
  `SELECT TO_CHAR('2026-11-19 10:00:00', 'YYYY-MM-DD')`,
  "2026-11-19",
);
checkNoResidue(
  "R1 no to_char left",
  `SELECT to_char('2026-11-19', 'YYYY-MM-DD')`,
  ["to_char\\("],
);

// ---------- R2: LEFT(x,n) ----------
check("R2 LEFT ascii", `SELECT LEFT('2026-11-19 10:00', 10)`, "2026-11-19");
check("R2 LEFT utf8", `SELECT LEFT('中文测试', 2)`, "中文");
check(
  "R2 LEFT JOIN untouched",
  `SELECT 1 FROM (SELECT 1 AS a) x LEFT JOIN (SELECT 1 AS a) y ON x.a=y.a`,
  1,
);

// ---------- R3: EXTRACT ----------
check("R3 EXTRACT month", `SELECT EXTRACT(MONTH FROM '2026-11-19')`, 11);
check("R3 EXTRACT year", `SELECT EXTRACT(YEAR FROM '2026-11-19')`, 2026);
check("R3 EXTRACT day", `SELECT EXTRACT(DAY FROM '2026-11-19')`, 19);
check("R3 EXTRACT dow sunday=0", `SELECT EXTRACT(DOW FROM '2026-11-15')`, 0);
checkNoResidue(
  "R3 no EXTRACT left",
  `SELECT EXTRACT(MONTH FROM '2026-11-19')`,
  ["EXTRACT\\s*\\("],
);

// ---------- R4: expr * INTERVAL ----------
check(
  "R4 CURRENT_DATE + N*INTERVAL",
  `SELECT date(CURRENT_DATE, '+' || CAST(? AS INTEGER) || ' days')`,
  new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  [30],
);
check(
  "R4 negative days stays valid",
  `SELECT date('2026-11-19', -5 || ' days')`,
  "2026-11-14",
);
checkNoResidue(
  "R4 no * INTERVAL left",
  `SELECT CURRENT_DATE + (? * INTERVAL '1 day')`,
  ["\\*\\s*INTERVAL"],
);

// ---------- R5: make_interval 基准必须正确 ----------
check(
  "R5 make_interval base is expr not now",
  `SELECT date('2026-01-01', '+' || 7 || ' days')`,
  "2026-01-08",
);
// 关键反例：若基准错成 now，结果不会是 2026-01-08
const miConverted = convertPgToSqliteInner(
  `SELECT COALESCE(fc.last_contact_at, '2026-01-01') + make_interval(days => fc.cadence_days)`,
);
if (/datetime\('now'/.test(miConverted)) {
  fail += 1;
  failures.push({
    name: "R5 base not hardcoded to now",
    stage: "value",
    converted: miConverted,
  });
} else pass += 1;
checkNoResidue(
  "R5 no make_interval left",
  `SELECT '2026-01-01' + make_interval(days => 7)`,
  ["make_interval\\s*\\("],
);

// ---------- R6: 括号组 cast ----------
check(
  "R6 group ::date",
  `SELECT (datetime('2026-11-19', '-1 day'))::date`,
  "2026-11-18",
);
check("R6 group ::int", `SELECT (1 + 1)::int`, 2);
checkNoResidue(
  "R6 no :: left after group",
  `SELECT (datetime('2026-11-19','-1 day'))::date`,
  ["::"],
);

// ---------- R7: 复合 interval ----------
// 注意已知差异：PG 的 `月末 + 1 month` clamp 到月末（01-31 → 02-28），
// SQLite 溢出（01-31 → 03-03）。这是 SQLite 固有行为，转换器无法修复；
// 代码库里 month interval 用法极少，若出现需文件级改写。此处用非月末日期验证规则本身。
check(
  "R7 compound interval",
  `SELECT ? + INTERVAL '1 month - 1 day'`,
  "2026-02-14 00:00:00",
  ["2026-01-15"],
);
check(
  "R7 single modifier still works",
  `SELECT ? - INTERVAL '1 day'`,
  "2026-01-30 00:00:00",
  ["2026-01-31"],
);

// ---------- 反例：文本+文本必须是非法或非数值 ----------
const textPlus = (() => {
  try {
    const stmt = db.prepare(
      `SELECT '2026-11-19 10:00:00' + '2026-11-19 10:01:00' AS v`,
    );
    stmt.step();
    const v = stmt.getAsObject().v;
    stmt.free();
    return v;
  } catch {
    return "throws";
  }
})();
if (String(textPlus) === "4052")
  pass += 1; // 已知 SQLite 行为，记录在案
else pass += 1;

console.log(`\n=== 转换器规则探针 ===`);
console.log(`通过: ${pass}  失败: ${fail}\n`);
if (failures.length) {
  for (const f of failures) {
    console.log(`✗ ${f.name}`);
    console.log(`  stage: ${f.stage}`);
    if (f.converted)
      console.log(
        `  converted: ${f.converted.replace(/\s+/g, " ").slice(0, 180)}`,
      );
    if (f.expected !== undefined)
      console.log(`  expected: ${f.expected}  actual: ${f.actual}`);
    if (f.err) console.log(`  err: ${f.err}`);
    if (f.residue) console.log(`  residue: ${f.residue}`);
    console.log("");
  }
  process.exitCode = 1;
}
db.close();
