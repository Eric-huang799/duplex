/**
 * 新手预置任务：装上就知道能让 AI 干什么，点一下就把指令发给 agent。
 *
 * 纯数据 + 纯函数，不依赖 Electron / DOM；面板只负责渲染和发送。
 * 每条 prompt 都带同一段安全约束：先 snapshot 观察，提交/发送/下单前停下等用户确认。
 */

export interface Playbook {
  id: string
  category: string
  title: { zh: string; en: string }
  /** 真正发给 agent 的指令：必须自带"先观察再动手"的约束 */
  prompt: { zh: string; en: string }
  etaMinutes: number
}

/** 所有预置任务共享的安全尾巴。 */
const SAFETY_ZH =
  '每一步操作前先用 browser_snapshot 观察当前页面，看清结构再动手，不要凭猜测点击。任何提交、发送、下单、付款、报名、删除或修改账号的动作前必须停下，先说明将要做什么并等我明确确认；没有确认不得继续。'

const SAFETY_EN =
  'Before every action, use browser_snapshot to inspect the current page instead of guessing. Stop before any submit, send, order, payment, application, delete, or account change, explain what you are about to do, and wait for my explicit confirmation; do not continue without it.'

/** 类别 id → 中英文显示名（id 稳定，展示名随语言切换）。 */
const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  shopping: { zh: '购物与比价', en: 'Shopping & price checks' },
  research: { zh: '信息整理与研究', en: 'Research & synthesis' },
  forms: { zh: '表单与填写', en: 'Forms & filling' },
  planning: { zh: '行程与会议', en: 'Travel & scheduling' },
  writing: { zh: '写作与沟通', en: 'Writing & communication' },
  career: { zh: '求职', en: 'Job search' }
}

function withSafety(zh: string, en: string): Playbook['prompt'] {
  return {
    zh: `${zh}\n\n安全约束：${SAFETY_ZH}`,
    en: `${en}\n\nSafety: ${SAFETY_EN}`
  }
}

export const PLAYBOOKS: readonly Playbook[] = [
  {
    id: 'compare-products',
    category: 'shopping',
    title: { zh: '商品比价：同款横向对比', en: 'Compare product prices side by side' },
    prompt: withSafety(
      '打开京东（https://www.jd.com）搜索「无线降噪耳机」，在搜索结果页挑 5 个销量靠前的商品，逐个记录：到手价、评分、评论数、是否自营、发货与运费、主要卖点。把结果整理成 Markdown 对比表，并给出「同价位最值得买」的结论和理由。不要加入购物车，不要领券下单。',
      'Open JD.com (https://www.jd.com), search "wireless noise-cancelling headphones", pick the top 5 results by sales, and record for each: final price, rating, review count, self-operated or marketplace, shipping and fees, and key selling points. Put the results in a Markdown comparison table and conclude which is the best value in the same price range, with reasons. Do not add anything to the cart or place an order.'
    ),
    etaMinutes: 5
  },
  {
    id: 'page-to-table',
    category: 'research',
    title: { zh: '页面信息整理成表', en: 'Turn page info into a table' },
    prompt: withSafety(
      '把我当前标签页里的列表或表格信息整理成一张 Markdown 表：先识别页面上重复的数据结构，列出字段名，再按页面顺序逐项填写；缺失的值写「未标注」，不要猜。保留来源链接和整理时间。翻页可以继续读取，但不要点任何提交、删除或购买按钮。',
      'Turn the list or table on my current tab into a Markdown table: first identify the repeated data structure and its field names, then fill each row in page order; write "not stated" for missing values and never guess. Keep the source link and the time collected. You may read through pagination, but do not click submit, delete, or purchase buttons.'
    ),
    etaMinutes: 4
  },
  {
    id: 'fill-form-demo',
    category: 'forms',
    title: { zh: '用假数据填一张表单', en: 'Fill a form with dummy data' },
    prompt: withSafety(
      '打开一个公开的报名或问卷表单页面（如果当前标签页就是表单，直接用）。用以下假数据逐项填写：姓名「张三」、手机 13800000000、邮箱 zhangsan@example.com、公司「示例科技」、备注「这是一次测试填写」。字段对不上时先停下问我，不要套用我的真实信息。填完后把填写结果读给我看。',
      'Open a public sign-up or survey form (or use the form on the current tab). Fill it with this dummy data: name "Zhang San", phone 13800000000, email zhangsan@example.com, company "Example Tech", notes "this is a test entry". If a field does not match, stop and ask me instead of using my real information. After filling, read the completed values back to me.'
    ),
    etaMinutes: 4
  },
  {
    id: 'compare-meeting-times',
    category: 'planning',
    title: { zh: '比对跨时区会议时间', en: 'Compare meeting times across time zones' },
    prompt: withSafety(
      '打开一个跨时区会议时间工具（例如 https://www.timeanddate.com/worldclock/meeting.html），比较北京、伦敦、纽约三地在「下周三 15:00–17:00（北京时间）」附近的可用时段。列出每个候选时段三地的当地时间，以及是否落在 9:00–18:00 工作时间内，推荐一个重叠最好的时段。不要创建日历事件，不要发送邀请。',
      'Open a cross-time-zone meeting planner (e.g. https://www.timeanddate.com/worldclock/meeting.html) and compare slots near "next Wednesday 15:00–17:00 Beijing time" for Beijing, London, and New York. For each candidate, list the local time in all three places and whether it falls inside 9:00–18:00 working hours; recommend the best overlap. Do not create calendar events or send invitations.'
    ),
    etaMinutes: 4
  },
  {
    id: 'summarize-article',
    category: 'research',
    title: { zh: '长文摘要与要点', en: 'Summarize a long article' },
    prompt: withSafety(
      '打开我当前标签页里的长文（如果为空，就用我给的链接）。通读正文，输出：一句话结论、200 字以内的摘要、5 条关键要点、文中没有数据支撑或存在争议的说法。保留原文标题和 URL。遇到登录墙或付费墙就停在可见部分并说明，不要绕过。',
      'Open the long article on my current tab (or use the link I give you). Read the body and output: a one-sentence takeaway, a summary under 200 words, 5 key points, and any claims that lack data or are disputed. Keep the original title and URL. If you hit a login or paywall, stop at the visible part and say so; do not bypass it.'
    ),
    etaMinutes: 3
  },
  {
    id: 'compare-flights-hotels',
    category: 'planning',
    title: { zh: '机票 + 酒店比价', en: 'Compare flights and hotels' },
    prompt: withSafety(
      '打开 Google Flights（https://www.google.com/travel/flights）和 Google Hotels，查询 2026-12-01 上海到东京、2026-12-07 返程的往返机票，以及同一日期区间东京市中心、评分 4.0 以上的酒店。对比时把税费、行李额、取消政策算进去，输出机票和酒店各 3 个候选的 Markdown 表，并给出总价最低和综合最稳的两个方案。不要预订，不要填乘客信息，不要付款。',
      'Open Google Flights (https://www.google.com/travel/flights) and Google Hotels, then search round-trip Shanghai to Tokyo departing 2026-12-01 and returning 2026-12-07, plus hotels rated 4.0+ in central Tokyo for the same dates. Include taxes and fees, baggage allowance, and cancellation policy in the comparison. Output Markdown tables with 3 flight and 3 hotel candidates, and recommend both the cheapest total and the most reliable overall option. Do not book, enter passenger details, or pay.'
    ),
    etaMinutes: 8
  },
  {
    id: 'recipe-shopping-list',
    category: 'shopping',
    title: { zh: '从菜谱生成购物清单', en: 'Build a shopping list from a recipe' },
    prompt: withSafety(
      '打开一个公开的红烧肉菜谱页面（例如下厨房），按 4 人份提取全部食材和用量，合并重复项，换算成采购清单：食材、数量、单位、备注（例如「可选」）。按超市区域（肉禽、蔬菜、调料）分组，最后给出一份可勾选的 Markdown 清单。不要下单买菜，不要登录。',
      'Open a public braised-pork recipe page (e.g. Xiachufang), extract every ingredient and amount for 4 servings, merge duplicates, and turn it into a shopping list with ingredient, quantity, unit, and notes such as "optional". Group by supermarket section (meat, produce, seasonings) and finish with a checkable Markdown list. Do not order groceries or log in.'
    ),
    etaMinutes: 4
  },
  {
    id: 'paper-brief',
    category: 'research',
    title: { zh: '论文速览', en: 'Get a quick brief on a paper' },
    prompt: withSafety(
      '打开 arXiv 或 PubMed 上的一篇论文页面（优先用我当前标签页，否则搜索「browser agent」并挑一篇近两年的论文）。输出速览：研究问题、方法与数据、主要结果（带具体数字）、局限、以及一条我可能关心的启示。只读摘要和公开全文；遇到付费墙就只总结摘要并标注。保留论文标题、作者、年份和 DOI 或链接。',
      'Open a paper page on arXiv or PubMed (prefer my current tab; otherwise search "browser agent" and pick a paper from the last two years). Produce a brief: research question, method and data, main results with concrete numbers, limitations, and one takeaway I might care about. Read only the abstract and public full text; if paywalled, summarize the abstract and label it. Keep the title, authors, year, and DOI or link.'
    ),
    etaMinutes: 7
  },
  {
    id: 'draft-email',
    category: 'writing',
    title: { zh: '草拟一封邮件（先确认再发）', en: 'Draft an email (confirm before sending)' },
    prompt: withSafety(
      '打开我的网页邮箱，点「写邮件」，给 example@example.com 草拟一封邮件：主题「周五下午的评审会」，正文说明会议时间、地点和需要对方准备的三个材料，语气简洁礼貌。只填写收件人、主题和正文，逐字把完整草稿读给我看。**不要点击发送**：必须等我看到草稿后明确回复「确认发送」才能发；在此之前停在草稿页。',
      'Open my webmail, click "Compose", and draft an email to example@example.com with the subject "Friday afternoon review meeting", explaining the time, place, and three materials the recipient should prepare, in a concise and polite tone. Fill only the recipient, subject, and body, then read the complete draft back to me word for word. **Do not click Send**: wait until I have seen the draft and explicitly reply "confirm send"; until then, stay on the draft.'
    ),
    etaMinutes: 4
  },
  {
    id: 'filter-jobs',
    category: 'career',
    title: { zh: '按条件筛职位', en: 'Filter job listings' },
    prompt: withSafety(
      '打开一个招聘网站（例如 LinkedIn 或 BOSS 直聘），筛选「上海或远程、3–5 年经验、后端工程师」的岗位，取前 10 个结果，整理成表：公司、职位、薪资范围、技术栈、是否远程、链接。按匹配度排序，并标出我可能不满足的硬性要求。不要投递简历，不要给招聘者发消息，不要注册或登录；遇到登录墙就停在可见结果并告诉我。',
      'Open a job board (e.g. LinkedIn or BOSS Zhipin) and filter for "Shanghai or remote, 3–5 years experience, backend engineer". Take the top 10 results and put them in a table: company, title, salary range, tech stack, remote policy, and link. Rank by fit and flag hard requirements I may not meet. Do not submit applications, message recruiters, or sign up or log in; if you hit a login wall, stop at the visible results and tell me.'
    ),
    etaMinutes: 8
  }
]

/**
 * 按类别分组，类别顺序沿用 PLAYBOOKS 里第一次出现的顺序。
 * 每次调用都返回新数组，面板可以随意筛选/排序而不影响 PLAYBOOKS。
 */
export function playbooksByCategory(lang: 'zh' | 'en'): Array<{ category: string; items: Playbook[] }> {
  const key = lang === 'en' ? 'en' : 'zh'
  const groups: Array<{ category: string; items: Playbook[] }> = []
  const byId = new Map<string, { category: string; items: Playbook[] }>()

  for (const playbook of PLAYBOOKS) {
    let group = byId.get(playbook.category)
    if (!group) {
      const labels = CATEGORY_LABELS[playbook.category]
      group = { category: labels ? labels[key] : playbook.category, items: [] }
      byId.set(playbook.category, group)
      groups.push(group)
    }
    group.items.push(playbook)
  }

  return groups
}

/** 按 id 找一条预置任务；未知 id 返回 null（不抛错）。 */
export function findPlaybook(id: string): Playbook | null {
  if (!id) return null
  return PLAYBOOKS.find((playbook) => playbook.id === id) ?? null
}
