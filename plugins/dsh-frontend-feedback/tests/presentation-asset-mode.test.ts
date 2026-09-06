import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePresentationAssetMode } from '../src/client/presentation-asset-mode.ts'
import type { PresentationWorkspaceSummary } from '../src/presentation-workspace.ts'

const projectSummary: PresentationWorkspaceSummary = {
  available: true,
  workspacePath: 'D:\\project',
  manifest: {
    name: 'Deck',
    sourceRoot: '.pagecraft/presentations/deck',
    deck: '.pagecraft/presentations/deck/deck.json',
    theme: '.pagecraft/presentations/deck/theme.css',
    assets: 'public/pagecraft-assets',
    publicAssetBase: '/pagecraft-assets',
    editableFiles: [
      '.pagecraft/presentations/deck/deck.json',
      '.pagecraft/presentations/deck/theme.css',
    ],
  },
}

test('project image state wins even when a legacy presentation job still exists', () => {
  assert.equal(resolvePresentationAssetMode(projectSummary, 'presentation-legacy-1234'), 'project')
})

test('legacy image state is enabled only after the project API confirms no project exists', () => {
  const unavailable: PresentationWorkspaceSummary = {
    available: false,
    workspacePath: 'D:\\project',
    reason: 'missing manifest',
  }
  assert.equal(resolvePresentationAssetMode(unavailable, 'presentation-legacy-1234'), 'legacy')
  assert.equal(resolvePresentationAssetMode(unavailable, null), 'unavailable')
})

test('an incomplete project response never falls back to stale legacy bindings', () => {
  const incomplete: PresentationWorkspaceSummary = {
    available: true,
    workspacePath: 'D:\\project',
  }
  assert.equal(resolvePresentationAssetMode(incomplete, 'presentation-legacy-1234'), 'unavailable')
})
