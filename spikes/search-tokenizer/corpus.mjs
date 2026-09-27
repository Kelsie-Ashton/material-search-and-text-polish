// 生成用于检索实验的中文语料。
//
// 目标是让**字符分布**与**词语重复度**接近真实的中文字幕/转写文本，
// 因为索引体积主要由三元组的重复率决定。语料是合成的，
// 但召回行为（哪种分词能命中哪个查询）与数据无关，是确定性的。

/** 固定种子的 PRNG，保证每次跑出同一份语料。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 词汇表：混入内容创作领域的高频词，使语料贴近本项目的真实场景。
const WORDS = [
  // 美食
  '美食', '味道', '口感', '菜品', '招牌', '食材', '厨房', '香气', '甜品', '火锅',
  '烧烤', '小吃', '外卖', '早餐', '午餐', '晚餐', '餐厅', '菜单', '分量', '汤汁',
  // 内容创作
  '镜头', '画面', '剪辑', '配音', '字幕', '转场', '特效', '素材', '文案', '封面',
  '标题', '节奏', '背景音乐', '拍摄', '运镜', '调色', '后期', '导演', '剧本', '分镜',
  '剪辑师', '分身镜', '转场效果', '拍摄手法', '旁白', '收音', '打光', '布景', '机位', '构图',
  // 旅行
  '旅行', '风景', '景点', '民宿', '酒店', '攻略', '路线', '城市', '海边', '山顶',
  '日出', '日落', '古镇', '门票', '行程', '自驾', '徒步', '露营', '夜市', '老街',
  // 人物 / 场景
  '采访', '嘉宾', '主持', '观众', '粉丝', '团队', '老板', '店主', '师傅', '路人',
  '探店', '试吃', '测评', '开箱', '教程', '分享', '推荐', '踩雷', '打卡', '排队',
  // 通用
  '今天', '我们', '这个', '那个', '什么', '怎么', '可以', '非常', '特别', '真的',
  '觉得', '因为', '所以', '但是', '如果', '已经', '还有', '就是', '一个', '时候',
  '地方', '问题', '东西', '时间', '感觉', '样子', '事情', '大家', '朋友', '生活',
  '工作', '喜欢', '需要', '发现', '开始', '结束', '注意', '简单', '重要', '不错',
]

// 单字虚词，让语料更像自然语句而不是词语堆砌
const PARTICLES = ['的', '了', '是', '在', '和', '就', '都', '也', '很', '有', '我', '你', '他', '她', '它', '们', '不', '这', '那', '会', '要', '把', '被', '给', '对', '从', '到', '而', '与', '或']

const PUNCT = ['，', '，', '，', '。', '、', '；', '！', '？']

/**
 * 待测查询。
 *
 * 选取依据是「用户真的会这样搜」：
 *   两字词 —— 中文检索最主要的形态
 *   三字词 —— 检验词典未收录时的表现
 *   四字词 —— 对照组
 * 全部都是内容创作场景里的常见说法。
 */
export const QUERIES = [
  { term: '美食', chars: 2 },
  { term: '探店', chars: 2 },
  { term: '剪辑', chars: 2 },
  { term: '配音', chars: 2 },
  { term: '镜头', chars: 2 },
  { term: '火锅', chars: 2 },
  { term: '剪辑师', chars: 3 },
  { term: '分身镜', chars: 3 },
  { term: '转场效果', chars: 4 },
  { term: '拍摄手法', chars: 4 },
  { term: '背景音乐', chars: 4 },
]

/**
 * 生成语料。
 *
 * @returns {{ segments: string[], groundTruth: Map<string, Set<number>>, totalChars: number }}
 */
export function buildCorpus({ segmentCount, seed = 20260927 }) {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]

  // 按权重抽样词语：排名越靠前出现越频繁，模拟 Zipf 分布。
  // 真实文本里少数高频词占据大部分篇幅，这一点直接决定三元组的重复率。
  const weighted = []
  for (let i = 0; i < WORDS.length; i += 1) {
    const weight = Math.max(1, Math.round(40 / Math.sqrt(i + 1)))
    for (let k = 0; k < weight; k += 1) weighted.push(WORDS[i])
  }

  const segments = []
  const groundTruth = new Map(QUERIES.map((q) => [q.term, new Set()]))
  let totalChars = 0

  for (let index = 0; index < segmentCount; index += 1) {
    const sentenceCount = 1 + Math.floor(random() * 2)
    const parts = []

    for (let s = 0; s < sentenceCount; s += 1) {
      const wordCount = 6 + Math.floor(random() * 10)
      for (let w = 0; w < wordCount; w += 1) {
        parts.push(random() < 0.28 ? pick(PARTICLES) : pick(weighted))
      }
      parts.push(random() < 0.15 ? pick(PUNCT) : '。')
    }

    const text = parts.join('')
    segments.push(text)
    totalChars += text.length

    for (const query of QUERIES) {
      if (text.includes(query.term)) groundTruth.get(query.term).add(index)
    }
  }

  return { segments, groundTruth, totalChars }
}
