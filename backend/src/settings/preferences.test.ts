import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../db/index.js'
import { createTestDb } from '../test/temp-db.js'
import { readSettings, readTextScript, updateSettings } from './preferences.js'

/**
 * 偏好设置的测试。
 *
 * 「默认文本保存方式」看着只是一行配置，但它直接决定提取出的文字是简体还是繁体，
 * 而检索是按字符匹配的——存繁体、搜简体就是零结果，且**不会报任何错**。
 * 所以这里重点钉两件事：**写进去的值能被原样读出来**，
 * 以及**写坏的值不会被接受、更不会把已有的好值覆盖掉**。
 */

let db: Db

/** 直接看表里到底存了什么，不走 readSettings——避免「读写一起错」互相掩盖。 */
function rawRows(): Array<{ key: string; value: string }> {
  return db.prepare('SELECT key, value FROM app_settings ORDER BY key').all() as Array<{
    key: string
    value: string
  }>
}

beforeEach(() => {
  db = createTestDb()
})

afterEach(() => {
  db.close()
})

describe('读取偏好', () => {
  it('表里什么都没有时回落到简体', () => {
    // 首次运行就是这个状态：app_settings 表建好但一行都没有。
    // 这必须是**正常路径**，不能报错——否则全新安装一启动就是坏的。
    expect(readSettings(db)).toEqual({ textScript: 'simplified' })
    expect(readTextScript(db)).toBe('simplified')
  })

  it('存了无法识别的值时回落到默认，而不是原样返回', () => {
    // 手工改库、或未来版本写入了新枚举值而用户降级了版本，都会造成这种行。
    // 原样返回会让这个坏值一路流到提取逻辑里，然后在某处变成一个
    // 「两种都不是」的三不管分支。
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'text_script',
      'klingon',
      Date.now(),
    )

    expect(readTextScript(db)).toBe('simplified')
  })

  it('存了空字符串也回落到默认', () => {
    // 空串是最容易被忽略的坏值：`raw ?? default` 挡不住它（nullish 只挡 null/undefined）。
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'text_script',
      '',
      Date.now(),
    )

    expect(readTextScript(db)).toBe('simplified')
  })
})

describe('写入偏好', () => {
  it('改成繁体后能读回来', () => {
    const result = updateSettings(db, { textScript: 'traditional' })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.textScript).toBe('traditional')
    expect(readTextScript(db)).toBe('traditional')
  })

  it('真的落进了 app_settings 表', () => {
    // 断言到「表里那一行」而不是只断言接口返回值：
    // 只回显不落库是最容易写出的假实现，返回值一模一样，
    // 重启后偏好就丢了——而用户不会立刻发现。
    updateSettings(db, { textScript: 'traditional' })

    const rows = rawRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('text_script')
    expect(rows[0]?.value).toBe('traditional')
  })

  it('反复修改只留一行，不堆积历史', () => {
    // 键值表靠唯一键兜住重复插入。若哪天 upsert 被改成普通 INSERT，
    // 这里会变成 3 行，而读取时按 Map 取值，**取哪一行取决于返回顺序**，
    // 表现为「设置时好时坏」。
    updateSettings(db, { textScript: 'traditional' })
    updateSettings(db, { textScript: 'simplified' })
    updateSettings(db, { textScript: 'traditional' })

    expect(rawRows()).toHaveLength(1)
    expect(readTextScript(db)).toBe('traditional')
  })

  it('拒绝无法识别的值，并且不动已存的值', () => {
    updateSettings(db, { textScript: 'traditional' })

    const result = updateSettings(db, { textScript: 'klingon' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED')
      // 错误信息要指出是哪个字段——设置页有两组配置，笼统报「参数错误」没法定位
      expect(result.error.details?.['field']).toBe('textScript')
    }
    // 关键：拒绝之后原值必须还在。静默清空或写成默认值，
    // 都会让用户在毫无察觉的情况下改了保存字形。
    expect(readTextScript(db)).toBe('traditional')
  })

  it('拒绝非字符串类型', () => {
    for (const bad of [null, 42, true, {}, []]) {
      const result = updateSettings(db, { textScript: bad })
      expect(result.ok, `textScript=${JSON.stringify(bad)} 应当被拒绝`).toBe(false)
    }
    expect(rawRows()).toHaveLength(0)
  })

  it('不传字段时保持原值不变', () => {
    updateSettings(db, { textScript: 'traditional' })

    // 空 patch 是合法的：界面只改一项时不该被迫把其他项也发过来
    const result = updateSettings(db, {})

    expect(result.ok && result.value.textScript).toBe('traditional')
    expect(rawRows()).toHaveLength(1)
  })

  it('返回的是完整偏好，不只是改动的那一项', () => {
    // 设置页拿返回值整体刷新。只回显改动项的话，界面上一半新一半旧。
    const result = updateSettings(db, { textScript: 'traditional' })
    expect(result.ok && Object.keys(result.value)).toContain('textScript')
  })
})
