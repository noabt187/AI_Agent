import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePresentationAssetMode } from '../src/client/presentation-asset-mode.ts'
import type { PresentationWorkspaceSummary } from '../src/presentation-workspace.ts'

const PRESENTATION_ID = 'presentation-legacy-1234'

const projectSummary: PresentationWorkspaceSummary = {
  available: true,
  presentationId: PRESENTATION_ID,
  workspacePath: 'D:\\project',
  manifest: {
    presentationId: PRESENTATION_ID,
    name: 'Deck',
    entry: '.pagecraft/presentations/deck/render.html',
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
  assert.equal(resolvePresentationAssetMode(projectSummary, PRESENTATION_ID), 'project')
})

test('legacy image state is enabled only after the project API confirms no project exists', () => {
  const unavailable: PresentationWorkspaceSummary = {
    available: false,
    presentationId: PRESENTATION_ID,
    workspacePath: 'D:\\project',
    reason: 'missing manifest',
  }
  assert.equal(resolvePresentationAssetMode(unavailable, PRESENTATION_ID), 'legacy')
  assert.equal(resolvePresentationAssetMode(unavailable, null), 'unavailable')
})

test('an incomplete project response never falls back to stale legacy bindings', () => {
  const incomplete: PresentationWorkspaceSummary = {
    available: true,
    presentationId: PRESENTATION_ID,
    workspacePath: 'D:\\project',
  }
  assert.equal(resolvePresentationAssetMode(incomplete, PRESENTATION_ID), 'unavailable')
})

test('a workspace for another presentation can never be reused by the current preview', () => {
  assert.equal(resolvePresentationAssetMode(projectSummary, 'presentation-other-1234'), 'unavailable')
})
