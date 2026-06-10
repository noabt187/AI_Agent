export type ElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type ElementComment = {
  id: string
  url: string
  tagName: string
  selector: string
  domPath: string
  text: string
  comment: string
  rect: ElementRect
}

export function buildAnnotationPrompt(comments: ElementComment[], operationRoot: string): string {
  const root = operationRoot.trim() || '未设置'
  const blocks = comments.map((item, index) => {
    return [
      `### 评论 ${index + 1}`,
      `url: ${item.url}`,
      `tag: ${item.tagName}`,
      `selector: ${item.selector}`,
      `domPath: ${item.domPath}`,
      `text: ${item.text || '(无可见文本)'}`,
      `rect: x=${item.rect.x}, y=${item.rect.y}, width=${item.rect.width}, height=${item.rect.height}`,
      `comment: ${item.comment}`,
    ].join('\n')
  })

  return [
    '我在前端预览页面上对具体元素做了评论。请把这些评论理解为完整功能需求的一部分，而不只是样式或单个前端元素修改。',
    '请根据定位信息找到相关实现，并按需求完整修改功能闭环：包括前端交互、状态管理、接口调用、后端接口/数据逻辑、错误处理和测试等实际需要改动的部分。',
    '如果评论只涉及视觉表现，可以只改前端；如果评论表达的是业务能力、数据流、权限、保存、提交、展示规则或跨页面行为，请主动检查并修改所有相关模块。',
    '',
    `操作目录：${root}`,
    '',
    blocks.join('\n\n'),
    '',
    '请先读取相关源码，结合 selector、可见文本、DOM 路径和评论内容定位实现位置，再追踪该功能涉及的组件、状态、API、服务端逻辑和测试。',
    '按现有流程先输出需求分析让我确认，需求分析里请说明你判断需要修改哪些层：仅前端、前后端联动、数据模型、测试或其他配套改动。',
  ].join('\n')
}
