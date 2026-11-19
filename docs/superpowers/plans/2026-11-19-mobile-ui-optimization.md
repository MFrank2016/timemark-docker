# 移动端 UI 优化 · 实施计划

**Goal:** 在 390px 移动端修好首页顶栏溢出、页面顶部遮挡、倒计时卡片厚重三个问题，并完成全局间距/对比度体检，桌面端（≥768px）零视觉回归。

**Tech Stack:** React 19 + TS + Vite 8、Tailwind v4 CSS-first、lucide-react、framer-motion；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-19-mobile-ui-optimization-design.md`

## Global Constraints

- 断点统一用 `md`（768px）；所有 `md:` 之后的值 = 现状，桌面端零变化。
- dark 变体必须成对；图标仅 lucide-react；不装新依赖。
- `EventCard.test.tsx:35-54` 三条测试必须保持绿：菜单面板用 `{open && ...}` 条件渲染，触发器 `aria-label="更多操作"` 不得含编辑/删除/测试字样。
- 不提交（no git commit）；不改后端与业务逻辑；不改 `MobileBottomNav` / 各页 `pb-*` / `max-w-*` / safe-area。

## 任务分工（三条并行 lane，写入范围互不重叠）

### Task 1 — 共享菜单 + 倒计时卡片（Lane A）

**Files:** 新增 `src/components/ui/action-menu.tsx`；修改 `src/components/events/EventCard.tsx`；测试 `src/components/events/EventCard.test.tsx`（如需补 1 条）。

- 实现 `ActionMenu`，API：`{ items: {label:string; icon:LucideIcon; onSelect:()=>void; danger?:boolean; dividerBefore?:boolean}[]; triggerLabel:string; icon?:LucideIcon; align?:'start'|'end'; className?:string; panelClassName?:string }`。触发器 ghost icon Button；`className` 挂根节点。行为：外部 `pointerdown`、Escape、选中即关（`setOpen(false)` 强制）、Tab 离开即关、关闭焦点回触发器；键盘 ArrowUp/Down/Home/End/Enter；aria-haspopup=menu + aria-expanded + aria-controls + role=menu/menuitem + role=separator 分隔线。
- `EventCard`：按设计文档 §C 压缩移动端 class；根去掉 `overflow-hidden`，光斑包进 `absolute inset-0 overflow-hidden` 层；操作行 `hidden md:flex`；头部右侧追加三点 `ActionMenu`（`md:hidden`，`align="end"`，items=测试/复制日期/编辑/删除，删除 danger）；根节点打开时 `z-20`；`selectable` 时不渲染菜单；触发器与条目 `onClick` 加 `e.stopPropagation()`。
- 验收：`EventCard.test.tsx` 全绿；面板关闭态不渲染；菜单不被 overflow-hidden 裁剪；桌面 class 值不变。

### Task 2 — 首页顶栏 + FAB（Lane B）

**Files:** 修改 `src/pages/Dashboard.tsx`（仅 215-273 顶栏、289 main、429/444 网格、454 FAB）；`src/components/ProfileSwitcher.tsx`。

- 按设计文档 §A：顶栏移动端只留 Logo / ProfileSwitcher / 收件箱（未读徽标不动）/ ActionMenu；其余进 `className="md:hidden"` 的菜单（3 组，导入用隐藏 `<input ref>` + 菜单项 click 触发）；顶栏 `z-40`、`top-2 md:top-4`、panel `px-2 sm:px-6 py-2 md:py-3`；用户名/分隔线 `hidden md:block`。
- `ProfileSwitcher` 加可选 `className`（`cn` 拼接）与 `min-h-11`；Dashboard 传 `max-w-[7rem] md:max-w-[9rem]`。
- FAB `bottom-36 right-4 md:bottom-10 md:right-10`；main `px-6`→`px-4 md:px-6`、删 `mt-4`；卡片网格 `gap-4 md:gap-6`。
- 验收：390px `scrollWidth === clientWidth`；ProfileSwitcher 在 390 可见可操作；FAB 与底栏/AssistantDock 不重叠（量测）；菜单项打开 Dialog 前先关闭（本菜单暂无此类项）。

### Task 3 — 全局间距与体检（Lane C）

**Files:** `src/components/layout/PageHeader.tsx`、`src/index.css`、`src/components/ui/dialog.tsx`、约 15 个页面的 main/根容器/文字 class（含 `AnnualReport.tsx`、`CronMonitor.tsx`）。

- **不碰** `Dashboard.tsx` 与 `EventCard.tsx`（属 Lane A/B）。
- 按设计文档 §B：`PageHeader` 改 `sticky top-2 md:top-6 z-40 px-4 mb-4 md:mb-6`；`index.css` 的 `@layer base` 加 `html { scroll-padding-top: 6.5rem; }`；清理各页 main 自凑 `mt-*` 与顶部 `py-*`（保留 `pb-*`）；删 `CronMonitor` 的 `mb-6` 与 `AnnualReport`/`CronMonitor` 的 `-mx-4` 并把根 `p-6` 改 `px-4 py-6 md:px-6`。
- 按 §E 建议修：S1 11 页 main 补 `id="main-content" tabIndex={-1}`；S2/S3 低对比文字改 `dark:text-slate-400` 或 `.text-hint`；S4 导入 label 触控目标 44px（注：Dashboard 的 label 已被 Lane B 改为菜单项，若已不存在则跳过）；S5 Dialog 移动端 `w-[calc(100%-1.5rem)] max-w-lg p-5 sm:w-full sm:p-8`；S6/S7 同上。
- 验收：26 个 PageHeader 页面首屏间距统一；深链落点不被 pill 盖；无 `mb-6` 冲突；SkipLink 有目标；无双缩进。

## 验证范围（不扩大）

- `cd frontend && npm run build`（含 typecheck）
- `npx vitest run src/components/events/EventCard.test.tsx`
- `npx playwright test e2e/a11y.spec.ts`（/dashboard 两视口）
- Playwright 390×844 打开 /dashboard 截图 + 横向溢出/菜单裁切/FAB 位置量测

## 风险

- 三 lane 并行写，最后需统一 `npm run build` 才能发现跨文件类型/接口不一致。
- 设计师的数值（bottom-36、gap-4、scroll-padding 6.5rem）为 390×844 推算，需实测微调。
