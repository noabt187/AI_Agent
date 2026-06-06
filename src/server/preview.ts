const ANNOTATOR_SCRIPT = `
(() => {
  const style = document.createElement('style');
  style.textContent = \`
    @keyframes agentAnnotatorPulse {
      0%, 100% {
        transform: scale(1);
        opacity: 0.48;
      }
      50% {
        transform: scale(1.09);
        opacity: 0.18;
      }
    }

    @keyframes agentAnnotatorFloat {
      0%, 100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(-2px);
      }
    }

    @keyframes agentAnnotatorOrbit {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  \`;
  document.documentElement.appendChild(style);

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'border:2px solid #8aa982',
    'background:rgba(194,222,203,0.18)',
    'border-radius:4px',
    'display:none'
  ].join(';');
  document.documentElement.appendChild(overlay);

  const bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.setAttribute('data-agent-annotator-ui', 'bubble');
  bubble.setAttribute('aria-label', '开启评论模式');
  bubble.style.cssText = [
    'position:fixed',
    'left:calc(20vw - 38px)',
    'top:calc(20vh - 38px)',
    'z-index:2147483647',
    'width:76px',
    'height:76px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:0',
    'border:1px solid rgba(164,196,157,0.42)',
    'border-radius:999px',
    'background:linear-gradient(180deg, rgba(221,239,224,0.78), rgba(109,137,112,0.62))',
    'backdrop-filter:blur(18px)',
    'box-shadow:0 18px 42px rgba(71,93,75,0.24), inset 0 0 0 1px rgba(255,255,255,0.24)',
    'overflow:visible',
    'cursor:grab',
    'user-select:none',
    '-webkit-user-select:none',
    'touch-action:none'
  ].join(';');

  const bubbleRing = document.createElement('span');
  bubbleRing.style.cssText = [
    'position:absolute',
    'inset:-7px',
    'border-radius:999px',
    'border:1px solid rgba(191,223,197,0.48)',
    'box-shadow:0 0 28px rgba(154,194,166,0.22), inset 0 0 14px rgba(221,239,224,0.18)',
    'pointer-events:none',
    'animation:agentAnnotatorPulse 2.8s ease-in-out infinite'
  ].join(';');

  const bubbleCore = document.createElement('span');
  bubbleCore.style.cssText = [
    'position:absolute',
    'inset:7px',
    'border-radius:999px',
    'background:radial-gradient(circle at 28% 24%, rgba(255,255,255,0.72), rgba(241,248,239,0.34) 24%, rgba(188,220,197,0.34) 48%, rgba(92,121,96,0.68) 100%)',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,0.42), inset 0 -16px 24px rgba(76,101,80,0.22)',
    'pointer-events:none'
  ].join(';');

  const bubbleGlow = document.createElement('span');
  bubbleGlow.style.cssText = [
    'position:absolute',
    'inset:16px',
    'border-radius:999px',
    'background:radial-gradient(circle, rgba(221,239,224,0.9), rgba(142,179,148,0.2) 65%, rgba(142,179,148,0) 100%)',
    'filter:blur(7px)',
    'opacity:0.72',
    'pointer-events:none'
  ].join(';');

  const bubbleContent = document.createElement('span');
  bubbleContent.style.cssText = [
    'position:relative',
    'z-index:1',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:3px',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    'animation:agentAnnotatorFloat 3.4s ease-in-out infinite'
  ].join(';');

  const bubbleIcon = document.createElement('span');
  bubbleIcon.style.cssText = [
    'color:#f7fff6',
    'font:700 16px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'text-shadow:0 0 14px rgba(180,216,188,0.58)'
  ].join(';');

  const bubbleLabel = document.createElement('span');
  bubbleLabel.style.cssText = [
    'color:#f3fbef',
    'font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'letter-spacing:0.08em',
    'text-transform:uppercase',
    'text-shadow:0 0 12px rgba(128,164,134,0.34)'
  ].join(';');

  const bubbleStatusOrbit = document.createElement('span');
  bubbleStatusOrbit.style.cssText = [
    'position:absolute',
    'inset:-9px',
    'border-radius:999px',
    'pointer-events:none'
  ].join(';');

  const bubbleStatus = document.createElement('span');
  bubbleStatus.style.cssText = [
    'position:absolute',
    'top:2px',
    'left:50%',
    'transform:translateX(-50%)',
    'width:8px',
    'height:8px',
    'border-radius:999px',
    'background:#c8e6c9',
    'box-shadow:0 0 0 3px rgba(200,230,201,0.18), 0 0 14px rgba(136,171,142,0.44)',
    'pointer-events:none'
  ].join(';');

  bubbleContent.appendChild(bubbleIcon);
  bubbleContent.appendChild(bubbleLabel);
  bubble.appendChild(bubbleRing);
  bubble.appendChild(bubbleCore);
  bubble.appendChild(bubbleGlow);
  bubble.appendChild(bubbleContent);
  bubbleStatusOrbit.appendChild(bubbleStatus);
  bubble.appendChild(bubbleStatusOrbit);
  document.documentElement.appendChild(bubble);

  let active = false;
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginLeft = 0;
  let dragOriginTop = 0;
  let dragMoved = false;

  function isAnnotatorUi(element) {
    return element instanceof Element && Boolean(element.closest('[data-agent-annotator-ui]'));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function applyBubbleState() {
    bubbleIcon.textContent = active ? '◎' : '✦';
    bubbleLabel.textContent = active ? '停止' : '评注';
    bubble.setAttribute('aria-label', active ? '结束评论模式' : '开启评论模式');
    bubble.style.background = active
      ? 'linear-gradient(180deg, rgba(203,232,210,0.86), rgba(82,124,91,0.72))'
      : 'linear-gradient(180deg, rgba(221,239,224,0.78), rgba(109,137,112,0.62))';
    bubble.style.boxShadow = active
      ? '0 20px 46px rgba(76,121,83,0.28), inset 0 0 0 1px rgba(255,255,255,0.28)'
      : '0 18px 42px rgba(71,93,75,0.24), inset 0 0 0 1px rgba(255,255,255,0.24)';
    bubble.style.borderColor = active ? 'rgba(143,184,150,0.52)' : 'rgba(164,196,157,0.42)';
    bubbleRing.style.borderColor = active ? 'rgba(176,215,184,0.58)' : 'rgba(191,223,197,0.48)';
    bubbleRing.style.boxShadow = active
      ? '0 0 32px rgba(154,194,166,0.3), inset 0 0 18px rgba(221,239,224,0.22)'
      : '0 0 28px rgba(154,194,166,0.22), inset 0 0 14px rgba(221,239,224,0.18)';
    bubbleGlow.style.background = active
      ? 'radial-gradient(circle, rgba(211,238,216,0.94), rgba(118,161,127,0.24) 65%, rgba(118,161,127,0) 100%)'
      : 'radial-gradient(circle, rgba(221,239,224,0.9), rgba(142,179,148,0.2) 65%, rgba(142,179,148,0) 100%)';
    bubbleStatus.style.background = active ? '#a8d5ad' : '#c8e6c9';
    bubbleStatus.style.boxShadow = active
      ? '0 0 0 3px rgba(168,213,173,0.2), 0 0 16px rgba(113,158,122,0.5)'
      : '0 0 0 3px rgba(200,230,201,0.18), 0 0 14px rgba(136,171,142,0.44)';
    bubbleStatusOrbit.style.animation = active ? 'agentAnnotatorOrbit 2.8s linear infinite' : 'none';
    bubbleStatusOrbit.style.opacity = active ? '1' : '0';
  }

  function notifyActiveChanged() {
    window.parent.postMessage({ type: 'agent-annotator-active-changed', active }, '*');
  }

  function setActive(nextActive) {
    active = Boolean(nextActive);
    document.documentElement.toggleAttribute('data-agent-annotator-active', active);
    if (!active) overlay.style.display = 'none';
    applyBubbleState();
    notifyActiveChanged();
  }

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
    if (!active || !element || element === overlay || element === document.documentElement || element === document.body || isAnnotatorUi(element)) {
      overlay.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'agent-annotator-set-active') return;
    setActive(event.data.active);
  });

  document.addEventListener('mouseover', (event) => {
    if (!active) return;
    showOverlay(event.target);
  }, true);

  document.addEventListener('click', (event) => {
    if (!active) return;
    if (isAnnotatorUi(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({ type: 'agent-element-selected', payload: describe(event.target) }, '*');
  }, true);

  bubble.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragOriginLeft = bubble.offsetLeft;
    dragOriginTop = bubble.offsetTop;
    dragMoved = false;
    bubble.style.cursor = 'grabbing';
    bubble.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

  bubble.addEventListener('pointermove', (event) => {
    if (dragPointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    if (!dragMoved && Math.abs(deltaX) + Math.abs(deltaY) > 4) {
      dragMoved = true;
    }
    if (!dragMoved) return;
    const maxLeft = Math.max(window.innerWidth - bubble.offsetWidth - 8, 8);
    const maxTop = Math.max(window.innerHeight - bubble.offsetHeight - 8, 8);
    bubble.style.left = clamp(dragOriginLeft + deltaX, 8, maxLeft) + 'px';
    bubble.style.top = clamp(dragOriginTop + deltaY, 8, maxTop) + 'px';
  });

  bubble.addEventListener('pointerup', (event) => {
    if (dragPointerId !== event.pointerId) return;
    bubble.releasePointerCapture(event.pointerId);
    bubble.style.cursor = 'grab';
    dragPointerId = null;
    event.preventDefault();
    event.stopPropagation();
    if (!dragMoved) {
      setActive(!active);
    }
  });

  bubble.addEventListener('pointercancel', (event) => {
    if (dragPointerId !== event.pointerId) return;
    bubble.style.cursor = 'grab';
    dragPointerId = null;
    dragMoved = false;
  });

  bubble.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  applyBubbleState();
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
