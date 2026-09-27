import tseslint from 'typescript-eslint'

/**
 * 「绝不删除用户文件」的自动化防线。
 *
 * 这条不变量在 library/ 里由注释声明，但注释拦不住任何人——
 * 包括改到一半顺手加一行 `fs.rmSync` 的我自己。用户把素材目录交给
 * 一个检索工具，工具的任何误操作都不该毁掉他的原始素材，
 * 所以这条约束必须由工具链强制，而不是靠代码评审记得住。
 *
 * 两段规则各管一种写法，缺一不可：
 *   - no-restricted-imports 管 `import { rm } from 'node:fs'`
 *   - no-restricted-syntax  管 `fs.rmSync(...)` 这类成员调用
 * 只写前者会漏掉最常见的那种写法。
 */

/** 被禁的文件删除 API 名字 */
const DESTRUCTIVE = ['rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync']

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'spikes/**'],
  },
  ...tseslint.configs.recommended,

  {
    rules: {
      // Express 的错误处理中间件**必须**是四参数函数，否则 Express
      // 根本不会把它当错误处理器——多出来的 `_next` 是签名要求，不是疏忽。
      // 前缀下划线是表达「我知道它没用，但必须在这儿」的通用约定。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // 只覆盖真正碰用户文件的模块。测试文件排除在外——
    // 它们本来就要清理自己造的临时目录。
    files: ['backend/src/library/**/*.ts'],
    ignores: ['backend/src/library/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              importNames: DESTRUCTIVE,
              message:
                '「移除目录」只清除索引，绝不删除磁盘上的原始文件。删除逻辑不属于本模块。',
            },
            {
              name: 'node:fs/promises',
              importNames: DESTRUCTIVE,
              message:
                '「移除目录」只清除索引，绝不删除磁盘上的原始文件。删除逻辑不属于本模块。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `MemberExpression[object.name='fs'][property.name=/^(${DESTRUCTIVE.join('|')})$/]`,
          message: '禁止在 library/ 内删除文件：移除目录只清索引，磁盘文件必须原样保留。',
        },
        {
          selector: `MemberExpression[object.property.name='promises'][property.name=/^(${DESTRUCTIVE.join('|')})$/]`,
          message: '禁止在 library/ 内删除文件：移除目录只清索引，磁盘文件必须原样保留。',
        },
      ],
    },
  },
)
