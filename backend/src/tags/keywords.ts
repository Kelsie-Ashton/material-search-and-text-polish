/**
 * 从一段正文里挑出候选关键词（任务 6.10）。
 *
 * ## 为什么要「候选」而不是自动打标签
 *
 * 自动给素材打标签看起来更省事，但它是**替你表达**——而标签的全部意义就是你
 * 用什么词去记这件事。打错了你还得去删，比不打更烦。所以这里只**建议**，
 * 由你挑。这也是这个模块叫 keywords 而不是 autoTag 的原因。
 *
 * ## 为什么不用分词库
 *
 * 中文分词要么带词典（jieba 那种，几十 MB，且把「火锅店」切成「火锅/店」），
 * 要么带模型。而本项目的检索用的就是**子串匹配**（trigram），根本不分词——
 * 引一个分词器进来，只会让「能搜到的」和「能当标签的」变成两套词汇表。
 *
 * 所以这里用一套经典的**新词发现**启发式，全部基于统计，不需要任何词典：
 *
 * 1. **频次**：只出现一两次的片段不值得当标签。
 * 2. **左右邻字的多样性**：这是最关键的一条。真正的词，它的左右邻居是
 *    多种多样的（「火锅店很好」「去火锅店」「火锅店老板」）；而一个长词的
 *    碎片，邻居几乎固定（「火锅店」里的「锅店」永远跟在「火」后面）。
 *    只看频次的话，「锅店」的频次和「火锅店」一样高，分不出来。
 * 3. **不选更长候选的子串**：既然选了「火锅店」，就不该再选它的碎片。
 *
 * 这三条都是几十行能写完的统计，跑一次几毫秒，而且**不联网、不下载**。
 *
 * ## 它挑不准是正常的
 *
 * 这终究是启发式，会挑出「就是」「这个」这类没信息量的片段，也可能漏掉
 * 真正想要的那个词。所以界面上它是**可勾选的建议**，不是既成事实；
 * 用户永远可以自己输入。
 */

/** 只出现这么多次以下的片段不考虑——一两次的多半是巧合 */
const MIN_FREQUENCY = 3

/** 左右邻居至少要有这么多种，才算「像词」。低于它就只是个碎片。 */
const MIN_NEIGHBOR_VARIETY = 2

/** 候选长度范围。一个字太泛（「我」「你」），五个字以上几乎不可能是一类词。 */
const MIN_LENGTH = 2
const MAX_LENGTH = 4

/** 计算邻居多样性时每个方向最多记这么多种，避免超长文本吃掉内存 */
const NEIGHBOR_CAP = 16

/**
 * 高频虚词与它们的组合。
 *
 * 这些片段在统计上完全像「词」（高频、邻居多样），但没有任何检索价值——
 * 用户不会用「就是」去搜素材。与其调参数，不如直接列出来，因为这份名单
 * **是可以读、可以改的**，而参数调出来的边界没人看得懂。
 */
const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这里', '那里', '这样', '那样',
  '什么', '怎么', '为什么', '因为', '所以', '但是', '可是', '如果', '就是', '还是', '或者',
  '已经', '可以', '应该', '可能', '没有', '不是', '不能', '不会', '一个', '一种', '一些',
  '这些', '那些', '自己', '大家', '现在', '时候', '地方', '东西', '事情', '问题', '感觉',
  '知道', '觉得', '看到', '听到', '出来', '起来', '过去', '过来', '下来', '一下', '一直',
  '而且', '然后', '于是', '虽然', '不过', '其实', '真的', '好像', '一定', '非常', '特别',
  '有点', '一点', '很多', '多少', '这么', '那么', '怎样', '如何', '以及', '还有',
  // 下面这些是「一个虚词 + 一个结构助词」的碎片。统计上它们和真词一模一样，
  // 但没有任何检索价值——没有人会拿「的话」去搜素材。
  '的话', '的人', '的事', '的时候', '那种', '这种', '只是', '就是', '而是', '不能',
])

const CJK = /[一-鿿㐀-䶿]/

/** 是不是清一色的中日韩汉字。拉丁词与数字不参与——它们本来就有空格/词边界。 */
function isCjkRun(text: string): boolean {
  for (const char of text) {
    if (!CJK.test(char)) return false
  }
  return text.length > 0
}

/**
 * 同一个字重复的片段（「啊啊」「嗯嗯」）。
 *
 * 它们在字幕里频次极高、邻居也杂，三条统计规则全都拦不住——但它们
 * 是语气词，不是词。**实测过**：高达那部剧场版里「啊啊」排进前七，
 * 还把真正有信息量的词挤掉了一个。
 */
function isRepetition(word: string): boolean {
  return [...word].every((char) => char === word[0])
}

interface Fragment {
  frequency: number
  left: Set<string>
  right: Set<string>
}

/**
 * 统计所有 2–4 字片段。
 *
 * 只统计**连续汉字串内部**的片段：跨越标点、空格或拉丁字母的片段不是词
 * （「会说it」这种），把它们算进来只会污染频次。
 */
function collectFragments(text: string): Map<string, Fragment> {
  const fragments = new Map<string, Fragment>()

  const bump = (key: string, side: 'left' | 'right', neighbor: string): void => {
    let entry = fragments.get(key)
    if (entry === undefined) {
      entry = { frequency: 0, left: new Set(), right: new Set() }
      fragments.set(key, entry)
    }
    const set = entry[side]
    if (set.size < NEIGHBOR_CAP) set.add(neighbor)
  }

  // 按非汉字字符切开，逐段处理
  for (const run of text.split(/[^一-鿿㐀-䶿]+/)) {
    if (!isCjkRun(run)) continue

    for (let start = 0; start < run.length; start++) {
      for (let length = MIN_LENGTH; length <= MAX_LENGTH; length++) {
        const end = start + length
        if (end > run.length) break

        const key = run.slice(start, end)
        const entry = fragments.get(key) ?? { frequency: 0, left: new Set(), right: new Set() }
        entry.frequency += 1
        fragments.set(key, entry)

        // 邻居记的是**紧挨着的那个字**，不是整段上下文。
        // 记整段的话，同一段文字里出现的同一个词会互相抵消掉多样性。
        const before = run[start - 1]
        const after = run[end]
        if (before !== undefined) bump(key, 'left', before)
        if (after !== undefined) bump(key, 'right', after)
      }
    }
  }

  return fragments
}

export interface KeywordCandidate {
  word: string
  /** 在正文里出现的次数，用于排序与让用户判断「这词真有代表性吗」 */
  frequency: number
}

/**
 * 从正文里挑候选关键词，按可信度从高到低。
 *
 * 返回空数组是完全正常的结果（例如正文太短，没有片段达到频次门槛）——
 * 这不是错误，只是没什么可建议的。
 */
export function extractKeywordCandidates(text: string, limit = 12): KeywordCandidate[] {
  const fragments = collectFragments(text)

  const eligible: KeywordCandidate[] = []
  for (const [word, fragment] of fragments) {
    if (fragment.frequency < MIN_FREQUENCY) continue
    if (STOPWORDS.has(word)) continue
    if (isRepetition(word)) continue
    // 两侧邻居都要够杂。只查一侧的话，「火锅店」的碎片「火锅」也能过——
    // 因为「火锅」左边的字很杂（这是它自己作为词的证据），但它右边的字
    // 几乎只有「店」。两侧一起看才把「火锅」和「火锅店」分开。
    if (fragment.left.size < MIN_NEIGHBOR_VARIETY) continue
    if (fragment.right.size < MIN_NEIGHBOR_VARIETY) continue
    eligible.push({ word, frequency: fragment.frequency })
  }

  // 频次高的优先；同样频次时**长的优先**——长的是更具体的那个词
  eligible.sort((a, b) => b.frequency - a.frequency || b.word.length - a.word.length)

  // 砍掉「更长候选的碎片」。
  //
  // 这一步是**实测逼出来的**：高达那部片子里，「阿姆罗」这个名字被拆成了
  // 「阿姆」和「姆罗」两条并列出现，而真正的「阿姆罗」根本不在列表里。
  // 原因不难理解——名字后面接的字花样很多，两半各自的左右邻居都够杂，
  // 三条统计规则全都放行。
  //
  // 判据用的是**容差**而不是「更长的一定要更常见」。实测数字：阿姆罗 57 次、
  // 阿姆 59 次——碎片天然会略多一点，因为它还包括了长词被标点或换行截断的
  // 那些场合。要求长词严格不低于碎片，就会在这种 3% 的差距上放行碎片，
  // 而那正是最常见的形态。
  //
  // 反过来，容差不能大到无脑砍短词：「火锅」在正文里既有「火锅」也有
  // 「火锅店」时，它的频次会明显高于「火锅店」，那它就是独立的词，该留下。
  const FRAGMENT_FREQUENCY_TOLERANCE = 0.8
  const isFragment = (candidate: KeywordCandidate): boolean =>
    eligible.some(
      (other) =>
        other.word.length > candidate.word.length &&
        other.word.includes(candidate.word) &&
        other.frequency >= candidate.frequency * FRAGMENT_FREQUENCY_TOLERANCE,
    )

  const picked: KeywordCandidate[] = []
  for (const candidate of eligible) {
    if (picked.length >= limit) break
    if (isFragment(candidate)) continue
    // 已经选了「火锅店」，就别再选「火锅」「锅店」——
    // 它们对用户来说是同一个意思，列三行只会让人以为有三个词
    const covered = picked.some(
      (chosen) =>
        chosen.word.includes(candidate.word) || candidate.word.includes(chosen.word),
    )
    if (covered) continue
    picked.push(candidate)
  }

  return picked
}
