// 静态 SQL 编译探针：量清 backend/src 里经 convertPgToSqliteInner() 转换后仍在
// SQLite 上编译不过的 SQL，以及转换器没吃掉的 PG 残留 token。
//
// 用法（必须在 backend/ 下运行，脚本与源码共用同一份依赖解析）：
//   cd backend && npx tsx scripts/probe-sql-compile.mjs
//
// schema 来源：仓库里没有 backend/docker/schema.sql，实际 schema 是 docker/schema.sql
// （仅 14 张基础表）+ migrate.ts 的 v2..v81 增量链。只跑 schema.sql 会让 90% 的表报
// no such table、掩盖真实语法错，因此这里跑完整迁移链来建库。
//
// 幂等、无副作用：DB_PATH 指向系统临时目录的一次性库，运行结束删除，不碰
// ./data/timemark.db；不修改 src/。
// 同时写机读报告：backend/scripts/.probe-sql-compile-report.json（已加入 .gitignore）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(BACKEND_ROOT, "src");
const REPORT_PATH = path.join(HERE, ".probe-sql-compile-report.json");
const TEMP_DB = path.join(
  os.tmpdir(),
  `timemark-probe-sql-compile-${process.pid}.db`,
);

// src/db/index.ts 在模块顶层读 DB_PATH，静态 import 会被提升——必须 env 先行 + 动态 import。
process.env.DB_PATH = TEMP_DB;
process.env.LOG_QUERIES = "false";

// ───────────────────────── 1. 扫描 query(`...`) 模板 ─────────────────────────

const SQL_CALL_RE =
  /(^|[^\w$.'"`])(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?query\s*(?:<[^<>()]*>)?\s*\(/g;

function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1)
    if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** 跳过 `${ ... }`（含其中的字符串与嵌套大括号），返回右花括号之后的下标。 */
function skipInterpolation(source, start) {
  let depth = 1;
  let j = start + 2;
  let inStr = null;
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (inStr) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      j += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      j += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    j += 1;
  }
  return j;
}

/** 从反引号开始读模板字面量，${...} 整体替换成 __X__ 以便静态编译。 */
function readTemplate(source, start) {
  let i = start + 1;
  let sql = "";
  let interp = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      sql += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      i += 1;
      return { sql, end: i, interp };
    }
    if (ch === "$" && source[i + 1] === "{") {
      i = skipInterpolation(source, i);
      sql += "__X__";
      interp += 1;
      continue;
    }
    sql += ch;
    i += 1;
  }
  return { sql, end: i, interp }; // 未闭合（语法错的文件）也不静默吞掉
}

/**
 * 把注释与普通字符串/正则字面量替换成空格（等长，位置不变），模板字面量原样保留。
 * 这样注释里的「query(`...`)」示例不会算成真实调用，而字符串里的 `/api/*` 也不会
 * 被误当成块注释起点（否则会吞掉后面整段代码，实测漏掉 app.ts 的 3 条 SQL）。
 * 正则字面量必须识别，否则 /[「『"']/ 这类字符类里的引号会被当成字符串起点。
 */
const REGEX_PRECEDERS = new Set([..."(,=:[!&|?{};+-*%<>~^", "/"]);
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
]);

function maskComments(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1)
      if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = ""; // 上一个有意义的非空白字符（或关键字尾字母序列）
  let prevWord = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch || source[j] === "\n") {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      prev = ch;
      prevWord = "";
      i = j;
      continue;
    }
    if (
      ch === "/" &&
      (REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.has(prevWord))
    ) {
      // 正则字面量：跳过字符类与转义，止于未转义且不在字符类内的 /
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      prev = "/";
      prevWord = "";
      i = j;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") {
          j += 1;
          break;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          j = skipInterpolation(source, j);
          continue;
        }
        j += 1;
      }
      prev = "`";
      prevWord = "";
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) {
      prev = ch;
      if (/[A-Za-z_$]/.test(ch)) {
        const start = i;
        while (i + 1 < source.length && /[\w$]/.test(source[i + 1])) i += 1;
        prevWord = source.slice(start, i + 1);
      } else {
        prevWord = "";
      }
    }
    i += 1;
  }
  return out.join("");
}

function scanFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const masked = maskComments(source);
  const starts = lineIndex(source);
  const found = [];
  SQL_CALL_RE.lastIndex = 0;
  let m;
  while ((m = SQL_CALL_RE.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    let i = openParen + 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== "`") continue;
    const tpl = readTemplate(source, i);
    found.push({
      file: path.relative(BACKEND_ROOT, file),
      line: lineOf(starts, i),
      sql: tpl.sql,
      interp: tpl.interp,
    });
    SQL_CALL_RE.lastIndex = tpl.end;
  }
  return found;
}

function walkTs(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    )
      acc.push(full);
  }
  return acc;
}

// ───────────────────────── 2. 残留 PG token 检测 ─────────────────────────

const RESIDUAL_TOKENS = [
  ["::", /::/g],
  ["LATERAL", /\bLATERAL\b/g],
  ["unnest(", /\bunnest\s*\(/g],
  ["AT TIME ZONE", /\bAT\s+TIME\s+ZONE\b/g],
  ["EXTRACT(", /\bEXTRACT\s*\(/g],
  ["generate_series(", /\bgenerate_series\s*\(/g],
  ["make_interval(", /\bmake_interval\s*\(/g],
  ["interval '", /\binterval\s+'/g],
  ["LEFT(x,", /\bLEFT\s*\(\s*[^)]*,/g],
  ["~ '", /~\s*'/g],
  ["to_char(", /\bto_char\s*\(/g],
  ["date_trunc(", /\bdate_trunc\s*\(/g],
  ["jsonb_", /\bjsonb_/g],
  ["ILIKE", /\bILIKE\b/g],
];

function detectResiduals(sql) {
  const hits = [];
  for (const [name, re] of RESIDUAL_TOKENS) {
    re.lastIndex = 0;
    const n = (sql.match(re) || []).length;
    if (n > 0) hits.push({ token: name, count: n });
  }
  return hits;
}

// ───────────────────────── 3. schema 构造（临时库 + 全量迁移链） ─────────────────────────

async function buildSchemaDb() {
  const muted = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const { runMigrations } = await import("../src/db/migrate.js");
    const { getDb, gracefulShutdown } = await import("../src/db/index.js");
    await runMigrations();
    return { db: getDb(), gracefulShutdown };
  } finally {
    console.log = muted.log;
    console.warn = muted.warn;
    console.error = muted.error;
  }
}

// ───────────────────────── 4. 编译 + 归类 ─────────────────────────

function classify(message) {
  if (!message) return "empty";
  if (/no such table|no such column|has no column named/i.test(message))
    return "schema-missing";
  if (/no such function/i.test(message)) return "missing-function";
  if (
    /syntax error|unrecognized token|incomplete input|incomplete|near "/i.test(
      message,
    )
  )
    return "syntax";
  return "other";
}

// 插值占位符（__X__）会吃掉整段子句（`SET ${sets}`、`WHERE ${conds}`），由此产生的
// 语法错无法归因于方言转换器。只把「占位符本身报错」和「空子句」两类算作无法静态分析；
// 其余（near "AT"/unrecognized token ":"/near "i" 等）都是真实的 PG 残留。
const PLACEHOLDER_INDUCED = [
  /__X__/,
  /near "WHERE"/,
  /near ","/,
  /near "AS"/,
  /near "\)"/,
  /incomplete input/,
];

function isPlaceholderInduced(message) {
  return PLACEHOLDER_INDUCED.some((re) => re.test(message || ""));
}

function compileSql(db, splitSqlStatements, isExecutableSql, sql) {
  const statements = splitSqlStatements(sql).filter(isExecutableSql);
  if (statements.length === 0) return { kind: "empty", message: "空语句" };
  for (const statement of statements) {
    try {
      const stmt = db.prepare(statement);
      if (stmt) stmt.free();
    } catch (e) {
      return {
        kind: classify(String(e?.message ?? e)),
        message: String(e?.message ?? e),
        statement,
      };
    }
  }
  return { kind: "ok" };
}

// ───────────────────────── 5. 主流程 ─────────────────────────

const files = walkTs(SRC_ROOT, []).sort();
const entries = [];
for (const file of files) entries.push(...scanFile(file));

const { db, gracefulShutdown } = await buildSchemaDb();
const { splitSqlStatements } = await import("../src/db/sql-split.js");
const { isExecutableSql } = await import("../src/db/sql-split.js");
const { convertPgToSqliteInner } = await import("../src/db/index.js");

const results = [];
for (const entry of entries) {
  const converted = convertPgToSqliteInner(entry.sql);
  const compiled = compileSql(
    db,
    splitSqlStatements,
    isExecutableSql,
    converted,
  );
  const residuals = detectResiduals(converted);

  let bucket = "ok";
  if (compiled.kind === "syntax" || compiled.kind === "other") {
    // 只有「占位符本身报错 / 空子句」才算无法静态分析；near "AT"、token ":" 等是真实残留
    bucket =
      entry.interp > 0 && isPlaceholderInduced(compiled.message)
        ? "unanalyzable"
        : "syntax";
  } else if (
    compiled.kind === "schema-missing" ||
    compiled.kind === "missing-function"
  ) {
    // 插值吃掉了表名/列名（FROM ${table}），schema 缺失无法归因
    bucket = /__X__/.test(compiled.message || "")
      ? "unanalyzable"
      : compiled.kind;
  } else if (compiled.kind === "empty") {
    bucket = "empty";
  }

  results.push({
    file: entry.file,
    line: entry.line,
    interp: entry.interp,
    bucket,
    message: compiled.message ? compiled.message.slice(0, 160) : null,
    statement: compiled.statement
      ? compiled.statement.replace(/\s+/g, " ").trim().slice(0, 200)
      : null,
    residuals,
  });
}

{
  const muted = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    gracefulShutdown(); // 先把临时库落盘（db/index.ts 的关闭钩子）
    db.close();
  } catch {
    /* 已关闭 */
  } finally {
    console.log = muted.log;
    console.warn = muted.warn;
    console.error = muted.error;
  }
}
for (const suffix of ["", "-wal", "-shm", ".bak"])
  fs.rmSync(TEMP_DB + suffix, { force: true });

// ───────────────────────── 6. 汇总 + 输出 ─────────────────────────

const buckets = {
  ok: 0,
  syntax: 0,
  "schema-missing": 0,
  "missing-function": 0,
  unanalyzable: 0,
  empty: 0,
};
for (const r of results) buckets[r.bucket] += 1;

const residualCounts = {};
const residualRows = [];
for (const r of results) {
  if (r.residuals.length === 0) continue;
  residualRows.push(r);
  for (const hit of r.residuals)
    residualCounts[hit.token] = (residualCounts[hit.token] || 0) + hit.count;
}

const byFile = {};
function ensureFile(file) {
  byFile[file] ??= {
    sqlCount: 0,
    syntax: [],
    "schema-missing": [],
    "missing-function": [],
    unanalyzable: [],
    residual: [],
  };
  return byFile[file];
}
function addToFile(file, key, row) {
  ensureFile(file)[key].push(row);
}
for (const r of results) ensureFile(r.file).sqlCount += 1;
for (const r of results) {
  if (r.bucket !== "ok" && r.bucket !== "empty")
    addToFile(r.file, r.bucket, {
      line: r.line,
      message: r.message,
      statement: r.statement,
    });
  if (r.residuals.length > 0)
    addToFile(r.file, "residual", {
      line: r.line,
      tokens: r.residuals.map((h) => `${h.token}×${h.count}`).join(", "),
    });
}

const report = {
  generatedAt: new Date().toISOString(),
  scannedFiles: files.length,
  sqlTotal: results.length,
  buckets,
  residualCounts,
  residualRows: residualRows.map((r) => ({
    file: r.file,
    line: r.line,
    tokens: r.residuals,
  })),
  syntaxFailures: results.filter((r) => r.bucket === "syntax"),
  schemaMissing: results.filter((r) => r.bucket === "schema-missing"),
  missingFunction: results.filter((r) => r.bucket === "missing-function"),
  unanalyzable: results.filter((r) => r.bucket === "unanalyzable"),
  byFile,
};
fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

const line = (label) => `\n${"═".repeat(70)}\n${label}\n${"═".repeat(70)}`;

console.log(line("静态 SQL 编译探针 · 汇总"));
console.log(`扫描文件      : ${files.length} 个 .ts`);
console.log(`SQL 模板总数  : ${results.length}`);
console.log(`  编译通过    : ${buckets.ok}`);
console.log(`  语法错误    : ${buckets.syntax}      ← 本次目标`);
console.log(
  `  schema 缺失 : ${buckets["schema-missing"]}  (no such table/column，不计入失败)`,
);
console.log(
  `  缺函数      : ${buckets["missing-function"]}  (no such function，PG 函数残留，不计入语法失败)`,
);
console.log(`  无法静态分析: ${buckets.unanalyzable}  (模板插值吃掉子句)`);
console.log(`  空语句      : ${buckets.empty}`);
console.log(`\n残留 token 命中 SQL 条数: ${residualRows.length}`);
for (const [token, count] of Object.entries(residualCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${token.padEnd(18)} ${count}`);
}
console.log(`\n机读报告: ${path.relative(process.cwd(), REPORT_PATH)}`);

function printGroup(title, rows, render) {
  if (rows.length === 0) return;
  console.log(line(title));
  const grouped = {};
  for (const r of rows) (grouped[r.file] ??= []).push(r);
  for (const file of Object.keys(grouped).sort()) {
    console.log(`\n▌ ${file}`);
    for (const r of grouped[file]) console.log(`  L${r.line}  ${render(r)}`);
  }
}

printGroup(
  `语法错误 (${buckets.syntax}) —— 按文件聚合`,
  results.filter((r) => r.bucket === "syntax"),
  (r) => `${r.message}\n           SQL: ${r.statement ?? ""}`,
);

printGroup(
  `缺函数 (${buckets["missing-function"]}) —— 按文件聚合`,
  results.filter((r) => r.bucket === "missing-function"),
  (r) => `${r.message}\n           SQL: ${r.statement ?? ""}`,
);

printGroup(
  `schema 缺失 (${buckets["schema-missing"]}) —— 按文件聚合`,
  results.filter((r) => r.bucket === "schema-missing"),
  (r) => `${r.message}`,
);

printGroup(
  `无法静态分析 (${buckets.unanalyzable}) —— 按文件聚合`,
  results.filter((r) => r.bucket === "unanalyzable"),
  (r) => `${r.message}`,
);

printGroup(
  `残留 PG token (${residualRows.length} 条 SQL) —— 按文件聚合`,
  residualRows,
  (r) => r.residuals.map((h) => `${h.token}×${h.count}`).join(", "),
);

console.log(
  `\n完成。语法错误 ${buckets.syntax} 条，残留 token ${Object.values(residualCounts).reduce((a, b) => a + b, 0)} 处。`,
);
