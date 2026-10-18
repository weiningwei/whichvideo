import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { tauriApi } from './lib/tauri-api'
import './index.css'

// Rust 后端通过 Tauri invoke/listen 暴露为既有 WhichVideoApi 契约。
window.whichvideo = tauriApi

const container = document.getElementById('root')
if (!container) throw new Error('#root 容器不存在')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
