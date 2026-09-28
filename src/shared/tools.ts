/**
 * MCP tool definitions shared by the main process (executor) and the stdio
 * bridge (forwarder). The bridge uses these to answer tools/list without
 * needing the browser to be running.
 */
import { z } from 'zod'

export interface ToolDef {
  name: string
  description: string
  input: z.ZodRawShape
  /** Only exposed to the built-in agent; hidden from external MCP clients. */
  internal?: boolean
}

export const toolDefs: ToolDef[] = [
  {
    name: 'list_tabs',
    description:
      'List all open browser tabs (id, url, title, loading, active). The human sees the same tabs.',
    input: {}
  },
  {
    name: 'new_tab',
    description: 'Open a new tab in the browser, optionally navigating to a URL.',
    input: { url: z.string().optional().describe('URL to open; omit for a blank page') }
  },
  {
    name: 'close_tab',
    description: 'Close a tab by its id.',
    input: { tabId: z.number().describe('Tab id from list_tabs') }
  },
  {
    name: 'switch_tab',
    description: 'Bring a tab to the foreground so the human sees it.',
    input: { tabId: z.number().describe('Tab id from list_tabs') }
  },
  {
    name: 'navigate',
    description: 'Navigate a tab (default: active tab) to a URL.',
    input: {
      url: z.string().describe('Absolute URL, e.g. https://example.com'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'history',
    description: 'Go back, go forward, or reload in a tab.',
    input: {
      action: z.enum(['back', 'forward', 'reload']),
      tabId: z.number().optional()
    }
  },
  {
    name: 'snapshot',
    description:
      'Text snapshot of the page: compact DOM outline with [eN] refs for actionable/labeled elements. Use the refs with click/type. This is the primary way to "see" the page.',
    input: { tabId: z.number().optional() }
  },
  {
    name: 'get_html',
    description:
      'Get HTML source. Without selector: cleaned body HTML. With selector: outerHTML of the first match.',
    input: {
      selector: z.string().optional(),
      maxChars: z.number().optional().describe('Truncate to this many chars (default 40000)'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'query',
    description:
      'Query elements by CSS selector; returns details for each match (tag, id, classes, text, href, rect, visibility).',
    input: {
      selector: z.string(),
      limit: z.number().optional().describe('Max matches (default 20)'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'screenshot',
    description:
      'Take a PNG screenshot of the current tab. Returns an image (for vision-capable models).',
    input: {
      fullPage: z.boolean().optional().describe('Capture the full scrollable page (default false)'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'click',
    description:
      'Click an element, identified by a [ref] from snapshot (e.g. "e12") or a CSS selector.',
    input: {
      target: z.string().describe('ref like "e12" or CSS selector'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'type',
    description:
      'Type text into an input/textarea/contenteditable, by ref or CSS selector. Optionally press Enter after.',
    input: {
      target: z.string(),
      text: z.string(),
      clear: z.boolean().optional().describe('Clear existing value first (default true)'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'press',
    description: 'Press a key or combo (Enter, Escape, Tab, PageDown, Control+A, Shift+Tab, ...) in the page.',
    input: {
      key: z.string().describe('Single key or combo like "Control+A"'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'scroll',
    description:
      'Scroll the page by dx/dy pixels (positive dy = down, positive dx = right), or scroll an element into view when selector is given.',
    input: {
      dy: z.number().optional().describe('Pixels to scroll vertically (default 600)'),
      dx: z.number().optional().describe('Pixels to scroll horizontally (default 0)'),
      selector: z.string().optional().describe('Scroll this element into view instead'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'hover',
    description:
      'Move the mouse over an element (ref or CSS selector) to trigger hover menus/tooltips; the pointer stays there.',
    input: {
      target: z.string(),
      tabId: z.number().optional()
    }
  },
  {
    name: 'dblclick',
    description: 'Double-click an element by ref or CSS selector.',
    input: {
      target: z.string(),
      tabId: z.number().optional()
    }
  },
  {
    name: 'drag',
    description:
      'Drag from one point/element to another (refs or CSS selectors) using real mouse events.',
    input: {
      from: z.string().describe('Source element ref or CSS selector'),
      to: z.string().describe('Target element ref or CSS selector'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'select_option',
    description:
      'Select an option in a native <select> element by visible text or value. For custom dropdowns, click the trigger then click the option.',
    input: {
      target: z.string(),
      option: z.string().describe('Visible option text or value (exact or substring)'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'upload',
    description: 'Set files on an <input type="file"> element (absolute local file paths).',
    input: {
      target: z.string(),
      files: z.array(z.string()).describe('Absolute local file paths'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'wait',
    description:
      'Wait for time and/or page state. Provide ms, or selector (until it matches), or text (until the page contains it).',
    input: {
      ms: z.number().optional().describe('Wait this many milliseconds (max 30000)'),
      selector: z.string().optional().describe('Wait until this CSS selector matches'),
      text: z.string().optional().describe('Wait until the page contains this text'),
      timeout: z.number().optional().describe('Max wait for selector/text in ms (default 10000)'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'get_console',
    description: 'Read recent console messages of a tab (errors/warnings/logs) collected since load.',
    input: {
      limit: z.number().optional().describe('Max messages to return (default 50)'),
      clear: z.boolean().optional().describe('Clear the buffer after reading'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'search',
    description:
      'Search the web in a tab (default engine: baidu). Use for looking up information; use navigate for known URLs.',
    input: {
      query: z.string(),
      engine: z.enum(['baidu', 'bing', 'google']).optional(),
      tabId: z.number().optional()
    }
  },
  {
    name: 'annotation_mode',
    description:
      'Turn the human annotation mode on/off on a tab. When on, the human can draw a box/circle/arrow (or pick an element) and attach a question; the annotation is delivered to you as a structured text message.',
    input: {
      active: z.boolean().describe('true = enter annotation mode, false = exit'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'evaluate',
    description:
      'Run JavaScript in the page and return the JSON-serializable result. Powerful; prefer snapshot/query when possible.',
    input: {
      script: z.string().describe('JS expression or statements; use "return x" for a value'),
      tabId: z.number().optional()
    }
  },
  {
    name: 'read_skill',
    description:
      'Read the full SKILL.md of an installed skill. The system prompt lists available skills (name + description); call this when a task matches one, then follow its instructions.',
    input: {
      name: z.string().describe('Skill name or id, e.g. "docx" or "claude/docx"')
    },
    internal: true
  },
  {
    name: 'list_skill_files',
    description: 'List files bundled inside a skill directory (relative paths).',
    input: {
      name: z.string().describe('Skill name or id')
    },
    internal: true
  },
  {
    name: 'read_skill_file',
    description:
      'Read a text file bundled inside a skill directory (reference docs, templates, scripts).',
    input: {
      name: z.string().describe('Skill name or id'),
      path: z.string().describe('Relative path inside the skill directory')
    },
    internal: true
  },
  {
    name: 'run_skill_script',
    description:
      'Run a script bundled inside a skill directory (.js/.mjs/.py/.ps1/.cmd/.bat). The user must approve the exact command in a confirmation dialog before it runs.',
    input: {
      name: z.string().describe('Skill name or id'),
      script: z.string().describe('Relative path of the script inside the skill directory'),
      args: z.array(z.string()).optional().describe('Command-line arguments')
    },
    internal: true
  },
  {
    name: 'write_file',
    description:
      'Write a UTF-8 text file to disk (parent directories are created). Every write must be approved by the user in a confirmation dialog. Use it to save a script or document that a skill requires (then run it with run_command), or to save results.',
    input: {
      path: z.string().describe('Absolute file path to write'),
      content: z.string().describe('Full file content (UTF-8)')
    },
    internal: true
  },
  {
    name: 'run_command',
    description:
      'Run a shell command (cmd/PowerShell on Windows) and return its output (exit code + stdout/stderr). Every command must be approved by the user in a confirmation dialog. Use it to run scripts provided by a skill (set cwd to the skill directory) or scripts you created with write_file.',
    input: {
      command: z.string().describe('Full command line'),
      cwd: z.string().optional().describe('Working directory (defaults to the home directory)'),
      timeout_ms: z.number().optional().describe('Timeout in ms (default 120000, max 600000)')
    },
    internal: true
  }
]

export const toolNames = toolDefs.map((t) => t.name)
