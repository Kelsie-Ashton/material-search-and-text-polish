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
    expect(renderAt('/search')).toContain('输入关键词')
    expect(renderAt('/library')).toContain('添加本地素材目录')
    // 服务端渲染不会执行 useEffect，因此设置页停在「读取凭证」这一帧。
    // 表单本身由 Settings.test.tsx 在 jsdom 下覆盖。
    expect(renderAt('/settings')).toContain('正在读取本机凭证')
  })

  it('未知路径不会崩溃', () => {
    expect(renderAt('/no-such-page')).toContain('检索与文案润色')
  })
})
