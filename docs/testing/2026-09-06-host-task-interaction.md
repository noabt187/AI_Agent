# 宿主任务交互升级验收记录

日期：2026-09-06。工作区：`D:\project\AI_Agent`；分支：`lwm_dev`。

## 交付结论

已实现宿主任务状态卡、顶层确认／补充面板、版本化跟进和精确停止。PageCraft 共享包完全未修改。浏览器夹具验证了真实插件组件与宿主面板共存，但不把夹具验收等同于模型成功生成真实 PPT。

实现按 writing-plans 中的数据保护、状态投影、共用 UI、同包验收四层拆分；没有增加调度器、数据库或插件私有协议。

## 行为

- PageCraft 打开时，正式确认／补充问题／已知协议回退可在宿主原生 dialog 中处理；插件组件保持挂载。
- 收起和 Escape 只关闭宿主详情，不停止 Agent、不撤销确认、不关闭 PageCraft。新方案不会继承旧确认按钮的焦点。
- 主聊天入口和顶层面板共用一个操作控制器和一份活动表单，候选选择、修订、撤销继续携带完整版本引用。
- 跟进使用 `taskId/taskRevision/sourceRunId`，入队与出队均校验，修订时清除原确认及写权限。
- 停止使用 `expectedRunId`，过期停止返回冲突，不中断后继运行；旧 API 参数仍可省略。
- Run 来源和结果诊断持久化；不从普通回复文字推断确认授权。Run 结束不等于 Task 完成。
- 流末尾及断线进入核实状态，未核实前不提供授权操作；失败不自动重发。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm test` | 165 / 165 通过 |
| `npm run build` | 通过 |
| `npm run build:web` | 通过 |
| `npm run test:pagecraft-plugin` | 3 / 3 通过，含同包安装、启动和真实 bundle DOM 交互 |
| 在 `plugins/dsh-frontend-feedback` 执行 `npm test` | 115 / 115 通过；未执行 build |
| `git diff --check` | 通过 |

新增和更新测试覆盖：元数据重载／终态不可覆盖、旧跟进及目录变更拒绝、延迟出队拒绝、停止不误伤、事件乱序、旧记录兼容、跨会话隔离、正式确认、只读确认、修订／撤销／继续、重复提交、协议回退、页面可见性、IME Escape 和原生 cancel 的处理逻辑。

`tests/pagecraft-client.integration.test.tsx` 使用磁盘中未修改的 `lib/client.js`，打开 PageCraft 演示文稿表单、输入草稿，再展示和收起宿主确认／异常面板。检查插件节点仍是同一节点、草稿仍在，没有额外插件 prompt。jsdom 只模拟 showModal/close；真实顶层和键盘行为另验。

测试过程中曾发现旧 App 测试夹具没有 Run 归属、只查询主容器。现已补齐完整 SessionDetail，并改为检查真实 portal；没有取消原有版本、候选、只读确认和延迟响应断言。

现有插件测试仍有 border/borderTop 样式警告，安装集成仍有 Node 的既有 shell 兼容警告，均未修改插件来消除警告。

## 真实浏览器验收

Chrome 中打开开发专用夹具：`http://localhost:5173/qa/task-interaction.html`。

夹具调用真实宿主 UI 与同一 PageCraft bundle。宿主动作只写内存日志；所有插件项目 API 在夹具页明确拒绝，不读写真实项目，不伪造生成成功。它不在生产构建的入口中。

已实际操作并检查：

1. PageCraft → 演示文稿 → 上传文档生成，输入未提交文档草稿。
2. 注入正式确认；宿主 `dialog.matches(':modal')` 为 true，焦点是 H2 标题。截图确认覆盖 PageCraft 的普通覆盖层。
3. 原生 Escape 后宿主关闭，PageCraft 及文档草稿仍在；操作日志为空。
4. 选择方案并确认，日志包含对应 task/revision/confirmationId/selection；状态更新后宿主收起。
5. 停止时记录精确 expectedRunId；插件不关闭，草稿不丢失。
6. 注入协议回退；没有“确认执行”按钮，只有补充和明确请求重新给出方案，后者记录 followup 而非 confirm/resume。
7. 调整意见收起后恢复，提交记录 revise；撤销记录原方案引用并进入暂停。
8. 普通回复不自动弹窗；补充问题允许回答并记录 followup。
9. 模拟断线后显示核实状态，不开放停止／确认，重新核实后恢复已知状态。
10. 390 × 844 视口：面板左右边界约 17–373px，状态卡约 10–380px，dialog scrollWidth 等于 clientWidth，没有宿主面板横向溢出。已恢复默认视口。

用户原有 session-012 只读查看，页面已显示“本轮已结束”，未向它发送生成、确认或修复请求。测试夹具标签页已关闭，原有用户标签页保留。

## 插件零改动核对

比较基线 `ebf139fa5d5b0eec3eac2c05de00df8e19cd4e42`：

```powershell
git diff ebf139fa5d5b0eec3eac2c05de00df8e19cd4e42 --exit-code -- plugins/dsh-frontend-feedback
```

无差异。目录树基线 `7ae542f9c7fcf9bb8563b409c91a4c5f248134a7` 未变。

- client SHA256：`7051CDA227B15821225BEA639032373D34D7BB08B9EF37049FA5D82C7369278B`
- server SHA256：`F551F809507D79720E811F1C46850AD397B5F2704A23A5DB99AD8280F0343C6D`

## 边界及未验证项

- 插件内部“正在规划”文案没有改写；宿主显示真实执行状态，不能保证旧插件自己的所有进度文字同步。
- 已知 `response.json is not a function` 初始化异常仍属于插件自身范围，本次未修复，在真实 bundle 夹具中也能观察到。
- 没有用真实模型重新生成或验收用户 PPT，也没有再次对 DSH 做端到端验收。
- 页面后台回前台、旧确认／跨会话、IME 组合通过自动测试覆盖；本轮没有另外手工做真实双标签并发、实际断网、操作系统 IME 及浏览器后台计时测试。断线浏览器检查使用可控状态夹具。
- `.tmp/`、`.pnpm-store/`、原有插件 zip 保留。只创建本地任务提交，没有推送 GitHub。
