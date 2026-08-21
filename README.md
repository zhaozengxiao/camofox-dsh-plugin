# camofox-dsh-plugin

Camofox 反检测浏览器 — DeepSeek Harness (dsh) 原生工具插件。

把 [camofox-browser](https://github.com/jo-inc/camofox-browser)（Camoufox 反检测浏览器服务器，Firefox C++ 级指纹伪造）的 REST API 注册为 20 个 `camofox_*` 工具，AI 代理可直接调用，无需手写 curl。

有风控的站点（Google / Amazon / LinkedIn / YouTube 等）优先用 `camofox_*` 工具，能绕过大部分反爬检测。

## 功能

- **20 个工具**：`camofox_create_tab` `camofox_snapshot` `camofox_click` `camofox_type` `camofox_navigate` `camofox_scroll` `camofox_press` `camofox_wait` `camofox_evaluate` `camofox_links` `camofox_screenshot` `camofox_back` `camofox_forward` `camofox_refresh` `camofox_close_tab` `camofox_close_group` `camofox_destroy_session` `camofox_import_cookies` `camofox_list_tabs` `camofox_health`
- 前 11 个工具与官方 [OpenClaw 插件 / MCP 契约](https://github.com/jo-inc/camofox-browser/blob/main/mcp/lib/tool-contracts.mjs) 同名同参数
- **自动记忆**：最近创建的标签按 sessionKey 记录，后续工具可省略 tabId
- **截图落盘**：截图自动保存到本地目录并返回文件路径
- **自动拉起服务**：`/health` 不通时自动 spawn camofox-browser 服务（autoStart）

## 安装

前置：camofox-browser 服务已安装（推荐全局安装：`npm install -g @askjo/camofox-browser`，二进制缓存复用 `~/.cache/camoufox`）。

```bash
# 1. 复制插件到 web profile
cp -r camofox-dsh-plugin ~/.dsh/profiles/web/plugins/camofox

# 2. 编辑 ~/.dsh/profiles/web/package.json：
#    dependencies 增加:  "camofox": "file:./plugins/camofox",
#    dsh.profile.bundles 增加: "camofox"

# 3. 建立链接（让 dsh 加载器能找到插件）
ln -s ../plugins/camofox ~/.dsh/profiles/web/node_modules/camofox

# 4. 重启 dsh web，日志出现 [camofox] 已注册 20 个 Camofox 工具 即生效
```

> 单副本模式：部署目录 `~/.dsh/profiles/web/plugins/camofox` 本身就是 git 仓库，
> 改代码 → `git add -A && git commit && git push` 即完成提交+推送（改完需重启 dsh web）。

> 注：若 `pnpm install` 因 lockfile 供应策略拦截，手动 `ln -s` 即可（插件依赖
> `@deepseek-ai/dsh-tools` 通过全局 dsh 包的 node_modules 解析，无需重复安装）。

## 配置（cordis.patch.yml）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9377` | camofox-browser 服务地址 |
| `accessKey` | 空 | `CAMOFOX_ACCESS_KEY`（服务开启全局鉴权时填写） |
| `apiKey` | 空 | `CAMOFOX_API_KEY`（cookie 导入专用，未设则 403） |
| `userId` | `me` | 会话隔离标识（登录态按此隔离） |
| `sessionKey` | `default` | 标签分组 |
| `screenshotDir` | `~/Deepseek/camofox/screenshots` | 截图保存目录 |
| `cookiesDir` | `~/.camofox/cookies` | Netscape cookie 文件目录 |
| `autoStart` | `true` | 服务掉线时自动拉起 |
| `serverCwd` / `serverCommand` / `serverArgs` | `~` / `~/.npm-global/bin/camofox-browser` / `[]` | 自动拉起命令（全局安装的 bin） |

## 使用示例

```
camofox_create_tab(url="https://www.amazon.com")   → tabId
camofox_snapshot()                                  → a11y 树 + 元素 ref (e1/e2...)
camofox_type(ref="e3", text="关键词", pressEnter=true)
camofox_screenshot()                                → 截图存盘返回路径
camofox_close_tab()
```

导航后元素 ref 会重置，需重新 `camofox_snapshot`。

## 开发注意

DSH 工具输出需满足 **lossless JSON** 校验：返回对象不能含值为 `undefined` 的属性（否则报 "value is not lossless JSON"），条件性附加可选键（如 `file`）。

## License

MIT
