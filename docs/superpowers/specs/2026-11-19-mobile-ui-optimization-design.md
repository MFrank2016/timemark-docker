# 移动端 UI 优化 · 设计文档

日期：2026-11-19
状态：待批准

## 意图与原因

服务已部署在 103 服务器（https://timemark.889618.xyz/dashboard），移动端存在三类明确问题：首页顶栏 10 个按钮在 390px 下被裁切；其它页面内容被 sticky 顶栏遮挡、各页顶部间距不一致；倒计时卡片过于厚重、操作按钮常驻占空间。目标是移动端可用、桌面端零视觉回归，并顺手统一全局间距与对比度。

## 目标 / 非目标 / 反目标

- 目标：①首页顶栏移动端不溢出 ②其它页面不被顶栏遮挡且间距统一 ③倒计时卡片移动端紧凑横幅化、操作收进三点菜单 ④全局体检（间距、对比度、触控目标、可达性）。
- 非目标：不做 safe-area 适配、不统一各页 max-width、不改底部导航与 pb-* 留白、不改批量选择模式。
- 反目标：任何桌面端（≥768px）可见的视觉变化；引入新依赖；扩大到后端或业务逻辑。

## 约束

- React 19 + TS + Vite 8；Tailwind v4 CSS-first（配置在 `src/index.css`，无 tailwind.config.js）；dark 变体必须成对；图标仅 lucide-react；无 dropdown 组件、不装新依赖。
- Axe 门禁：`/dashboard` 在 390×844 与 1440×900 零 critical；移动端基线 390×844。
- `EventCard.test.tsx:35-54` 依赖 `getByRole('button', {name:/编辑|删除|测试/})`；`e2e/profile-switcher.spec.ts`、`e2e/a11y.spec.ts` 依赖相关文案与可达性。
- z-index 分层：Dialog/CommandPalette z-50 > PageHeader/底栏抽屉 z-40 > 底栏 z-30。

## 方案取舍

1. **最小修补**（只改 3 处、不抽公共组件）：改动最少，但两处菜单的 dismiss/焦点/aria 逻辑要写两遍，且无法统一全局间距。否。
2. **Radix dropdown 方案**：语义最稳，但要新增依赖，违反约束。否。
3. **共享 ActionMenu + 全局收口**（采纳）：新增一个约 90 行的 `src/components/ui/action-menu.tsx` 承载 dismiss/焦点/aria，两处调用复用；PageHeader 一处改动覆盖 26 页；EventCard 移动端压缩、桌面端不动。改动集中、风险可控。

## 已定设计

### A. 首页顶栏（Dashboard.tsx:215-273）

移动端只保留 Logo、ProfileSwitcher、收件箱（带未读徽标）、更多（⋯）；其余 9 个快捷操作 + 退出进「更多」浮层菜单。断点用 `md`：桌面端保持现状。顶栏 `z-50` 降 `z-40`（让 Dialog 严格在上），`top-4` → `top-2 md:top-4`；panel `px-2 sm:px-6 py-2 md:py-3`；用户名/分隔线 `hidden sm:block` → `hidden md:block`。ProfileSwitcher 加可选 `className`，Dashboard 传 `max-w-[7rem] md:max-w-[9rem]` 并加 `min-h-11`。导入 ICS 由 `<label>` 改为隐藏 `<input ref>` + 菜单项 button 触发 `click()`；导出走原 `handleExportCalendar('ics')`。

### B. 全局顶部间距

根因不是 sticky 静态遮挡，而是悬浮缝过大、pill 与首卡无间距、深链滚动落点被盖。修法：`PageHeader.tsx:51` 改 `sticky top-2 md:top-6 z-40 px-4 mb-4 md:mb-6`；`index.css` 的 `@layer base` 加 `html { scroll-padding-top: 6.5rem; }`；机械清理各页 main 自凑的 `mt-*` 与顶部 `py-*`（保留 `pb-*`），Dashboard `main` 的 `px-6` → `px-4 md:px-6`。删除 `CronMonitor` 的 `mb-6`（与新默认冲突）。不引 safe-area（需同时改 4 处，非本次痛点）。

### C. EventCard 移动端横幅（EventCard.tsx）

断点 `md`：所有 `md:` 之后的值等于现状，桌面端零变化。根 `rounded-3xl p-4` / `md:rounded-[2.5rem] md:p-6`；去掉根 `overflow-hidden`，装饰光斑包进 `absolute inset-0 overflow-hidden` 层以免裁掉菜单；标题 `text-base md:text-xl`；4 宫格保留，`py-1.5 text-lg md:py-3 md:text-2xl`，gap-2 → `gap-1.5 md:gap-2`；提醒行 `text-[11px] mb-1.5 md:text-xs md:mb-4`，「提前 N 天」与「提醒时间」移动端 `hidden sm:*`；操作行整行 `hidden md:flex`，头部右侧追加三点触发器 `md:hidden`。根节点打开菜单时加 `z-20` 防兄弟卡片压盖。

测试保持绿的前提：菜单面板 `{open && ...}` 条件渲染（不用 hidden 类），触发器 `aria-label="更多操作"` 不含编辑/删除/测试字样。

### D. ActionMenu 共享组件（新增 1 文件）

`src/components/ui/action-menu.tsx`，约 90 行。API：`items: {label, icon, onSelect, danger?, dividerBefore?}[]`、`triggerLabel`、`icon?`、`align?`、`className?`。自渲染触发器（ghost icon Button）、面板（glass-panel）、分隔线（role=separator）。行为：外部 `pointerdown` / Escape / 选中即关 / Tab 离开即关 / 关闭焦点回触发器；键盘 ArrowUp/Down/Home/End + Enter 选中；aria-haspopup=menu / aria-expanded / aria-controls / role=menu+menuitem。`className` 挂根节点以便 `md:hidden` 同时隐藏触发器与面板。选任一项强制 `setOpen(false)`。

### E. 全局体检（分级）

必修：M1 首页顶栏溢出、M2 卡片操作行溢出、M3 卡片 overflow-hidden 裁菜单、M4 顶栏 z、M5 FAB `bottom-36 right-4 md:bottom-10 md:right-10`（避开底栏与 AssistantDock）、M6 AnnualReport/CronMonitor 双缩进、M7 PageHeader 间距、M8 scroll-padding。
建议修：S1 11 页 main 补 `id="main-content" tabIndex={-1}`、S2/S3 低对比灰字改 `dark:text-slate-400` 或 `.text-hint`、S4 导入 label 触控目标 44px、S5 Dialog 移动端 `w-[calc(100%-1.5rem)] max-w-lg p-5 sm:w-full sm:p-8`、S6 卡片网格 `gap-4 md:gap-6`、S7 AnnualReport/CronMonitor 侧距统一。
不做：safe-area、新依赖、MobileBottomNav 抽屉、砍 4 宫格、统一 max-width、改 pb-*、锁 body 滚动、改 ThemeToggle 动画、动 selectable 模式。

## 留给实现者的部分

- 按 A–E 实施，允许在不改变设计意图的前提下自行处理 JSX 结构细节。
- 验证范围（仅这些，不扩大）：`npm run build`/typecheck、`EventCard.test.tsx`、`e2e/a11y.spec.ts` 的 /dashboard 两视口、Playwright 390×844 截图与横向溢出断言（scrollWidth===clientWidth）、菜单裁切与 FAB 位置量测。
- 报告实际改动文件、跳过的项、以及任何偏离本设计的地方。

## 关键文件

- `frontend/src/pages/Dashboard.tsx`（首页顶栏、FAB、main、卡片网格）
- `frontend/src/components/layout/PageHeader.tsx`
- `frontend/src/components/events/EventCard.tsx`
- `frontend/src/components/ProfileSwitcher.tsx`
- `frontend/src/index.css`
- `frontend/src/components/ui/dialog.tsx`
- 新增 `frontend/src/components/ui/action-menu.tsx`
- 约 15 个页面的 main padding/mt-*/id 机械清理
