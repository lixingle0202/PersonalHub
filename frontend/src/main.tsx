import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App'
import { AuthenticationRequired, bootstrapApi } from './api/client'
import { AppearanceProvider, loadAppearance } from './app/theme'
import { PublicAuthPage } from './components/PublicAuthPage'
import './styles.css'

ConfigProvider.config({ holderRender: (children) => <AppearanceProvider>{children}</AppearanceProvider> })

async function start() {
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  try {
    await bootstrapApi()
    await loadAppearance()
    root.render(
      <React.StrictMode>
        <AppearanceProvider><BrowserRouter><App /></BrowserRouter></AppearanceProvider>
      </React.StrictMode>,
    )
  } catch (error) {
    root.render(error instanceof AuthenticationRequired
      ? <AppearanceProvider><ConfigProvider><PublicAuthPage desktop={error.desktopMode} /></ConfigProvider></AppearanceProvider>
      : <main className="startup-error"><h1>无法启动 PersonalHub</h1><p>{error instanceof Error ? error.message : '本地数据服务不可用'}</p></main>)
  }
}

void start()
