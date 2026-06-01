const ANNOTATOR_SCRIPT = `
(() => {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'border:2px solid #155eef',
    'background:rgba(21,94,239,0.12)',
    'border-radius:4px',
    'display:none'
  ].join(';');
  document.documentElement.appendChild(overlay);

  let active = false;

  function selectorFor(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      if (current.classList && current.classList.length > 0) {
        part += '.' + Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join('.');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  }

  function domPathFor(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      parts.unshift(current.localName);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function describe(element) {
    const rect = element.getBoundingClientRect();
    return {
      url: location.href,
      tagName: element.localName,
      selector: selectorFor(element),
      domPath: domPathFor(element),
      text: (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function showOverlay(element) {
    if (!active || !element || element === overlay || element === document.documentElement || element === document.body) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'agent-annotator-set-active') return;
    active = Boolean(event.data.active);
    document.documentElement.toggleAttribute('data-agent-annotator-active', active);
    if (!active) overlay.style.display = 'none';
  });

  document.addEventListener('mouseover', (event) => {
    if (!active) return;
    showOverlay(event.target);
  }, true);

  document.addEventListener('click', (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({ type: 'agent-element-selected', payload: describe(event.target) }, '*');
  }, true);
})();
`

export function assertPreviewUrl(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http 或 https 预览地址')
  }
  return url
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildPreviewHtml(html: string, targetUrl: string): string {
  const baseTag = `<base href="${htmlEscape(targetUrl)}">`
  const scriptTag = `<script>${ANNOTATOR_SCRIPT}</script>`
  const withBase = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    : `${baseTag}${html}`

  if (/<\/body>/i.test(withBase)) {
    return withBase.replace(/<\/body>/i, `${scriptTag}</body>`)
  }
  return `${withBase}${scriptTag}`
}
