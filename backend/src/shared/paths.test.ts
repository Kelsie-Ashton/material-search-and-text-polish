import { describe, expect, it } from 'vitest'

import { extensionOf, fileNameOf, fingerprintOf, normalizePathKey } from './paths.js'

const isWindows = process.platform === 'win32'

describe('路径归一化', () => {
  // 这一组是整个函数存在的理由：同一个目录的不同写法必须收敛到同一个键。
  // 漏掉任何一种，用户就能把同一个目录添加多次，扫描跑多遍、
  // 素材表里出现多份指向同一批文件的记录。
  describe('等价写法必须归一到同一个键', () => {
    const cases: Array<[string, string, string]> = [
      ['尾部分隔符', 'D:\\素材库\\美食', 'D:\\素材库\\美食\\'],
      ['混合分隔符', 'D:\\素材库\\美食', 'D:/素材库/美食'],
      ['冗余分隔符', 'D:\\素材库\\美食', 'D:\\\\素材库\\\\美食'],
      ['当前目录段', 'D:\\素材库\\美食', 'D:\\素材库\\.\\美食'],
      ['回退段', 'D:\\素材库\\美食', 'D:\\素材库\\探店\\..\\美食'],
      ['首尾空白', 'D:\\素材库\\美食', '  D:\\素材库\\美食  '],
    ]

    for (const [label, left, right] of cases) {
      it(label, () => {
        expect(normalizePathKey(left)).toBe(normalizePathKey(right))
      })
    }
  })

  it('Windows 下大小写不敏感，D 盘与 d 盘是同一个目录', () => {
    // NTFS 不区分大小写。若这里区分了，用户粘贴路径时大小写变一下就能重复添加。
    const expected = isWindows
    expect(normalizePathKey('D:\\素材库') === normalizePathKey('d:\\素材库')).toBe(expected)
  })

  it('驱动器根部保留尾部分隔符', () => {
    // 尾部的 `\` 是根目录的组成部分，砍掉就变成了「D 盘的当前目录」，语义不同。
    if (!isWindows) return
    expect(normalizePathKey('D:\\')).toMatch(/^d:\\$/)
    expect(normalizePathKey('D:\\')).toBe(normalizePathKey('d:\\'))
  })

  it('空串与纯空白返回空串，交由调用方判定非法', () => {
    expect(normalizePathKey('')).toBe('')
    expect(normalizePathKey('   ')).toBe('')
  })

  it('空串不会因为归一化变成当前目录', () => {
    // path.normalize('') 返回 '.'，若不特判，空输入会被当成一个合法目录。
    expect(normalizePathKey('')).not.toBe('.')
  })

  it('中文路径原样保留', () => {
    expect(normalizePathKey('D:\\素材库\\美食探店')).toContain('素材库')
  })
})

describe('文件名与扩展名', () => {
  it('两种分隔符都能切分', () => {
    expect(fileNameOf('D:\\素材库\\美食.mp4')).toBe('美食.mp4')
    expect(fileNameOf('D:/素材库/美食.mp4')).toBe('美食.mp4')
  })

  it('忽略尾部分隔符', () => {
    expect(fileNameOf('D:\\素材库\\美食\\')).toBe('美食')
  })

  it('扩展名统一小写并带点', () => {
    expect(extensionOf('D:\\素材\\A.MP4')).toBe('.mp4')
    expect(extensionOf('D:\\素材\\A.JPEG')).toBe('.jpeg')
  })

  it('无扩展名与隐藏文件都返回空串', () => {
    expect(extensionOf('D:\\素材\\README')).toBe('')
    // `.gitignore` 的点和文件名是一体的，不是扩展名
    expect(extensionOf('D:\\素材\\.gitignore')).toBe('')
  })
})

describe('文件指纹', () => {
  it('大小与修改时间相同则指纹相同', () => {
    expect(fingerprintOf(1024, 1700000000000)).toBe(fingerprintOf(1024, 1700000000000))
  })

  it('大小或修改时间任一变化则指纹变化', () => {
    expect(fingerprintOf(1024, 1)).not.toBe(fingerprintOf(1025, 1))
    expect(fingerprintOf(1024, 1)).not.toBe(fingerprintOf(1024, 2))
  })

  it('毫秒以下的小数被截断，避免浮点误差导致误判为变化', () => {
    expect(fingerprintOf(1, 100.7)).toBe(fingerprintOf(1, 100.2))
  })
})
