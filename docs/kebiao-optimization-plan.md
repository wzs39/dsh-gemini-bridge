# LUT Timetable 优化方案

## 现状诊断

| 指标 | 当前值 | 问题等级 |
|---|---|---|
| 主 JS chunk | **848 KB** (gzip 242 KB) | 🔴 Vite 警告 >500 KB |
| CSS | 67 KB (gzip 14 KB) | ✅ 合理 |
| 代码分割 | 仅 `backgroundSync` 1 个动态导入 | 🔴 几乎为零 |
| `React.memo` | **全项目 0 处** | 🔴 所有子组件无条件重渲染 |
| AppInner | **~870 行 / ~40 个 useState** | 🔴 God Component |
| MoodleProvider context | **24+ 字段单一 context** | 🟡 任一字段变化触发所有消费者重渲 |
| `useNow` 30 秒级联 | TodayView 每 30 秒 7 条 memo 链重算 | 🟡 |
| 静态数据文件 | `sisuCourseFacts.ts` **4630 行** | 🔴 打包进主 chunk |
| 源文件 | 319 个 (.ts 209 + .tsx 110) | — |

---

## 优化项（按影响排序）

### 🔴 P0 — 代码分割（预计主 chunk 减 40-50%）

**问题**: 15+ 页面组件全部静态 import，用户首屏只看一个视图，却加载了所有视图的代码。`sisuCourseFacts.ts`（4630 行静态数据）也打进主 chunk。

**方案**:
1. **路由级懒加载** — 用 `React.lazy` + `Suspense` 拆分非首屏视图:
   - `SisuStudyPlan` (48 KB source) → lazy
   - `WeekGrid` (34 KB) → lazy
   - `Settings` → lazy
   - `MoodleView` → lazy
   - `ConflictCheck` / `BatchFilter` / `DuplicateResolver` → lazy
   - `PrintWeek` → lazy
2. **`sisuCourseFacts.ts` 异步加载** — 4630 行静态数据改为 JSON 文件 + `import()`:
   ```ts
   // 之前: import { COURSE_FACTS } from './sisuCourseFacts'
   // 之后: const facts = await import('./sisuCourseFacts.json')
   ```
3. **Vite `manualChunks`** — 把 Capacitor 插件、Electron 桥接分到独立 chunk（按平台条件加载）

### 🔴 P1 — React.memo 关键路径（减少 60-80% 无效重渲染）

**问题**: 全项目 0 个 `React.memo`。AppInner 有 ~40 个 `useState`，任何一个变化（undo timer、update check、侧栏宽度拖拽）都导致整棵组件树重渲染。

**方案**:
1. **高频重渲染组件加 `React.memo`**:
   - `TodayView` — 接收稳定 props，memo 后可跳过大量重渲染
   - `WeekGrid` — 同上
   - `LessonDetail` — 模态框，仅在打开/数据变化时需渲染
   - `Sidebar` — 除 active view 外很少变化
   - `BottomNav` — 仅 view/unread 变化时需更新
   - `AppHeader` — 仅标题/同步状态变化时需更新
2. **稳定化 inline 回调**: App.tsx 中多处 inline arrow function 作为 props（L699, L743-746, L770-779），改为 `useCallback`
3. **`useTimetable` 返回值 memo 化**: 当前返回 plain object，每次调用都是新引用

### 🟡 P2 — MoodleProvider 拆分（减少跨域重渲染）

**问题**: 24+ 字段的单一 context，grades 变化导致 notifications 消费者也重渲染。

**方案**:
将 `MoodleProvider` 拆为 3 个独立 context:
- **MoodleConnectionCtx** — `ics, token, connected, setIcsUrl, disconnectIcs, connectToken, disconnectToken, loginWithSso, ssoAvailable, ssoState, ssoMessage`（低频变化）
- **MoodleDataCtx** — `grades, subStatus, subByCmid, activityDeadlinesByCmid, activityDatesByCmid, moduleKindByCmid, notifications, unread`（同步时变化）
- **MoodleSyncCtx** — `busy, message, syncNow, refreshGrades, syncSubmissions, applyCompletion, pushTaskCompletion, registerContentsDates, markNotificationRead, refreshNotifications, refreshFromNotification`（操作回调）

> [!NOTE]
> 拆分后每个消费者只订阅需要的 context，减少无关重渲染。回调类 context 因 `useCallback` 引用稳定，几乎不触发重渲染。

### 🟡 P3 — AppInner 拆分（可维护性 + 渲染隔离）

**问题**: AppInner 870 行 / 40 个 useState，是 God Component。

**方案**:
1. 提取 **`useAppNavigation`** hook — view/weekStart/weekNav/assignFilter/lessonQueue 等导航状态（~15 个 useState）
2. 提取 **`useAppOverlays`** hook — 已有 `useOverlays` 但 AppInner 还有大量 overlay 状态
3. 提取 **`useAppSync`** hook — updateState/syncSource/subscriptions 等同步相关状态
4. 将模态框渲染（LessonDetail/BatchFilter/ConflictCheck/Settings 等）提取为 **`<AppModals>`** 子组件
5. 将底部导航/header 提取为独立子组件（已有但 props 不稳定）

### 🟡 P4 — useNow 30 秒级联优化

**问题**: TodayView 每 30 秒因 `useNow()` 触发 7 条 memo 链（过滤/排序全部课程）。

**方案**:
1. **粗粒度时间戳** — `useNow` 返回值量化到分钟级（`Math.floor(now / 60000) * 60000`），30 秒内的两次 tick 不产生新引用
2. **派生数据分层 memo** — 课程列表 → 今日课程（依赖 lessons 和 date，不依赖 now）→ 当前状态标注（依赖 now）。把不依赖 now 的筛选移到外层 memo
3. **考虑 `useSyncExternalStore`** — 所有 `useNow` 消费者共享同一个 snapshot，避免每个组件独立 re-render

### 🟢 P5 — 算法热路径

| 热路径 | 复杂度 | 优化 |
|---|---|---|
| `courseCodeOf` in AssignmentsView render | O(tasks × lessons) | memo 化结果 Map，仅 tasks/lessons 变化时重算 |
| `fetchActivityUrls` sequential HTTP | O(n) 串行请求 | 改 `Promise.all` 并发（受 Moodle 限流则加 pLimit(5)） |
| `loadIdentityIndex()` in merge loops | 每次读 localStorage | 在循环外调用一次，传入引用 |

### 🟢 P6 — 构建配置

1. **Vite `rolldownOptions.output.codeSplitting`** — 启用自动分割
2. **`build.target: 'es2022'`** — 减少 polyfill（React 19 已要求现代浏览器）
3. **CSS `@layer` 清理** — 检查 Tailwind v4 是否有死 CSS 类

---

## 执行优先级建议

| 阶段 | 内容 | 预计收益 | 工时 |
|---|---|---|---|
| **Phase 1** | P0 代码分割 + P6 构建配置 | 主 chunk 848→~450 KB | 2-3h |
| **Phase 2** | P1 React.memo 关键路径 | 减少 60%+ 无效渲染 | 2-3h |
| **Phase 3** | P3 AppInner 拆分 + P5 算法 | 可维护性 + 热路径 | 3-4h |
| **Phase 4** | P2 Context 拆分 + P4 useNow | 精细化渲染控制 | 2-3h |

> [!IMPORTANT]
> 每个 Phase 结束后都要跑 `npm run gate` 确保不回归。Phase 1 完成后需要装机验证（`npm run build && npx cap copy android`）。
