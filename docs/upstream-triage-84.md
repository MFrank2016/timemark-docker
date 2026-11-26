# 上游 timemark-vercel 提交分诊清单（v2.30 发布点之后 84 个提交）

> 生成日期：2026-11-26
> 范围：`f6ce04e`(v2.30 发布)..`17c0b4d`(上游最新 master)
> 本仓库 HEAD：`bc66c86`（Docker 单容器 SQLite fork）
> 共同祖先 `0b1c32e`(v2.6.0)；试合并 188 冲突已 abort，工作区干净，保留 `vercel/master` ref 与 `merge-vercel-trial` 分支。

## 结论（oracle 复核）

**不存在真正的 git rebase**：两条线在 v2.6.0 后各自独立，本仓库的 v2.30 是「树换装 + 增量层重放」（见 `docs/PORT-LEDGER-v2.30.md`），git 层面无 merge 关系。整包变基 = 重做 49 提交 + 52 重叠文件 + 重跑 A–H 门禁（数周级）。推荐**按模块挑功能移植**，只搬「纯前端/展示 + 后端端点已在 v2.30 树内」的增量；凡涉及 db/migrate/调度/依赖/运维/平台，默认跳过。

分类判据：**能力是否依赖 Vercel/Neon/平台 cron，或是否触碰 Docker 本地防御与 SQLite 语义**。

- **跳过（平台专属/有害）**：15 条 —— Neon pg_dump、备份监控 workflow、MONITOR_PAT、Vercel cron token、quota 门控（Docker 常驻进程无按次计费，门控反致漏提醒）、vercel.json、push-via-api、CI workflows、依赖大升级及其 build 修复。
- **跳过（自评台账/纯文档）**：约 25 条 —— `docs/iteration` scorecard/campaign ledger。
- **值得搬（低风险）**：约 30 条 —— toast、ConfirmDialog、undo、heatmap、性能优化、OpenAPI 3.1、weekly review、数据源/备份页、decision-card、家庭清单、照护/车辆/工时/宠物/观察列表等页面 UI。
- **需逐项判断**：约 10 条 —— 触及 52 个重叠文件、与 Docker 移动端 UI 改动冲突的页面（如 PageHeader、Dashboard、Settings、Ask）。

## 明细清单

### A. 跳过 — 平台运维/有害（15）

| SHA     | 日期  | 主题                                 | 触及     | 理由                                                                                                                |
| ------- | ----- | ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 17c0b4d | 11-21 | ops: 永久 backups 分支               | OPS      | Vercel 备份策略，Docker 无此机制                                                                                    |
| 0b06aed | 11-21 | fix(ops): monitor dispatch gh api    | OPS      | 备份监控                                                                                                            |
| 011f37e | 11-21 | fix(ops): monitor dispatch API       | OPS      | 备份监控                                                                                                            |
| aefd65d | 11-20 | fix(ops): MONITOR_PAT 防呆           | OPS      | 平台 PAT                                                                                                            |
| a6441c9 | 11-20 | ops: 每日备份监控 workflow           | OPS      | 六仓库监控                                                                                                          |
| 69e04d7 | 11-20 | ops: Neon pg_dump 备份               | OPS      | Neon 专属，Docker 用 SQLite                                                                                         |
| 5fae5f7 | 11-20 | fix(cron): Vercel 内置 cron token    | BE1      | Vercel cron 专属                                                                                                    |
| 0f3407e | 11-19 | chore(deploy): 触发生产部署          | -        | 平台部署                                                                                                            |
| 49e9749 | 11-18 | feat(quota): /api/cron/tick 统一端点 | BE1      | 按次计费门控，Docker 有害（漏提醒）                                                                                 |
| 6efd9a3 | 11-18 | perf(quota): lunar/warmup/drain 门控 | BE2      | 同上                                                                                                                |
| c65fc4d | 11-18 | test(quota): agent-worker 门控测试   | BE1      | 同上                                                                                                                |
| 334cc32 | 10-06 | fix(scripts): push-via-api           | OPS      | 平台脚本                                                                                                            |
| 3efb4f2 | 10-31 | chore(deps): 依赖大升级              | FE6 DOC1 | lucide 0.344→1.66、date-fns 3→4、tailwind-merge 2→3、RHF 7.50→7.91、radix 1.0→1.3，主版本穿透，除非整包承接否则跳过 |
| 9822c07 | 10-24 | fix(build): lucide CloudUpload       | FE1      | 依赖升级的 build 修复                                                                                               |
| 4a53b45 | 10-24 | fix(build): search-index budget      | -        | 依赖升级的 build 修复                                                                                               |

### B. 跳过 — 纯文档/自评台账（约 25）

| SHA                                                                                             | 主题                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| b7a09b4 27967fe 8d2d389 f4d2807                                                                 | v2.38 campaign 计划/评审                                |
| 4a8ccdb c59442a ccd5ff6 6efb922 42a7fdf 8333788 d691f97 5ae6d5c 0a92ed8 92b3585 2e30a0f 3a4dd6d | v2.31–v2.37 scorecard/UI 自评                           |
| 275ffa9                                                                                         | docs(ledger): post-release additions                    |
| 1c7b3a4                                                                                         | chore: remove stray smoke script                        |
| aef6014                                                                                         | fix(test): webauthn json typing（测试类型修复，非功能） |
| 147abeb 15d3296 915bf47                                                                         | test: 各路由测试（上游新增测试，Docker 测试体系独立）   |

### C. 值得搬 — 低风险功能/修复

| SHA     | 日期  | 主题                                       | 触及         | 前置条件                                                    |
| ------- | ----- | ------------------------------------------ | ------------ | ----------------------------------------------------------- |
| 49b0363 | 10-31 | feat(toast): 零依赖 toast 替换 96 处 alert | FE17         | 纯前端；需核对与 Docker 移动端布局冲突                      |
| fad35ee | 10-31 | feat(ux): ConfirmDialog 替换 36 处 confirm | FE24         | 纯前端；覆盖大量页面，需分批                                |
| d7cae75 | 10-31 | feat(undo): toast 撤销删除                 | FE15         | 依赖 49b0363                                                |
| ad6c662 | 10-31 | feat(undo+heatmap): 撤销扩展 + 52周热力图  | FE4          | 依赖上一条                                                  |
| 74fd8c1 | 10-31 | perf(loading): optimistic auth/预取/去重   | FE5 BE1      | 触碰 auth.store（重叠文件），需细核                         |
| 0c3fec2 | 10-31 | perf(bundle): charts 分包/缓存头           | FE2 OPS1     | 部分平台，取前端部分                                        |
| 19125f7 | 10-31 | feat(review): weekly review markdown 导出  | FE1          | 依赖 weekly review 页                                       |
| 4f9c5d6 | 10-31 | fix(a11y+stability): 移动端页头标题宽度    | FE3          | **可能已被 Docker 移动端优化覆盖，需核对**                  |
| 3c8887e | 10-31 | feat(habits+ocr): 习惯热力图/批量 OCR      | FE3 BE2      | 后端端点是否已在 v2.30 树内需核                             |
| ffed5f7 | 10-31 | feat(review): weekly review 页             | FE6          | 纯前端                                                      |
| c666508 | 10-31 | feat(ocr+analytics): 文档类型推断/生活概览 | FE5          | 后端端点需核                                                |
| 04d34a4 | 10-31 | feat(api): OpenAPI 3.1 spec                | FE1 BE3      | 公开路由，低风险                                            |
| b8416b8 | 10-31 | feat(backup): 本地恢复 UI                  | FE1          | 纯前端（Docker 本地盘=合法生产形态）                        |
| 137eb35 | 10-31 | feat(ocr): 扫描 OCR 页                     | FE11         | 依赖 OCR 端点                                               |
| 4fdbee1 | 10-26 | fix(assistant): dock panel resize          | FE2          | 纯前端                                                      |
| 5347805 | 10-26 | fix(ai-ui): 自然语言输出/dock 滚动         | FE17         | 纯前端                                                      |
| 388ecca | 10-24 | feat: 多级提醒/ical 订阅/分享卡 PNG        | FE3          | 后端端点需核                                                |
| e514dcc | 10-24 | feat: 数据源与备份页                       | FE5          | 纯前端                                                      |
| c5fd940 | 10-24 | feat: decision-card 审批面板               | FE2          | 纯前端                                                      |
| f2986f2 | 10-24 | feat: 家庭清单页                           | FE5          | 纯前端                                                      |
| 1e18271 | 10-24 | feat: collaboration 页 + 4 agent 工具      | FE5 BE3 SH1  | 后端端点需核                                                |
| 5455242 | 10-12 | fix: retrieval-fallback 三类路径           | FE1          | 纯前端                                                      |
| 9fc4fd3 | 10-11 | fix: dock 高度链                           | FE4          | 纯前端                                                      |
| 8d6e15c | 10-11 | feat: assistant 自然语言回答               | FE3          | 纯前端                                                      |
| 6ded4d8 | 10-11 | fix: dashboard FAB 重叠                    | FE2          | **Docker 已修 FAB 重叠，跳过**                              |
| a14a27e | 10-11 | fix: UI 层级/assistant 意图                | FE3          | 纯前端                                                      |
| 20e7f1e | 10-11 | fix: dock scroll/overflow                  | FE3          | 纯前端                                                      |
| a4ce815 | 10-11 | feat: 周/日重复扩展                        | FE3          | 纯前端                                                      |
| a54d5ce | 10-11 | feat: 宠物日志 UI                          | FE1          | 纯前端                                                      |
| cfef8c2 | 10-11 | feat: 工时 leaves                          | FE1          | 纯前端                                                      |
| ef2cff1 | 10-11 | feat: 观察列表编辑抽屉                     | FE2          | 纯前端                                                      |
| c27a24b | 10-11 | feat: palette a11y/车辆能源                | FE3          | 纯前端                                                      |
| c3469da | 10-11 | fix: timesheet 审计                        | FE2          | 纯前端                                                      |
| 3e79f3a | 10-11 | feat: 照护页                               | FE5          | 纯前端                                                      |
| c4907ca | 10-24 | feat: 全局搜索覆盖/watchlist/vehicle       | FE2 BE12     | 后端端点需核                                                |
| 78513e6 | 10-11 | feat: 车辆/工时审计修复                    | FE2          | 纯前端                                                      |
| 59fb805 | 10-11 | feat: 宠物页/观察列表                      | FE7          | 纯前端                                                      |
| 9deaf7f | 10-11 | feat: 工时页打卡                           | FE5          | 纯前端                                                      |
| a649d8e | 10-11 | feat: 车辆页                               | FE5          | 纯前端                                                      |
| a63dfaf | 10-11 | feat: dedupe card/观察列表页               | FE8          | 纯前端                                                      |
| 1809833 | 10-11 | fix: calendar 按 occurrence 定位           | FE4          | 纯前端                                                      |
| 3688878 | 10-11 | feat: quality/testing 轮次                 | FE1 SH2      | 需核                                                        |
| 6d058ce | 10-11 | feat: 产品完整性/全局搜索                  | FE7 BE1      | 后端端点需核                                                |
| e300cd4 | 10-11 | fix: 安全加固 + 文档准确性                 | FE1 BE6 DOC4 | **安全类，需逐 hunk 核对是否被 Docker 防线覆盖**            |
| 09d0e9c | 10-06 | feat: 页面级错误边界                       | FE3          | add/add 冲突（Docker 有同名 PageErrorBoundary），需人工合并 |
| de8dd82 | 10-06 | polish: ICS 导入行内横幅                   | FE2          | **Docker 已实现同款，跳过**                                 |
| ea84251 | 10-06 | polish: 复制反馈/a11y 标签                 | FE2          | 纯前端                                                      |

## 待你授权

1. 是否按「C 类为主、跳过 A/B、D 类逐项核对」执行？
2. C 类里标注「后端端点需核」的提交，是否先做只读核对（确认端点已在 v2.30 树内）再决定？
3. 全部移植在独立分支进行、不部署、不动 master —— 是否确认？
