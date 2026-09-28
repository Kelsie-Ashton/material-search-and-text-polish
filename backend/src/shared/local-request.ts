/**
 * 判断一个请求是不是来自本机（任务 7.4）。
 *
 * ## 为什么光绑 127.0.0.1 还不够
 *
 * 绑定回环地址挡住了**别的机器**，但挡不住**浏览器**——请求是从用户自己的
 * 电脑上发出去的，源端口、源地址都合法。两种典型的攻击都走这条路：
 *
 * 1. **跨源请求**。用户在另一个标签页打开了一个恶意页面，页面里的脚本
 *    向 `http://127.0.0.1:5174/api/...` 发请求。浏览器会带上
 *    `Origin: https://evil.example.com`，并且**响应读不到**（没有 CORS 头），
 *    但请求本身**发得出去**——不带请求体的 POST（比如取消任务）连预检都不触发。
 * 2. **DNS 重绑定**。攻击者把自己的域名解析到 127.0.0.1，于是浏览器认为
 *    这个页面与目标是**同源**的，连 `Origin` 都可能不发送。这时候唯一能
 *    识破它的就是 `Host`：浏览器发的是 `Host: evil.example.com`。
 *
 * 所以两道检查都要有，而且 **Host 那道是关键的那道**——Origin 挡得住第一种，
 * 挡不住第二种。
 *
 * ## 这是纯函数
 *
 * 不碰 `req`，只吃两个字符串。判据可以直接被测，而在中间件里断言
 * 「请求被拒了」要起一整个服务才测得到。
 */

/** 允许的来源。只有回环地址——README 里承诺的就是「只监听回环」。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

export type LocalRejectionReason = 'missing-host' | 'foreign-host' | 'foreign-origin'

export interface LocalRejection {
  reason: LocalRejectionReason
  /** 触发拒绝的原值，写进日志用。**不含任何敏感内容**（只有主机名）。 */
  detail: string
}

/** 统一成可以比较的形态：去掉 IPv6 的方括号、转小写。 */
function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * 从 `Host` 头里取出主机名。
 *
 * `Host` 是 `主机名[:端口]`，而 IPv6 要写成 `[::1]:5174`（带方括号）。
 * 裸的 `::1` 其实是非法写法，但这里不做区分——白名单会把它照常放行，
 * 而它本来就是回环地址，放行它没有任何风险。
 */
function hostnameOfHost(host: string): string | null {
  const value = host.trim().toLowerCase()
  if (value === '') return null

  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? null : value.slice(1, end).toLowerCase()
  }

  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  // 多个冒号 = 裸 IPv6，整串都是主机名
  if (first !== last) return value
  return first === -1 ? value : value.slice(0, first)
}

/**
 * 从 `Origin` 头里取出主机名。
 *
 * `Origin` 是一个完整的来源（`https://host:port`），用 `URL` 解析而不是自己切——
 * 自己切会在 IPv6、默认端口、大小写这些地方出错。
 *
 * `Origin: null`（沙箱 iframe、`file://` 页面）解析会抛，返回 null，
 * 调用方据此拒绝。**这类来源比陌生域名更可疑**，不该放行。
 */
function hostnameOfOrigin(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname)
  } catch {
    return null
  }
}

/**
 * 检查这个请求该不该被放行。
 *
 * 返回 `null` 表示放行；返回一个拒绝理由表示该拒。
 *
 * **Host 缺失也拒。** HTTP/1.1 要求必须带 Host，浏览器一定会带。
 * 少一个字段的请求不可信，而这属于「放行的代价大于误拒」的方向。
 */
export function checkLocalRequest(headers: {
  host: string | undefined
  origin: string | undefined
}): LocalRejection | null {
  const { host, origin } = headers

  // 空串与空白串也算「没有」。它和「有一个陌生主机名」在日志里是两句不同的话，
  // 而 `foreign-host：（空）` 读起来像我们自己的输出坏了。
  if (host === undefined || host.trim() === '') {
    return { reason: 'missing-host', detail: '(无 Host 头)' }
  }

  const hostname = hostnameOfHost(host)
  if (hostname === null || !LOOPBACK_HOSTNAMES.has(hostname)) {
    return { reason: 'foreign-host', detail: host }
  }

  // Origin 可能没有（同源 GET 不带它），但只要带了就必须是本机
  if (origin !== undefined) {
    const originHostname = hostnameOfOrigin(origin)
    if (originHostname === null || !LOOPBACK_HOSTNAMES.has(originHostname)) {
      return { reason: 'foreign-origin', detail: origin }
    }
  }

  return null
}
