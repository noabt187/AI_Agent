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
    '我在前端预览页面上对具体元素做了评论，请根据这些定位信息精细修改前端代码。',
    '',
    `操作目录：${root}`,
    '',
    blocks.join('\n\n'),
    '',
    '请先读取相关前端源码，结合 selector、可见文本、DOM 路径和评论内容定位实现位置，然后按现有流程输出需求分析让我确认。',
  ].join('\n')
}
