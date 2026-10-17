import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { tauriApi } from './lib/tauri-api'
import './index.css'

// Tauri 分支：用 Rust 后端桥接替换 window.whichvideo。
// （Electron 由 preload 注入；本分支以 Tauri 为主，electron 版完整保留在 electron 分支。）
window.whichvideo = tauriApi

const container = document.getElementById('root')
if (!container) throw new Error('#root 容器不存在')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
