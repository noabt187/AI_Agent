# PageCraft 项目与预览同步设计

## 状态

待用户复核。本文只覆盖 PageCraft 文件工作区、PPT 图片绑定和预览同步，不修改 DeepSeek Harness 核心源码。

## 问题

当前同一个 PPT 被拆在三个位置：

- 项目根目录：`D:\project-memo\memory-diag-pagecraft`
- PPT 源码目录：`.pagecraft/presentations/presentation-mtgz2o4n-7b777c32`
- 项目图片目录：`public/pagecraft-assets`

目录分开本身没有错，错误在于各组件没有共同遵守 `pagecraft-presentation.json`：

1. 文件工作区可以把 PPT 源码子目录记成新的根，导致用户看不到完整项目关系。
2. 项目图片绑定已经写入 `deck.json`，客户端仍可能把旧 `assets.json` 绑定注入预览，造成旧图片覆盖新图片。
3. 当前 8095 预览服务器只服务 PPT 源码目录，却没有把 `/pagecraft-assets` 映射到 `public/pagecraft-assets`。
4. 图片替换完成后，插件依赖固定的 450 ms 延时刷新；外部浏览器没有可靠的实时刷新机制。

当前项目已验证：

- `GET /deck.json` 返回 200。
- `GET /pagecraft-assets/image-1-3099fec2.png` 返回 404。
- `GET /assets/asset-3099fec2b93edd05.png` 返回 200。

因此新图片已经写入磁盘和 `deck.json`，但预览服务器无法访问新图片目录。

## 目标

- 文件管理器、DSH 内嵌预览和外部浏览器明确属于同一个项目。
- 项目模式只有 `pagecraft-presentation.json` 和 `deck.json` 决定显示结果。
- 图片保存一次后，DSH 内嵌预览和 8095 外部预览都能读取同一个文件。
- 修改完成后可靠刷新，不依赖猜测性的等待时间。
- 现有 PPT 项目修复后可继续使用，未来生成的 PPT 不再重复产生该问题。

## 不做的事情

- 不修改 DeepSeek Harness 核心源码。
- 不把所有项目文件移动到同一个文件夹。
- 不为任意第三方开发服务器自动重写配置。
- 不删除旧 `assets.json`；它只作为旧版演示任务的兼容数据保留。

## 选择的方案

采用“清单统一路径 + 新旧模式隔离 + 预览服务器显式映射”的方案。

未采用的替代方案：

- 只修改当前 `server.js`：能修当前破图，但以后新项目仍会复现。
- 把新图片重新放回 PPT 源码目录：改动小，但破坏现有 `public/pagecraft-assets` 项目约定，也不适合普通 Vite/React 项目。

## 统一项目关系

`pagecraft-presentation.json` 是路径关系的唯一清单：

- `workspacePath`：真实项目根目录。
- `sourceRoot`：PPT 运行源码目录。
- `assets`：图片文件目录。
- `publicAssetBase`：浏览器访问图片时使用的网址前缀。

文件管理器仍以真实项目根目录为安全边界。打开 PPT 时自动展开并定位 `sourceRoot`，同时在标题区域显示：

- 项目目录
- PPT 源码目录
- 图片目录

用户仍可浏览整个项目，不再把某个子目录误认为另一个项目。

## 图片替换链路

项目模式的链路固定为：

1. 上传图片到清单指定的 `assets` 目录。
2. 校验图片确实写入磁盘。
3. 把新图片网址写入 `deck.json` 对应槽位。
4. 保存成功后立即刷新内嵌预览。
5. 外部预览服务器通知页面重新读取最新文件。

当项目清单存在时，插件不再加载或发送旧 `assets.json` 绑定。只有没有项目清单的旧版演示任务才使用旧绑定机制，两个模式不能同时工作。

对于带 `data-pagecraft-image-slot` 的页面，槽位中的 `img.src` 是显示图片的唯一运行值。旧的 `slide.visual` 不得覆盖槽位内容。

## 预览服务器

PageCraft 生成的 PPT 预览服务器必须同时服务两个目录：

- 普通页面请求从 `sourceRoot` 读取。
- 以 `publicAssetBase` 开头的请求从 `assets` 读取。

例如：

```text
/deck.json                          -> <sourceRoot>/deck.json
/pagecraft-assets/example.png       -> <projectRoot>/public/pagecraft-assets/example.png
```

映射前必须规范化路径并拒绝 `..`、符号链接越界和目录外访问。

当前 `memory-diag-pagecraft` 的 8095 服务器将按这项约定修复。PPT 生成 Skill 的服务器要求也同步更新，保证未来项目直接生成正确配置。

## 实时刷新

- DSH 内嵌预览：图片绑定接口返回成功后立即刷新，不再使用固定 450 ms 定时器。
- 外部 8095 预览：服务器监听 PPT 源码和图片目录；发生变化时通过轻量实时刷新通道通知页面刷新。
- 刷新后页面重新读取 `deck.json`，并保留当前幻灯片编号。
- 图片加载失败时，页面评注脚本向 PageCraft 报告失败网址，界面明确提示“图片已保存，但预览服务器没有提供该地址”，不能再显示虚假的“已同步”。

## 兼容处理

- 有 `pagecraft-presentation.json`：使用项目模式，只读写项目图片和 `deck.json`。
- 没有清单但有关联演示任务：继续使用旧 `assets.json` 兼容模式。
- 从旧模式迁移时：复制图片、写入项目清单和 `deck.json` 后，立即停止旧绑定注入。
- 不自动改写无法识别的第三方服务器；这种情况显示具体诊断和需要映射的目录。

## 错误处理

- 图片写入失败：不修改 `deck.json`。
- `deck.json` 被其他程序同时修改：返回冲突，让界面重新读取后再操作。
- 图片网址返回 404：保留已经保存的图片和代码，显示准确诊断，不回退成旧图片。
- 实时刷新连接断开：页面仍可手动刷新，不影响文件正确性。

## 验证

自动测试覆盖：

1. 项目模式不会发送旧任务图片绑定。
2. 旧模式仍能使用 `assets.json`。
3. 替换槽位只更新目标图片，不改变其他幻灯片。
4. 预览服务器能从 `publicAssetBase` 读取真实图片，并拒绝目录越界。
5. 文件工作区以项目根目录为边界，并能自动定位 `sourceRoot`。
6. 保存成功后立即刷新，不包含固定等待时间。

手工验收使用当前项目：

1. 在 PageCraft 中给第二页替换图片。
2. DSH 内嵌预览显示新图片。
3. `http://127.0.0.1:8095/` 显示同一张新图片。
4. 在文件管理器中能同时定位 PPT 源码和 `public/pagecraft-assets`。
5. 重启 DSH、刷新浏览器后图片仍然一致。

## 修改范围

- `plugins/dsh-frontend-feedback`：项目/旧模式隔离、文件工作区路径提示、刷新与错误反馈、测试。
- PageCraft 内置的 PPT 生成 Skill：未来预览服务器遵守清单中的图片映射。
- `D:\project-memo\memory-diag-pagecraft`：修复当前 8095 预览服务器和实时刷新脚本。
- DeepSeek Harness：不修改。
