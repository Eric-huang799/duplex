/**
 * 流式消息卡片的 React key。
 *
 * 背景（issue #4）：runtime 每次推送流式快照都会生成**新的** `ev.id`，
 * 而 `partID` 才是"同一条消息"的稳定身份。用 `ev.id` 当 key 会让 React
 * 每帧卸载重建组件——展开的工具卡自动收起、思考块闪断、整段 Markdown
 * 重新解析。所以 key 必须优先取 `partID`。
 *
 * 抽成纯函数是为了能被单测钉住：这条规则一旦被改回 `ev.id`，
 * 用户会立刻看到卡片闪动，但代码里没有任何报错。
 */
export interface MirrorKeySource {
  kind: string
  /** 标注事件的 id 是数字，其余是字符串，所以两者都要接受。 */
  id: string | number
  partID?: string
}

export function mirrorKey(ev: MirrorKeySource): string {
  const partID = typeof ev.partID === 'string' && ev.partID ? ev.partID : ''
  return partID ? `${ev.kind}:${partID}` : `${ev.kind}:${ev.id}`
}
