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

## 授权

本插件采用 SkyNote 高级插件源码可见许可证 1.0。个人可在本地非商业使用，组织可以在开发或测试环境中评估接入，并邀请指定外部人员参加受限的非生产试用。正式业务使用、对外产品集成、客户交付和超出试用范围的再分发需要书面授权。GitHub 平台内 fork 适用其服务条款。

首次可补救违约自收到书面通知的次日起有 7 个自然日补救。商业使用与分发授权请联系 skynote-universe，邮箱为 skyfish4096@gmail.com。[完整许可证](./LICENSE)

## 参与贡献

外部贡献按许可证第 7 条授权。原权利人保留著作权，skynote-universe 可将贡献用于源码可见版和商业版，并向客户再许可。[贡献授权条款](./LICENSE)

PR 作者在模板中勾选确认后，由维护者核对并合并。直接提交者在开通写权限前书面确认，同意记录覆盖的提交无需逐次确认。
