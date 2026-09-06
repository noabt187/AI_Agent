import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { loadAppConfig } from '../src/config/appConfig'

const { serverPort, webPort } = loadAppConfig()

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/plugins': `http://localhost:${serverPort}`,
    },
  },
})
