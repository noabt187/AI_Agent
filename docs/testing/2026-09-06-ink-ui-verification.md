# 灰白水墨 UI 改版验证

## 备份与范围

- 改版前的源码、PageCraft 改进、测试和验证文档已提交并推送至 `origin/lwm_dev`。
- 备份提交：`59c8784c170639c240ecfe0f97854029552cee8e`，已通过 `git ls-remote` 核对远端一致。
- 缓存 `.pnpm-store`、临时目录 `.tmp`、评估运行产物 `eval/results` 和插件 ZIP 未上传，仍保留本地。
- 本轮 UI 修改留在本地供确认，未再次提交或推送。

## 实现

- 重整宿主主题样式为一套共享语义变量：灰白背景、墨灰正文、低对比度灰白山水，微金只用于少数强调线。
- 默认浅色；保留用户明确选择的暗色偏好，并处理浏览器存储不可用的情况。测试浏览器已选择浅色。
- 统一侧栏、顶部工具栏、会话、输入区、监控与设置弹窗，移除旧渐变和发光样式。
- PageCraft 入口使用现有 DSH 标签颜色变量适配宿主。未修改 PageCraft 插件源码、Agent 运行逻辑或插件接口。
- 图像本地打包，不依赖外部图片服务。生成工具与完整提示词见 `web/src/assets/README.md`。

## 自动检查

通过：

```text
node --import tsx --test --test-concurrency=1 tests/ui-theme.test.ts tests/task-confirmation-ui.test.tsx tests/agent-exit-isolation.test.tsx tests/session-selection.test.ts tests/session-drafts.test.ts tests/browser-slots.test.tsx
11 passed, 0 failed
npm run build
npm run build:web
git diff --check
```

主题检查覆盖浅色默认值、偏好保留、存储异常、主要色值为中性灰，以及主要/次要文字在灰白底上的 4.5:1 对比度。保留任务确认、草稿恢复与 PageCraft 退出隔离回归。

## 浏览器检查

- 实际浏览器检查了会话内容、监控明细、记忆管理、仓库设置、技能管理。
- 390 × 844 窄屏及 1440 × 900 宽屏：折叠/展开导航和输入区可用；窄屏 DOM 未发现页面横向溢出。
- 浅色/暗色切换正常，刷新后恢复浅色和原选中会话 session-011。
- PageCraft 入口在白底上原本对比不足，已使用它现有的 `--dsw-alias-label-secondary` 变量修正。
- 开发期间整体替换样式文件时曾出现一次 Vite 热更新错误；最终构建通过，刷新后的页面已加载完整样式，主背景计算值为 `rgb(247, 247, 247)`。
- 未通过真实 Agent 发送新任务，未保存仓库配置或记忆，未改写实验仓库。本轮不代替此前尚待人工完成的原生窗口验收。
