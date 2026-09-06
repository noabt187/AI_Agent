import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootBrowserPluginRuntime } from './plugins/runtime'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

void bootBrowserPluginRuntime().then((pluginRuntime) => {
  root.render(
    <StrictMode>
      <App pluginRuntime={pluginRuntime} />
    </StrictMode>,
  )
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  root.render(
    <main role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>AI Agent 插件启动失败</h1>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{message}</pre>
    </main>,
  )
})
