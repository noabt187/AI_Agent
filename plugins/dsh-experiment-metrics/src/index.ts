export const name = 'experiment-metrics'

export function apply(): void {
  // All experiment state is private browser-local data. The host-side plugin
  // exists only so DSH can install and load the paired client view.
}

export * from './shared.ts'
