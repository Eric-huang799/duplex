/**
 * Converts the shared MCP tool definitions into OpenAI-compatible
 * function-calling schemas for the built-in agent mode.
 */
import { z } from 'zod'
import { toolDefs } from '../../shared/tools'

export interface OpenAiTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * @param isAvailable 可选过滤：功能插件被禁用时，它的工具不应再出现在模型
 *   的 tools 列表里（否则模型会反复调用一个必然失败的工具）。
 */
export function buildOpenAiTools(isAvailable?: (name: string) => boolean): OpenAiTool[] {
  return toolDefs.filter((def) => !isAvailable || isAvailable(def.name)).map((def) => {
    let parameters: Record<string, unknown>
    try {
      parameters = z.toJSONSchema(z.object(def.input), { io: 'input' }) as Record<
        string,
        unknown
      >
    } catch (e) {
      console.error(`[agent] failed to build the JSON schema for tool "${def.name}":`, e)
      parameters = { type: 'object', properties: {} }
    }
    // some gateways reject the $schema key
    delete parameters.$schema
    return {
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters
      }
    }
  })
}
