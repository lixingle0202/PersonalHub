import { Component, type ReactNode } from 'react'
import { ErrorPanel } from '../components/StatePanels'

const RELOAD_KEY_PREFIX = 'personalhub:page-reload:'
const RELOAD_COOLDOWN_MS = 10_000

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>

type RecoveryOptions = {
  reload?: () => void
  storage?: RecoveryStorage
  href?: () => string
  now?: () => number
}

function isPageAssetLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /failed to fetch dynamically imported module|importing a module script failed|loading chunk .* failed|chunkloaderror/i.test(message)
}

export async function loadPageModule<T>(loader: () => Promise<T>, options: RecoveryOptions = {}): Promise<T> {
  try {
    return await loader()
  } catch (error) {
    if (!isPageAssetLoadError(error)) throw error

    const reload = options.reload ?? (() => window.location.reload())
    const storage = options.storage ?? window.sessionStorage
    const href = (options.href ?? (() => window.location.href))()
    const now = (options.now ?? Date.now)()
    const reloadKey = `${RELOAD_KEY_PREFIX}${href}`
    const previousAttempt = Number(storage.getItem(reloadKey) ?? 0)

    if (!previousAttempt || now - previousAttempt > RELOAD_COOLDOWN_MS) {
      storage.setItem(reloadKey, String(now))
      reload()
      return await new Promise<T>(() => undefined)
    }

    throw error
  }
}

type BoundaryProps = { children: ReactNode; resetKey: string }
type BoundaryState = { error: unknown | null }

export class PageLoadErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error }
  }

  componentDidUpdate(previousProps: BoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return <ErrorPanel message="页面文件加载失败，请刷新到最新版本。" onRetry={() => window.location.reload()} />
    }
    return this.props.children
  }
}
