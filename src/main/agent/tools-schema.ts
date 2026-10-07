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

export function buildOpenAiTools(): OpenAiTool[] {
  return toolDefs.map((def) => {
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
