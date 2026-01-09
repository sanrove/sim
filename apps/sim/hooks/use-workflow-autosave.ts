import { useCallback, useEffect, useRef } from 'react'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { createLogger } from '@/lib/logs/console/logger'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'

const logger = createLogger('WorkflowAutoSave')

/**
 * Auto-saves workflow state to the database periodically or on change
 * This enables workflows to work even without the socket server running
 */
export function useWorkflowAutoSave(workflowId: string) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaveRef = useRef(0)
  const isSavingRef = useRef(false)

  const { blocks, edges, loops, parallels, isDeployed, deployedAt, deploymentStatuses } =
    useWorkflowStore()
  const { workflowValues } = useSubBlockStore()

  const saveWorkflowState = useCallback(async () => {
    if (isSavingRef.current) {
      logger.debug('Save already in progress, skipping')
      return
    }

    try {
      isSavingRef.current = true
      const now = Date.now()

      // Get subblock values for this workflow
      const subblockValues = workflowValues[workflowId] || {}

      // Merge subblock values into blocks
      const blocksWithValues = Object.entries(blocks).reduce(
        (acc, [blockId, block]) => {
          const blockSubblockValues = subblockValues[blockId] || {}
          const mergedSubBlocks = { ...block.subBlocks }

          // Update subblock values
          Object.entries(blockSubblockValues).forEach(([subblockId, value]) => {
            if (mergedSubBlocks[subblockId]) {
              mergedSubBlocks[subblockId] = {
                ...mergedSubBlocks[subblockId],
                value,
              }
            }
          })

          acc[blockId] = {
            ...block,
            subBlocks: mergedSubBlocks,
          }
          return acc
        },
        {} as typeof blocks
      )

      const state = {
        blocks: blocksWithValues,
        edges,
        loops: loops || {},
        parallels: parallels || {},
        lastSaved: now,
        isDeployed,
        deployedAt,
        deploymentStatuses: deploymentStatuses || {},
      }

      logger.info(`Saving workflow state to database: ${workflowId}`)

      const response = await fetch(`/api/workflows/${workflowId}/state`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(state),
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to save workflow state: ${response.status} ${error}`)
      }

      lastSaveRef.current = now
      logger.info(`Successfully saved workflow state: ${workflowId}`)

      // Update last saved timestamp in store
      useWorkflowStore.setState({ lastSaved: now })
    } catch (error) {
      logger.error('Failed to save workflow state:', error)
    } finally {
      isSavingRef.current = false
    }
  }, [
    workflowId,
    blocks,
    edges,
    loops,
    parallels,
    isDeployed,
    deployedAt,
    deploymentStatuses,
    workflowValues,
  ])

  // Debounced auto-save on changes
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    // Don't save if no blocks (empty workflow)
    if (Object.keys(blocks).length === 0) {
      return
    }

    // Debounce save by 2 seconds
    saveTimeoutRef.current = setTimeout(() => {
      saveWorkflowState()
    }, 2000)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [blocks, edges, loops, parallels, saveWorkflowState])

  // Save on unmount (when leaving the workflow)
  useEffect(() => {
    return () => {
      // Save immediately when unmounting if there are unsaved changes
      const timeSinceLastSave = Date.now() - lastSaveRef.current
      if (timeSinceLastSave > 1000 && Object.keys(blocks).length > 0) {
        logger.info('Saving workflow state on unmount')
        saveWorkflowState()
      }
    }
  }, [])

  return {
    saveWorkflowState,
    lastSave: lastSaveRef.current,
  }
}
