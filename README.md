# SkyNote 钢笔

用锚点和控制柄绘制矢量路径。完成的路径仍可返回锚点编辑。

[免费在线体验](https://playground.skynote.top/?example=pen) · [功能文档](https://docs.skynote.top/plugins/pen)

## 主要能力

- 创建直线、曲线、开放路径和闭合轮廓。
- 调整锚点、控制柄、描边和填充。
- 对路径节点执行移动、缩放、旋转和撤销重做。

## 源码开发

包名为 `@skynote-pro/plugin-pen`。当前通过 pnpm 工作区解析 SkyNote 基础 SDK 依赖，公共 npm 暂无安装入口。宿主可以用 `createPlugins()` 装配插件。

只需在画布上展示已有路径时，可使用 `createDisplayPlugins()`。

在新工作区中装配基础 SDK，再将本插件检出到 `pro/plugin-pen`。

```sh
git clone https://github.com/skynote-universe/skynote.git
cd skynote
node scripts/bootstrap.mjs
git clone --branch main https://github.com/skynote-universe/plugin-pen.git pro/plugin-pen
pnpm install --no-frozen-lockfile
pnpm --filter @skynote-pro/plugin-pen typecheck
pnpm --filter @skynote-pro/plugin-pen test
```

工作区使用 Node.js 22.12 或更高版本和 pnpm 10.12.4。加入插件后，安装会更新本地锁文件，以记录额外的工作区包。

## 参与贡献

欢迎提交 PR。请阅读[许可证第 7 条](./LICENSE)，并在 PR 模板中勾选确认。直接提交者在开通写权限前书面确认。

## 许可证

[SkyNote 高级插件源码可见许可证 1.0](./LICENSE)
