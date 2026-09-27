import path from 'node:path'

/**
 * 路径归一化 —— 判断「两个路径是不是同一个东西」的唯一依据。
 *
 * 纯函数，不触碰文件系统：它必须能对**尚不存在**的路径求值
 * （用户刚输入、还没校验的目录就要先查重），所以不能用 realpath。
 *
 * 这个函数存在的理由是一个很容易漏掉的脏数据来源：
 * 用户先添加 `D:\素材库\美食`，之后又添加 `D:\素材库\美食\`、
 * 或 `d:/素材库/美食`、或 `D:\素材库\.\美食`。
 * 这四种写法指向同一个目录，若不去重，扫描会跑四遍、
 * 素材表里会出现四份指向同一批文件的记录。
 */

/** 大小写是否不敏感。NTFS 不敏感，ext4/APFS 默认敏感——不要一刀切。 */
const CASE_INSENSITIVE = process.platform === 'win32'

/** 当前平台的 path 实现，用于借它的 normalize 处理 `.` / `..` / 重复分隔符。 */
const pathImpl = CASE_INSENSITIVE ? path.win32 : path.posix

/**
 * 把路径归一化成可比较的键。
 *
 * 注意返回值是**键**而不是可显示路径：它被转成了小写，
 * 因此只能用于比较与唯一约束，展示给用户时必须用原始路径。
 */
export function normalizePathKey(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return ''

  let normalized = pathImpl.normalize(trimmed)

  // 去掉尾部分隔符，但保留根目录本身（`C:\`、`/`）。
  // 判断依据是「去掉之后还剩不剩东西」，比数长度可靠。
  if (normalized.length > 1 && !isDriveRoot(normalized)) {
    normalized = normalized.replace(/[\\/]+$/, '')
  }

  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized
}

/** `C:\` 或 `C:` 这类驱动器根——尾部的 `\` 是它的组成部分，不能砍。 */
function isDriveRoot(value: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(value)
}

/**
 * 从完整路径取出文件名。
 *
 * 不直接用 `path.basename`：它按当前平台的规则切分，
 * 在一台机器上处理另一平台的路径（导入的素材清单）会切错。
 * 这里两种分隔符都认。
 */
export function fileNameOf(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 扩展名，统一转小写并带点（`.MP4` → `.mp4`）。无扩展名时返回空串。 */
export function extensionOf(filePath: string): string {
  const name = fileNameOf(filePath)
  const index = name.lastIndexOf('.')
  // 前导点的隐藏文件（`.gitignore`）不算扩展名
  if (index <= 0) return ''
  return name.slice(index).toLowerCase()
}

/**
 * 文件指纹：内容是否变化的判据。
 *
 * 用 size + mtime 而不是哈希文件内容——对一个几百 MB 的视频算哈希
 * 要让用户干等几十秒，而 size+mtime 在本机文件系统上足够可靠。
 * 代价是「大小与修改时间都没变但内容变了」这种极端情况会漏掉，
 * 这对素材检索场景可以接受。
 */
export function fingerprintOf(sizeBytes: number, mtimeMs: number): string {
  return `${sizeBytes}:${Math.floor(mtimeMs)}`
}
