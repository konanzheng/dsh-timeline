# dsh-timeline (dsh-history)

> 把 DeepSeek Harness 会话轨迹渲染成一条 **S 形能量轨迹时间轴** —— 从流水账变成看得见的思路。

一个 DSH 客户端插件：读取当前会话的历史事件，把每一轮交互（`turn`）组织成卡片，用一条**蓝→紫→粉渐变的能量连线**按 S 形串起来；并从工具调用中**归纳过程洞察**（定位/读写/验证/报错模式），让用户一眼看到 AI 是如何一步步解决问题的。

![dark theme](https://img.shields.io/badge/theme-dark-blueviolet)

## 功能

### 🎯 轨迹可视化
- **S 形时间轴**：轮次卡片按 boustrophedon（犁田式）排列，SVG 平滑贝塞尔曲线按序穿过每张卡片的中心点，卡片与连线严格贴合
- **深色能量主题**：渐变能量流主线 + 辉光层 + 沿路径流动的光脉冲 + 每张卡片中心的固定能量节点
- **Ctrl/Cmd + 滚轮缩放画布**（0.4× – 2.5×），光标锚定缩放，连线始终对齐卡片中心

### 🧠 过程洞察（不只是换皮展示）
卡片与详情窗口会把原始工具调用**加工成结论**：

| 模式 | 归纳输出 |
|---|---|
| grep/glob 多次 | `通过「timeline.ts、timeline.css」等 3 次搜索定位关键代码` |
| read/write 多次 | `通过超多次读写文件（读 21 次、改 17 次）最终实现正确逻辑`（超多次/多次/少量分级） |
| bash 多次 | `通过 7 次命令执行验证运行效果` |
| 存在报错 | `过程中出现 2 次报错，经调试修复后通过` |

- **意图标签**：每张卡片一句话说明「这轮 AI 在做什么」（取自用户诉求 + 工具行为 + 里程碑标记：`⚠ 首次报错` / `🔧 修复` / `⚡ 重点动作`）
- **逻辑链**：每轮的工具调用按因果串成链 —— `读 → 改 → 验`、`搜 → 读 → 改`、`报错 → 修复`，箭头区分关系
- **洞察条**：时间轴顶部聚合全轨迹的统计 —— 轮次数 / 工具调用数 / 文件数 / 失败数，以及**高频文件 Top3**（热度条）与工具类型分布

### 📋 交互
- **点击卡片头部** → 弹出**详情窗口**（定位在点击位置附近，空间不足自动翻转）：完整用户对话 → 过程归纳 → 逻辑链（N 步因果流）→ 最终总结回复 → 按文件分组的操作明细
- **默认进入轨迹视图自动打开**时间轴，切回对话视图自动关闭
- 卡片头部点击打开详情，卡片本身保持紧凑（不再就地展开）；工具列表移入详情，卡片只留摘要
- 详情窗口 `ESC` 关闭；再按一次 `ESC` 关闭整个时间轴
- 卡片回复展示**该轮最终总结**（只取 `text` 块，丢弃 `reasoning` 思考块，且只保留最后一条 assistant 消息）

### 🔌 入口
- 时间轴入口按钮位于**轨迹视图工具栏、搜索框左侧**；对话视图不显示

## 安装

### 前提
- 本地有 DSH 开发环境（插件按 cordis 插件包方式装配）

### 方式一：热装配（开发期）
```bash
# 在插件根目录构建
~/.bun/bin/node scripts/build-client.mjs   # 产出 lib/index.js + lib/client.js
~/.bun/bin/node node_modules/typescript/bin/tsc --noEmit   # 类型检查

# 用 DSH 插件工具热装配（例如 dev_install_package / dev_inject_plugin）
```

### 方式二：patch 装配（`cordis.patch.yml` 已内置）
`cordis.patch.yml` 以 `insert` 注册 `{ id: dsh-history, name: dsh-history }`，随 DSH profile 装配时自动加载 client bundle。

### 需要注入的依赖
`package.json` 的 `dsh.client.inject` 声明了三个运行时模块（由宿主提供）：

| 模块 | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-runtime` | `ctx.sessions.list.current` 取当前会话 |
| `@deepseek-ai/dsh-client-ui-slots` | UI 扩展（如有） |
| `@deepseek-ai/dsh-client-connection` | `connection.api.sessions.history` 读取事件历史 |

## 使用

1. 打开一个会话（有历史消息）
2. 切到 **轨迹** 视图 —— 时间轴自动打开
3. 卡片自下而上浏览：意图标签 → 逻辑链 → 问/答摘要 → 文件条
4. 点击任一卡片头部查看**详情窗口**（过程归纳 + 完整逻辑链 + 最终总结 + 文件操作）
5. Ctrl/Cmd + 滚轮缩放；ESC 逐层关闭

## 架构

```
src/
├── index.ts          # host 入口（空 apply，客户端逻辑都在 client 模块）
└── client/
    ├── wire.ts       # 事件/API 的 wire 类型镜像（不依赖宿主类型）
    ├── model.ts      # history 事件 → TimelineGraph（轮次/文件/工具边）
    ├── timeline.ts   # 布局（S 形）+ 渲染 + 洞察/归纳/逻辑链 + 详情窗 + 缩放
    ├── timeline.css  # 深色能量主题样式（内联进 client bundle）
    └── plugin.ts     # 插件装配：按钮注入、面板开关、视图联动（自动开/关）
```

### 数据流
```
connection.api.sessions.history(sessionId)
  → buildGraph(events)               # model.ts：turn/start…turn/end 折叠
  → TimelineGraph{turns, edgeCount}
  → renderTimeline(stage, graph)     # timeline.ts
      ├─ analyzeGraph()      洞察条（高频文件 / 工具分布 / 统计）
      ├─ summarizeTurn()     意图标签 + 里程碑
      ├─ buildTurnChain()    因果逻辑链
      ├─ summarizeToolPatterns()  过程归纳（定位/读写/验证/报错）
      └─ layoutGraph()       S 形布局 + 贝塞尔连线
```

### 关键技术点
- **连线贴合**：`pathPoints` 取每张卡片**自身的中心**（`ry + h_i/2`），行间距用行内最高卡片，任意高度混合的行连线都不会脱离卡片
- **测量**：卡片真实高度通过离屏 flex 容器克隆测量（`measureCardHeights`），保证行不重叠
- **缩放**：布局度量（节点宽/间距/回绕带）整体乘以 `zoom`，卡片用 `transform: scale(zoom)`（`--node-w` 保持未缩放，避免双重缩放），SVG 同坐标系
- **渐变连线**：`linearGradient` 用 `objectBoundingBox`，SVG 必须保持真实画布尺寸（不能强制 100% 视口），否则渐变退化
- **最终总结**：`assistant/message` 只取 `text` 块（丢弃 `reasoning` 思考块）并**覆盖式**保留最后一条消息 —— 卡片展示「这轮交付了什么」而非「在想什么」

## 开发

```bash
~/.bun/bin/node scripts/build-client.mjs   # 构建
~/.bun/bin/node node_modules/typescript/bin/tsc --noEmit  # 类型检查
```
改动 `src/client/*` 后构建，DSH 侧热重载插件包（`dev_reload_package`），刷新页面即可。

## License

Apache License 2.0
