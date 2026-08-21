/**
 * camofox —— Camofox 反检测浏览器工具插件。
 *
 * 职责：把 camofox-browser 的 REST API（默认 http://127.0.0.1:9377）注册为
 * camofox_* 工具。Camofox 是 Camoufox（Firefox C++ 级反检测 fork）的自动化
 * 服务器，指纹（navigator/WebGL/AudioContext/WebRTC）在 C++ 层伪造，能绕过
 * Google/Cloudflare 等大部分风控——有反爬的站点优先用 camofox_* 工具而非
 * Chrome。
 *
 * 工具命名与参数对齐官方契约（mcp/lib/tool-contracts.mjs，与 OpenClaw 插件
 * / MCP 服务器同一份），另加 press / wait / links / back / forward / refresh
 * / close_group / destroy_session / health 等实用扩展。
 *
 * 服务依赖：camofox-browser 服务需在运行。autoStart=true（默认）时，若
 * /health 不通会自动 spawn 服务进程（serverCwd/serverCommand/serverArgs）。
 */
import { spawn } from 'node:child_process'
import {
  mkdirSync, writeFileSync, readFileSync, realpathSync, statSync,
} from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** 稳定插件名。 */
export const name = 'camofox'

/** 需要的服务：工具注册。 */
export const inject = ['tools']

/** 插件配置。 */
export const Config = z.object({
  /** camofox-browser REST 服务地址。 */
  baseUrl: z.string().default('http://127.0.0.1:9377'),
  /** 全局访问密钥（CAMOFOX_ACCESS_KEY，本机未设则留空）。 */
  accessKey: z.string().default(''),
  /** Cookie 导入专用密钥（CAMOFOX_API_KEY，未设则 cookie 端点 403）。 */
  apiKey: z.string().default(''),
  /** 会话隔离标识（不同 userId 的 Cookie/登录态相互独立）。 */
  userId: z.string().default('me'),
  /** 标签分组标识。 */
  sessionKey: z.string().default('default'),
  /** 截图保存目录。 */
  screenshotDir: z.string().default('/home/zhaozengxiao/Deepseek/camofox/screenshots'),
  /** Cookie 文件目录（Netscape 格式）。 */
  cookiesDir: z.string().default(join(homedir(), '.camofox', 'cookies')),
  /** 单次调用超时（毫秒）。 */
  timeoutMs: z.number().default(120000),
  /** /health 不通时是否自动拉起服务。 */
  autoStart: z.boolean().default(true),
  /** 自动拉起服务的工作目录。 */
  serverCwd: z.string().default('/home/zhaozengxiao'),
  /** 自动拉起服务的命令（全局安装的 camofox-browser bin）。 */
  serverCommand: z.string().default('/home/zhaozengxiao/.npm-global/bin/camofox-browser'),
  /** 自动拉起服务的参数。 */
  serverArgs: z.array(z.string()).default([]),
})

/** 每个 sessionKey 最近创建的 tabId（工具可省略 tabId 参数）。 */
const tabBySession = new Map()
/** 服务自动拉起的并发锁。 */
let serverStarting = null

/* ------------------------------------------------------------------ */
/* 底层：REST 调用 / 服务保活 / 工具函数                                 */
/* ------------------------------------------------------------------ */

function authHeaders(config, useApiKey = false) {
  const h = { 'Content-Type': 'application/json' }
  const key = useApiKey ? config.apiKey : config.accessKey
  if (key) h.Authorization = `Bearer ${key}`
  return h
}

/**
 * 调用 camofox REST API。返回解析后的 JSON；image 响应返回 Buffer。
 * 非 2xx 抛错（带响应体片段）。
 */
async function request(config, method, path, body, { useApiKey = false } = {}) {
  const res = await fetch(config.baseUrl + path, {
    method,
    headers: authHeaders(config, useApiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const ct = res.headers.get('content-type') || ''
  if (ct.startsWith('image/')) {
    if (!res.ok) throw new Error(`camofox ${method} ${path}: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`camofox ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

/** 快速健康探测（3s 超时，不抛错）。 */
async function ping(config) {
  try {
    const res = await fetch(config.baseUrl + '/health', {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 确保 camofox 服务在线：不通且 autoStart 时 spawn 并等待。 */
function ensureServer(config) {
  if (serverStarting) return serverStarting
  serverStarting = (async () => {
    if (await ping(config)) return
    if (!config.autoStart) {
      throw new Error(
        `camofox 服务未运行（${config.baseUrl}）。请先启动：cd ${config.serverCwd} && npm start` +
        '，或在插件配置里设 autoStart:true',
      )
    }
    const child = spawn(config.serverCommand, config.serverArgs, {
      cwd: config.serverCwd,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await ping(config)) return
    }
    throw new Error(
      `camofox 服务启动超时（${config.baseUrl}）。请检查：cd ${config.serverCwd} && npm start 能否正常启动`,
    )
  })().finally(() => {
    serverStarting = null
  })
  return serverStarting
}

/** 解析本次操作的目标标签：优先 args.tabId，否则用该 sessionKey 最近创建的。 */
function resolveTab(config, args) {
  const key = args.sessionKey || config.sessionKey
  const tabId = args.tabId || tabBySession.get(key)
  if (!tabId) {
    throw new Error(
      `未找到标签：请先调用 camofox_create_tab 创建标签（sessionKey=${key}），或显式传 tabId 参数`,
    )
  }
  return { tabId, key }
}

/** 保存图片 Buffer 到 screenshotDir，返回文件路径。 */
function saveImage(config, buf, ext = 'png') {
  mkdirSync(config.screenshotDir, { recursive: true })
  const file = join(config.screenshotDir, `camofox-${Date.now()}.${ext}`)
  writeFileSync(file, buf)
  return file
}

/** 解析 Netscape 格式 cookie 文件。 */
function parseNetscape(text) {
  const cookies = []
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
    let httpOnly = false
    let working = line
    if (working.startsWith('#HttpOnly_')) {
      httpOnly = true
      working = working.slice('#HttpOnly_'.length)
    }
    const parts = working.split('\t')
    if (parts.length < 7) continue
    cookies.push({
      name: parts[5],
      value: parts.slice(6).join('\t'),
      domain: parts[0],
      path: parts[2],
      expires: Number(parts[4]),
      httpOnly,
      secure: parts[3].toUpperCase() === 'TRUE',
    })
  }
  return cookies
}

/** 读取 cookies 目录内的 Netscape cookie 文件（带越界防护）。 */
function readCookieFileSync(cookiesDir, cookiesPath, domainSuffix) {
  if (typeof cookiesPath !== 'string' || cookiesPath.length === 0) {
    throw new Error('cookiesPath 必须是非空相对路径（相对 cookies 目录）')
  }
  if (isAbsolute(cookiesPath)) {
    throw new Error('cookiesPath 必须是 cookies 目录内的相对路径')
  }
  let base
  try {
    base = realpathSync(cookiesDir)
  } catch (e) {
    throw new Error(`cookies 目录不存在：${cookiesDir}（${e.message}）`)
  }
  const requested = resolve(base, cookiesPath)
  const rel = relative(base, requested)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('cookiesPath 越界：必须在 cookies 目录内')
  }
  let real
  try {
    real = realpathSync(requested)
  } catch {
    throw new Error(`cookie 文件不存在：${cookiesPath}（相对 ${cookiesDir}）`)
  }
  const relReal = relative(base, real)
  if (relReal === '' || relReal === '..' || relReal.startsWith('..' + sep)) {
    throw new Error('cookiesPath 解析后越界')
  }
  if (statSync(real).size > 5 * 1024 * 1024) {
    throw new Error('Cookie 文件过大（上限 5MB）')
  }
  let cookies = parseNetscape(readFileSync(real, 'utf8'))
  if (domainSuffix) cookies = cookies.filter((c) => c.domain.endsWith(domainSuffix))
  return cookies
}

/** 通用输出契约：{ ok, message, file? }。 */
const OUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
      file: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/* ------------------------------------------------------------------ */
/* 工具表                                                               */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'camofox_health',
    description:
      '检查 Camofox 反检测浏览器服务是否在线（必要时自动拉起服务）。返回浏览器连接状态、活跃标签/会话数、内存占用。',
    parameters: {},
    async handler(_ctx, config) {
      await ensureServer(config)
      const data = await request(config, 'GET', '/health')
      return { ok: true, message: JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_create_tab',
    description:
      'PREFERRED：用 Camoufox 反检测浏览器创建新标签（可带初始 URL，留空开空白标签），返回 tabId，后续操作自动定位该标签。' +
      '有风控的站点（Google/Amazon/LinkedIn/YouTube 等）优先用 camofox_* 工具，能绕过大部分反爬检测。',
    parameters: {
      url: { type: 'string', description: '初始打开的 URL（可选，留空创建空白标签；不要用 about:blank，会被 400 拒绝）' },
      sessionKey: { type: 'string', description: '标签分组（可选，默认插件配置的 sessionKey）' },
    },
    async handler(_ctx, config, args) {
      await ensureServer(config)
      const sessionKey = args.sessionKey || config.sessionKey
      const body = { userId: config.userId, sessionKey }
      if (args.url) body.url = args.url
      const data = await request(config, 'POST', '/tabs', body)
      const tabId = data.tabId
      if (tabId) tabBySession.set(sessionKey, tabId)
      return { ok: true, message: `已创建 Camofox 标签: ${tabId}\nurl: ${data.url || '(空白)'}` }
    },
  },
  {
    name: 'camofox_list_tabs',
    description: '列出当前会话（userId）下所有打开的 Camofox 标签：tabId、标题、URL。',
    parameters: {},
    async handler(_ctx, config) {
      const data = await request(config, 'GET', `/tabs?${new URLSearchParams({ userId: config.userId })}`)
      const tabs = data.tabs || []
      if (!tabs.length) return { ok: true, message: '（当前无打开的标签）' }
      const lines = tabs.map((t) => `${t.tabId}  ${t.title || ''}  ${t.url}`)
      return { ok: true, message: lines.join('\n') }
    },
  },
  {
    name: 'camofox_snapshot',
    description:
      '获取 Camofox 标签页的无障碍快照（a11y 树），元素带稳定 ref（e1/e2/...）供 camofox_click / camofox_type 使用；ref 可穿透 iframe。' +
      '大页面自动截断：响应含 hasMore=true 时用 nextOffset 继续翻页。includeScreenshot=true 时把页面截图存为文件并返回路径。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略，自动用该分组最近创建的）' },
      offset: { type: 'number', description: '快照分页偏移（用上次响应的 nextOffset）' },
      includeScreenshot: { type: 'boolean', description: '是否同时截图并存为文件（默认 false，省 token）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const params = new URLSearchParams({ userId: config.userId })
      if (args.includeScreenshot) params.set('includeScreenshot', 'true')
      if (args.offset != null) params.set('offset', String(args.offset))
      const data = await request(config, 'GET', `/tabs/${tabId}/snapshot?${params}`)
      let message = data.snapshot || '(快照为空)'
      if (data.hasMore) {
        message += `\n\n[快照已截断 hasMore=true，用 offset=${data.nextOffset} 获取下一页]`
      }
      let file
      if (data.screenshot && data.screenshot.data) {
        file = saveImage(config, Buffer.from(data.screenshot.data, 'base64'))
        message += `\n\n截图已保存: ${file}`
      }
      // lossless JSON 校验拒绝值为 undefined 的属性：仅在确有值时附加 file 键
      const result = { ok: true, message }
      if (file) result.file = file
      return result
    },
  },
  {
    name: 'camofox_click',
    description: '点击 Camofox 标签页中的元素。ref 来自 camofox_snapshot（如 e1）；也可用 CSS selector。ref 可穿透跨域 iframe（如登录框）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      ref: { type: 'string', description: '快照中的元素 ref（如 e1）' },
      selector: { type: 'string', description: 'CSS 选择器（ref 的替代）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const body = { userId: config.userId }
      if (args.ref) body.ref = args.ref
      if (args.selector) body.selector = args.selector
      const data = await request(config, 'POST', `/tabs/${tabId}/click`, body)
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_type',
    description: '向 Camofox 标签页中的元素输入文本。ref 来自 camofox_snapshot；也可用 CSS selector。clear 先清空；pressEnter 输入后回车（如搜索框）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      ref: { type: 'string', description: '快照中的元素 ref（如 e2）' },
      selector: { type: 'string', description: 'CSS 选择器（ref 的替代）' },
      text: { type: 'string', description: '要输入的文本', required: true },
      clear: { type: 'boolean', description: '输入前是否清空已有内容（默认 false）' },
      pressEnter: { type: 'boolean', description: '输入后是否按回车（默认 false）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const body = { userId: config.userId, text: args.text }
      if (args.ref) body.ref = args.ref
      if (args.selector) body.selector = args.selector
      if (args.clear) body.clear = true
      if (args.pressEnter) body.pressEnter = true
      const data = await request(config, 'POST', `/tabs/${tabId}/type`, body)
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_navigate',
    description:
      '导航 Camofox 标签页到指定 URL，或使用搜索宏（@google_search / @youtube_search / @amazon_search / @reddit_search / @reddit_subreddit / ' +
      '@wikipedia_search / @twitter_search / @yelp_search / @spotify_search / @netflix_search / @linkedin_search / @instagram_search / @tiktok_search / @twitch_search）。' +
      '导航后元素 ref 会重置，需重新 camofox_snapshot。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      url: { type: 'string', description: '要导航的 URL' },
      macro: { type: 'string', description: '搜索宏（如 @google_search）；与 url 二选一' },
      query: { type: 'string', description: '宏的搜索关键词' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const body = { userId: config.userId }
      if (args.url) body.url = args.url
      if (args.macro) body.macro = args.macro
      if (args.query) body.query = args.query
      const data = await request(config, 'POST', `/tabs/${tabId}/navigate`, body)
      const url = data.url || data.finalUrl || ''
      return { ok: true, message: `已导航: ${url || JSON.stringify(data, null, 2)}` }
    },
  },
  {
    name: 'camofox_scroll',
    description: '滚动 Camofox 页面（up/down/left/right，可指定像素数）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向', required: true },
      amount: { type: 'number', description: '滚动像素数（可选）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const body = { userId: config.userId, direction: args.direction }
      if (args.amount != null) body.amount = args.amount
      const data = await request(config, 'POST', `/tabs/${tabId}/scroll`, body)
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_press',
    description: '在 Camofox 标签页按下键盘键（如 Enter、Escape、Tab、ArrowDown）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      key: { type: 'string', description: '按键名，如 Enter', required: true },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'POST', `/tabs/${tabId}/press`, {
        userId: config.userId,
        key: args.key,
      })
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_wait',
    description: '等待 Camofox 页面出现指定 CSS 选择器，或等待固定时长（页面加载/渲染完成后再继续）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      selector: { type: 'string', description: '要等待出现的 CSS 选择器（可选）' },
      timeout: { type: 'number', description: '最长等待毫秒数（可选）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const body = { userId: config.userId }
      if (args.selector) body.selector = args.selector
      if (args.timeout != null) body.timeout = args.timeout
      const data = await request(config, 'POST', `/tabs/${tabId}/wait`, body)
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_evaluate',
    description:
      '在 Camofox 标签页的页面上下文执行 JavaScript 表达式并返回结果。用于注入脚本、读取页面状态、抓取运行时资源（如 Performance API 里的 m3u8 链接）、调用页面 API。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
      expression: { type: 'string', description: '要执行的 JS 表达式', required: true },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'POST', `/tabs/${tabId}/evaluate`, {
        userId: config.userId,
        expression: args.expression,
      })
      const result = data.result
      const message = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { ok: true, message }
    },
  },
  {
    name: 'camofox_links',
    description: '提取 Camofox 页面上的所有链接（文本 + URL），用于发现导航目标。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'GET', `/tabs/${tabId}/links?${new URLSearchParams({ userId: config.userId })}`)
      const links = data.links || data
      if (Array.isArray(links) && !links.length) return { ok: true, message: '（页面无链接）' }
      const lines = Array.isArray(links)
        ? links.map((l) => (typeof l === 'string' ? l : `${l.text || ''}  ${l.href || l.url || ''}`))
        : [JSON.stringify(data, null, 2)]
      return { ok: true, message: lines.join('\n') }
    },
  },
  {
    name: 'camofox_screenshot',
    description: '对 Camofox 标签页截图，保存为 PNG 文件并返回路径（可用 read_image 查看）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const buf = await request(config, 'GET', `/tabs/${tabId}/screenshot?${new URLSearchParams({ userId: config.userId })}`)
      const file = saveImage(config, buf)
      return { ok: true, message: `截图已保存: ${file}`, file }
    },
  },
  {
    name: 'camofox_back',
    description: 'Camofox 标签页后退。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'POST', `/tabs/${tabId}/back`, { userId: config.userId })
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_forward',
    description: 'Camofox 标签页前进。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'POST', `/tabs/${tabId}/forward`, { userId: config.userId })
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_refresh',
    description: '刷新 Camofox 标签页（有时可自动通过滑块/人机验证）。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略）' },
    },
    async handler(_ctx, config, args) {
      const { tabId } = resolveTab(config, args)
      const data = await request(config, 'POST', `/tabs/${tabId}/refresh`, { userId: config.userId })
      return { ok: true, message: data && data.ok ? 'ok' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_close_tab',
    description: '关闭 Camofox 标签。',
    parameters: {
      tabId: { type: 'string', description: '标签 ID（可省略，默认关该分组最近创建的）' },
    },
    async handler(_ctx, config, args) {
      const { tabId, key } = resolveTab(config, args)
      const data = await request(config, 'DELETE', `/tabs/${tabId}?${new URLSearchParams({ userId: config.userId })}`)
      if (tabBySession.get(key) === tabId) tabBySession.delete(key)
      return { ok: true, message: data && data.ok ? '已关闭标签' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_close_group',
    description: '关闭某个分组（sessionKey）下的所有 Camofox 标签。',
    parameters: {
      sessionKey: { type: 'string', description: '要关闭的分组（默认插件配置的 sessionKey）' },
    },
    async handler(_ctx, config, args) {
      const key = args.sessionKey || config.sessionKey
      const data = await request(config, 'DELETE', `/tabs/group/${encodeURIComponent(key)}?${new URLSearchParams({ userId: config.userId })}`)
      tabBySession.delete(key)
      return { ok: true, message: data && data.ok ? `已关闭分组 ${key}` : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_destroy_session',
    description: '销毁当前 userId 的整个会话：关闭所有标签并清理登录态（Cookie/localStorage 持久化）。换账号或清理环境时用。',
    parameters: {},
    async handler(_ctx, config) {
      const data = await request(config, 'DELETE', `/sessions/${encodeURIComponent(config.userId)}`)
      tabBySession.clear()
      return { ok: true, message: data && data.ok ? '会话已销毁' : JSON.stringify(data, null, 2) }
    },
  },
  {
    name: 'camofox_import_cookies',
    description:
      '导入 Netscape 格式 cookie 文件到当前 Camofox 会话，实现免登录访问（LinkedIn/Amazon 等）。' +
      'cookiesPath 为服务器 cookies 目录（默认 ~/.camofox/cookies）内的相对路径。' +
      '注意：服务器需设置 CAMOFOX_API_KEY 才开放该端点，本机默认未设会返回 403。',
    parameters: {
      cookiesPath: { type: 'string', description: 'cookies 目录内的相对路径（如 linkedin.txt）', required: true },
      domainSuffix: { type: 'string', description: '只导入 domain 以此后缀结尾的 cookie（可选）' },
    },
    async handler(_ctx, config, args) {
      const cookies = readCookieFileSync(config.cookiesDir, args.cookiesPath, args.domainSuffix)
      if (!cookies.length) throw new Error('cookie 文件解析结果为空（无有效行或 domainSuffix 过滤后为空）')
      const data = await request(
        config,
        'POST',
        `/sessions/${encodeURIComponent(config.userId)}/cookies`,
        { cookies },
        { useApiKey: true },
      )
      return { ok: true, message: `已导入 ${cookies.length} 个 cookie: ${JSON.stringify(data)}` }
    },
  },
]

function apply(ctx, config) {
  for (const t of TOOLS) {
    ctx.tools.register(defineTool({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: OUT,
      async execute(args) {
        return await t.handler(ctx, config, args || {})
      },
    }))
  }
  console.error(`[camofox] 已注册 ${TOOLS.length} 个 Camofox 工具 (baseUrl: ${config.baseUrl})`)
}

export default { name, inject, Config, apply }
