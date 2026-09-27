import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import App from './App'

function renderAt(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('前端骨架', () => {
  it('三个功能入口都出现在导航中，可以互相跳转', () => {
    const html = renderAt('/search')

    expect(html).toContain('href="/search"')
    expect(html).toContain('href="/library"')
    expect(html).toContain('href="/settings"')
  })

  it('每条路由渲染各自的页面内容', () => {
    const search = renderAt('/search')
    expect(search).toContain('输入关键词')
    // 两字关键词会走全库扫描，这条提示必须出现在检索页上——
    // 它是用户唯一能知道「为什么这个词搜得慢/搜得不一样」的地方
    expect(search).toContain('不足 3 个字')

    // 服务端渲染不会执行 useEffect，所以这里断言的是**首帧**内容：
    // 素材库停在「正在读取」，设置页停在「读取凭证」。
    // 加载完成后的形态由 Library.test.tsx 与 Settings.test.tsx 覆盖。
    expect(renderAt('/library')).toContain('素材目录')
    expect(renderAt('/settings')).toContain('正在读取本机凭证')
  })

  it('未知路径不会崩溃', () => {
    expect(renderAt('/no-such-page')).toContain('检索与文案润色')
  })
})
