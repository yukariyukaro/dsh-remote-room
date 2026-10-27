# 0001 · 远程文件拥有独立资源身份

状态：采用；宿主接线仍需已安装插件验收。

## 决定

房间页面使用 `remote-room` tab，远程文件使用独立 `remote-room-document` tab 与 `dsh-resource://remote-room-file/...` 地址。地址包含房间、连接代际和远端路径，不包含邀请秘密。通过现有 DSH Connection 上的插件控制桥获取文件，不新增房主监听端口。

不覆盖 `file` provider、`text/files` kind、better-sidebar entry 或跨协议的扩展名匹配。打开远程文件不传 replaceTab；现有本地文件继续由其原有处理器打开。刷新或从布局恢复时重新检查原房间/代际，不将旧 tab 重绑到新连接。

## 原因与证据

参考 DSH `22ddee37` 的 `ui-sidebar-documentpreview` 中，`definition.ts`、`rpc.ts` 与 `TextPreview.tsx` 将文件加载绑定至 file/session 地址和 workspaceFiles。documentPreviews 注册的是格式渲染器，而非数据源适配器。不能仅注册一种 Markdown 渲染器，就声称云端地址自动支持内置预览。

2026-10-26 实时 Slots 确认 `sidebar.right.pane.tab` 是 session scoped keyed 扩展点，现有 documentpreview 和 better-sidebar 的 editor/files/git 等 entry 均在使用。独立 key 不取代它们。Service Inspect 未提供 sidebarRight/sidebarRightTabs 编程目录，因此精确调用依参考源码，最终由已安装插件操作验证。

## 首个实现与后续

先支持有界 UTF-8 文本（含明确标注的 Markdown 源码）及 PNG/JPEG/GIF/WebP 图片，全部只读。HTML、SVG 等主动内容不注入应用 DOM。Markdown 渲染、相对媒体、PDF/Office 将独立实现和测试，不把源码预览称为完整格式预览。

不默认将远程内容写入本地文件缓存。若未来提供快照导出，必须是用户明确操作，展示远端来源、版本和缓存语义，不得让用户误以为本地缓存的编辑会写回房主。
