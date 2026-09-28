import { describe, expect, it } from 'vitest'

import { checkLocalRequest } from './local-request.js'

/**
 * 「只接受本机请求」的判据（任务 7.4）。
 *
 * 这一组测的是**这一层到底拦得住什么、又误伤了什么**。它有两类错误，
 * 而两类都不报错：
 *
 * - **放过了不该放过的**：整道防线形同虚设，且没有任何迹象。
 * - **拦了不该拦的**：用户什么都没做错，程序却打不开——而且他没有任何
 *   线索能查（请求根本没到业务代码）。
 *
 * 所以下面正反两侧的用例是同等重要的。
 */

/** 简写：只给 Host，没有 Origin（同源 GET 的常态） */
function host(value: string | undefined) {
  return checkLocalRequest({ host: value, origin: undefined })
}

describe('Host 检查', () => {
  it('放行回环地址的各种写法', () => {
    for (const value of [
      '127.0.0.1:5174',
      '127.0.0.1',
      'localhost:5174',
      'localhost',
      '[::1]:5174',
      '::1',
      // 大小写不该决定放不放行
      'LOCALHOST:5174',
      '127.0.0.1:5173', // 开发态 Vite 代理转过来的 Host
    ]) {
      expect(host(value), `Host=${value} 应当放行`).toBeNull()
    }
  })

  it('挡住陌生域名', () => {
    expect(host('evil.example.com')?.reason).toBe('foreign-host')
    expect(host('192.168.1.10:5174')?.reason).toBe('foreign-host')
  })

  it('**挡住长得像回环地址的域名**', () => {
    // 这一条是防「用 includes / startsWith 做判断」的写法。
    // 127.0.0.1.evil.com 是攻击者**真的可以注册**的域名，
    // 而且它 resolves 到哪儿由攻击者说了算。用子串匹配判的话，
    // 这两个会畅通无阻——防线看着在，其实是空的。
    expect(host('127.0.0.1.evil.com')?.reason).toBe('foreign-host')
    expect(host('localhost.evil.com')?.reason).toBe('foreign-host')
    expect(host('notlocalhost')?.reason).toBe('foreign-host')
    expect(host('evil.com:127.0.0.1')?.reason).toBe('foreign-host')
  })

  it('没有 Host 头也拒', () => {
    // HTTP/1.1 要求必须带 Host，浏览器一定会带。
    // 少一个字段的请求不可信——这是「放行的代价大于误拒」的方向。
    expect(host(undefined)?.reason).toBe('missing-host')
    expect(host('')?.reason).toBe('missing-host')
  })

  it('Host 里带方括号但没闭合时不崩，直接拒', () => {
    expect(host('[::1')?.reason).toBe('foreign-host')
  })
})

describe('Origin 检查', () => {
  it('没有 Origin 就跳过这一项——同源 GET 本来就不带它', () => {
    expect(checkLocalRequest({ host: '127.0.0.1:5174', origin: undefined })).toBeNull()
  })

  it('放行本机来源', () => {
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5173' }),
    ).toBeNull()
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: 'http://localhost:5173' }),
    ).toBeNull()
  })

  it('**挡住陌生来源**——这是「恶意页面在用户浏览器里发请求」那条路', () => {
    // 绑定回环地址挡不住这一种：请求是从用户自己的电脑上发出去的，
    // 源地址、源端口全都合法。唯一能识破的就是 Origin。
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: 'https://evil.example.com' })?.reason,
    ).toBe('foreign-origin')
  })

  it('**Origin: null 也要挡**', () => {
    // 沙箱 iframe、file:// 页面给出的就是 null。这类来源比陌生域名更可疑，
    // 而它恰恰是「看起来像没有值所以放过去」最容易漏掉的一种。
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: 'null' })?.reason,
    ).toBe('foreign-origin')
  })

  it('Origin 解析不了就拒，而不是当成没有', () => {
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: '这不是一个来源' })?.reason,
    ).toBe('foreign-origin')
  })

  it('Origin 里也用同一套「长得像」的判断', () => {
    expect(
      checkLocalRequest({ host: '127.0.0.1:5174', origin: 'http://127.0.0.1.evil.com' })?.reason,
    ).toBe('foreign-origin')
  })

  it('Host 与 Origin 都合格才放行', () => {
    // 缺任何一项都拒——两道检查是「与」的关系
    expect(checkLocalRequest({ host: 'evil.com', origin: 'http://127.0.0.1:5173' })).not.toBeNull()
    expect(checkLocalRequest({ host: '127.0.0.1:5174', origin: 'http://evil.com' })).not.toBeNull()
  })
})
