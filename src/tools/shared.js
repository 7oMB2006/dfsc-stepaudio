/** 工具共享小函数。 */

/** 去掉值为 undefined / null 的键，避免把空字段发给上游。 */
export function cleanParams(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/** 组装 MCP 文本结果（机器可读的 JSON 文本）。 */
export function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
