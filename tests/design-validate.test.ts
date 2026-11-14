import { describe, expect, it } from 'vitest'
import {
  validateApplyPayload,
  validateChooseVariantPayload,
  validateConstraintInput,
  validatePatchOps,
  validateProjectId,
  validateResolveConstraint,
  validateSetVariantsPayload
} from '../src/main/design/validate'

describe('validate：IPC 入参白名单（拒绝原型污染 / 任意对象）', () => {
  it('合法 apply 载荷被逐层重建，未知字段不接受', () => {
    const result = validateApplyPayload({
      actor: 'user',
      allowLocked: true,
      ops: [
        { op: 'insert', parentId: 'root', node: { id: 'hero', type: 'box', children: [] } },
        { op: 'update', targetId: 'hero', patch: { text: '标题' } },
        { op: 'token', name: 'color', key: 'brand.primary', value: '#000' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.actor).toBe('user')
    expect(result.value.allowLocked).toBe(true)
    expect(result.value.ops).toHaveLength(3)
    expect(result.value.ops[0].op).toBe('insert')
  })

  it('多余字段、未知 op、非法节点 type 都被拒绝', () => {
    expect(
      validateApplyPayload({ actor: 'user', ops: [], extra: true }).ok
    ).toBe(false)
    expect(
      validateApplyPayload({ actor: 'user', ops: [{ op: 'drop-table', targetId: 'x' }] }).ok
    ).toBe(false)
    expect(
      validatePatchOps([{ op: 'insert', parentId: 'root', node: { id: 'x', type: 'video' } }]).ok
    ).toBe(false)
    // 非容器节点不能带孩子
    expect(
      validatePatchOps([
        { op: 'insert', parentId: 'root', node: { id: 't', type: 'text', children: [] } }
      ]).ok
    ).toBe(false)
  })

  it('拒绝 __proto__ / constructor 等原型污染形状的 key', () => {
    const payload = JSON.parse(
      '{"actor":"user","ops":[{"op":"remove","targetId":"x","__proto__":{"polluted":true}}]}'
    ) as unknown
    expect(validateApplyPayload(payload).ok).toBe(false)
    // 对象自身的 constructor 字段同样不被接受
    expect(
      validateApplyPayload(
        JSON.parse('{"actor":"user","ops":[{"op":"remove","targetId":"x","constructor":"evil"}]}')
      ).ok
    ).toBe(false)
  })

  it('项目 id：拒绝路径穿越、空串、Windows 保留名', () => {
    expect(validateProjectId('site-1').ok).toBe(true)
    expect(validateProjectId('../etc').ok).toBe(false)
    expect(validateProjectId('a/b').ok).toBe(false)
    expect(validateProjectId('').ok).toBe(false)
    expect(validateProjectId('CON').ok).toBe(false)
    expect(validateProjectId('.hidden').ok).toBe(false)
  })

  it('约束：move 必须带 target；resolve 的 status 只接受两个值', () => {
    expect(
      validateConstraintInput({ kind: 'move', targetId: 'root', createdBy: 'user' }).ok
    ).toBe(false)
    expect(
      validateConstraintInput({
        kind: 'move',
        targetId: 'root',
        createdBy: 'user',
        target: { anchor: 'center', point: { x: 1, y: 2 }, frameWidth: 1440 }
      }).ok
    ).toBe(true)
    expect(
      validateResolveConstraint({ action: 'resolve', id: 'c1', status: 'satisfied' }).ok
    ).toBe(true)
    expect(validateResolveConstraint({ id: 'c1', status: 'done' }).ok).toBe(false)
  })

  it('变体参数：空候选与非法下标被拒绝', () => {
    expect(validateSetVariantsPayload({ blockId: 'hero', options: [] }).ok).toBe(false)
    expect(
      validateSetVariantsPayload({ blockId: 'hero', options: [{ id: 'v1', type: 'box' }] }).ok
    ).toBe(true)
    expect(validateChooseVariantPayload({ blockId: 'hero', index: -1 }).ok).toBe(false)
    expect(validateChooseVariantPayload({ blockId: 'hero', index: 1.5 }).ok).toBe(false)
  })
})
