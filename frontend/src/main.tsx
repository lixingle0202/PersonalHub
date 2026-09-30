import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App'
import { bootstrapApi } from './api/client'
import { loadAppearance } from './app/theme'
import './styles.css'

async function start() {
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  try {
    await Promise.all([bootstrapApi(), loadAppearance()])
    root.render(
      <React.StrictMode>
        <BrowserRouter><App /></BrowserRouter>
      </React.StrictMode>,
    )
  } catch (error) {
    root.render(<main className="startup-error"><h1>无法启动 PersonalHub</h1><p>{error instanceof Error ? error.message : '本地数据服务不可用'}</p></main>)
  }
}

void start()
