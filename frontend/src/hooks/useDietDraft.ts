import { useEffect, useSyncExternalStore } from 'react'
import { dietDraftScope, getDietDraft, resumeDietGeneration, subscribeDietDraft } from '../api/dietDraft'

export function useDietDraft() {
  const scope = dietDraftScope()
  const draft = useSyncExternalStore(subscribeDietDraft, getDietDraft)
  useEffect(() => { resumeDietGeneration() }, [scope])
  return draft
}
