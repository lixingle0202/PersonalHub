import { useEffect } from 'react'

export function useSearchHighlight(id: string | null, ready: boolean) {
  useEffect(() => {
    if (!id || !ready) return
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }), 50)
    return () => window.clearTimeout(timer)
  }, [id, ready])
}
