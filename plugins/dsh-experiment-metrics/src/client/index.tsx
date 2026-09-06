import { useEffect, useMemo, useState } from 'react'
import {
  EXPERIMENT_STORAGE_KEY,
  aggregateExperiments,
  compareExperiment,
  createExperiment,
  experimentsToCsv,
  normalizeTokenUsage,
  parseExperimentStore,
  serializeExperimentStore,
} from '../shared.ts'
import type { ArmOutcome, Experiment, ExperimentArm, TokenUsage } from '../shared.ts'

export const inject = ['slots', 'sessions']

interface SessionCatalogItem {
  id: string
  title: string
  cwd?: string
  running: boolean
  usage?: TokenUsage
}

interface ExperimentMetricsInjected {
  currentSessionId: string
  readSessions(): SessionCatalogItem[]
}

type ArmKey = 'control' | 'pagecraft'

const colors = {
  bg: '#0d1210',
  panel: '#121916',
  panel2: '#18211d',
  border: '#2b3d33',
  text: '#edf6f0',
  muted: '#9db0a3',
  accent: '#9fddb0',
  good: '#73d59a',
  bad: '#ef8c8c',
  warn: '#e5bd72',
}

function readStoredExperiments(): Experiment[] {
  try {
    return parseExperimentStore(window.localStorage.getItem(EXPERIMENT_STORAGE_KEY))
  } catch {
    return []
  }
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatRate(value: number | undefined): string {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}%`
}

function timestamp(value: number | undefined): string {
  return value === undefined ? '尚未记录' : new Date(value).toLocaleString('zh-CN')
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function numberFromInput(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function StatusPill({ outcome }: { outcome: ArmOutcome }) {
  const label = outcome === 'passed' ? '通过' : outcome === 'failed' ? '失败' : '待验收'
  const color = outcome === 'passed' ? colors.good : outcome === 'failed' ? colors.bad : colors.warn
  return <span style={{ ...styles.pill, color }}>{label}</span>
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={{ ...styles.metricValue, ...(tone ? { color: tone } : {}) }}>{value}</strong>
    </div>
  )
}

interface ArmPanelProps {
  armKey: ArmKey
  arm: ExperimentArm
  sessions: SessionCatalogItem[]
  onChange(next: ExperimentArm): void
  onRecord(kind: 'start' | 'end'): void
}

function ArmPanel({ armKey, arm, sessions, onChange, onRecord }: ArmPanelProps) {
  const metrics = arm.startUsage && arm.endUsage
    ? {
        input: Math.max(0, arm.endUsage.uncachedInputTokens - arm.startUsage.uncachedInputTokens)
          + Math.max(0, arm.endUsage.cacheReadTokens - arm.startUsage.cacheReadTokens)
          + Math.max(0, arm.endUsage.cacheWriteTokens - arm.startUsage.cacheWriteTokens),
        output: Math.max(0, arm.endUsage.outputTokens - arm.startUsage.outputTokens),
      }
    : undefined
  const title = armKey === 'control' ? 'Control · 普通工作流' : 'PageCraft · 精准评注工作流'
  return (
    <section style={styles.armPanel}>
      <div style={styles.sectionHeader}>
        <div>
          <strong>{title}</strong>
          <span style={styles.sectionHint}>独立会话 · 相同任务 · 相同模型</span>
        </div>
        <StatusPill outcome={arm.outcome} />
      </div>

      <label style={styles.label}>绑定会话</label>
      <select
        value={arm.sessionId}
        onChange={event => onChange({ ...arm, sessionId: event.target.value })}
        style={styles.input}
      >
        <option value="">请选择会话</option>
        {sessions.map(session => (
          <option key={session.id} value={session.id}>
            {session.running ? '● ' : ''}{session.title} · {session.id.slice(0, 8)}
          </option>
        ))}
      </select>

      <div style={styles.snapshotGrid}>
        <div style={styles.snapshotCard}>
          <span style={styles.metricLabel}>起点快照</span>
          <strong style={styles.snapshotTime}>{timestamp(arm.startedAt)}</strong>
          <button type="button" onClick={() => onRecord('start')} style={styles.secondaryButton}>记录起点</button>
        </div>
        <div style={styles.snapshotCard}>
          <span style={styles.metricLabel}>终点快照</span>
          <strong style={styles.snapshotTime}>{timestamp(arm.endedAt)}</strong>
          <button type="button" onClick={() => onRecord('end')} style={styles.secondaryButton}>记录终点</button>
        </div>
      </div>

      <div style={styles.metricsRow}>
        <Metric label="输入 token" value={formatTokens(metrics?.input)} />
        <Metric label="输出 token" value={formatTokens(metrics?.output)} />
        <Metric label="总 token" value={formatTokens(metrics === undefined ? undefined : metrics.input + metrics.output)} />
      </div>

      <div style={styles.compactGrid}>
        <label style={styles.label}>验收结果
          <select value={arm.outcome} onChange={event => onChange({ ...arm, outcome: event.target.value as ArmOutcome })} style={styles.input}>
            <option value="pending">待验收</option>
            <option value="passed">通过</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <label style={styles.label}>交互轮数
          <input type="number" min="0" value={arm.turns} onChange={event => onChange({ ...arm, turns: numberFromInput(event.target.value) })} style={styles.input} />
        </label>
        <label style={styles.label}>澄清次数
          <input type="number" min="0" value={arm.clarifications} onChange={event => onChange({ ...arm, clarifications: numberFromInput(event.target.value) })} style={styles.input} />
        </label>
        <label style={styles.label}>返工次数
          <input type="number" min="0" value={arm.reworks} onChange={event => onChange({ ...arm, reworks: numberFromInput(event.target.value) })} style={styles.input} />
        </label>
      </div>

      <label style={styles.label}>实验备注</label>
      <textarea value={arm.notes} onChange={event => onChange({ ...arm, notes: event.target.value })} style={styles.textarea} placeholder="记录异常、人工干预、失败原因等…" />
    </section>
  )
}

export function ExperimentMetricsView({ currentSessionId, readSessions }: ExperimentMetricsInjected) {
  const [experiments, setExperiments] = useState<Experiment[]>(readStoredExperiments)
  const [selectedId, setSelectedId] = useState(() => experiments[0]?.id ?? '')
  const [sessions, setSessions] = useState<SessionCatalogItem[]>(() => readSessions())
  const [status, setStatus] = useState('实验数据只保存在当前浏览器，不会读取页面内容。')
  const selected = experiments.find(item => item.id === selectedId)
  const aggregate = useMemo(() => aggregateExperiments(experiments), [experiments])
  const comparison = selected === undefined ? undefined : compareExperiment(selected)

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPERIMENT_STORAGE_KEY, serializeExperimentStore(experiments))
    } catch {
      setStatus('浏览器阻止了本地存储；刷新页面后本次实验可能丢失。')
    }
  }, [experiments])

  const updateSelected = (updater: (value: Experiment) => Experiment) => {
    setExperiments(items => items.map(item => item.id === selectedId
      ? { ...updater(item), updatedAt: Date.now() }
      : item))
  }

  const updateArm = (armKey: ArmKey, arm: ExperimentArm) => {
    updateSelected(experiment => ({ ...experiment, [armKey]: arm }))
  }

  const refreshSessions = (): SessionCatalogItem[] => {
    const next = readSessions()
    setSessions(next)
    setStatus(`已刷新 ${next.length} 个会话的状态。`)
    return next
  }

  const recordSnapshot = (armKey: ArmKey, kind: 'start' | 'end') => {
    if (selected === undefined) return
    const arm = selected[armKey]
    if (arm.sessionId.length === 0) {
      setStatus('请先为该组绑定会话。')
      return
    }
    if (kind === 'end' && arm.startUsage === undefined) {
      setStatus('请先记录起点，再记录终点。')
      return
    }
    const current = refreshSessions().find(item => item.id === arm.sessionId)
    if (current === undefined) {
      setStatus('绑定的会话已不在 DSH 会话列表中。')
      return
    }
    if (current.usage === undefined) {
      setStatus('该会话尚无 tokenUsage。请先在会话中运行一次模型，或确认 DSH token-meter 已启用。')
      return
    }
    const now = Date.now()
    const next = kind === 'start'
      ? { ...arm, startUsage: current.usage, startedAt: now, endUsage: undefined, endedAt: undefined, outcome: 'pending' as const }
      : { ...arm, endUsage: current.usage, endedAt: now }
    updateArm(armKey, next)
    setStatus(`${armKey === 'control' ? 'Control' : 'PageCraft'} 已记录${kind === 'start' ? '起点' : '终点'}快照。`)
  }

  const addExperiment = () => {
    const next = createExperiment(currentSessionId)
    setExperiments(items => [next, ...items])
    setSelectedId(next.id)
    setStatus('已新建实验；当前会话已预填为 PageCraft 组。')
  }

  const removeExperiment = () => {
    if (selected === undefined || !window.confirm(`删除实验“${selected.title}”？此操作不可撤销。`)) return
    const remaining = experiments.filter(item => item.id !== selected.id)
    setExperiments(remaining)
    setSelectedId(remaining[0]?.id ?? '')
  }

  const exportJson = () => {
    download('dsh-experiments.json', serializeExperimentStore(experiments), 'application/json;charset=utf-8')
    setStatus('已导出 JSON。')
  }

  const exportCsv = () => {
    download('dsh-experiments.csv', experimentsToCsv(experiments), 'text/csv;charset=utf-8')
    setStatus('已导出 CSV。')
  }

  return (
    <div style={styles.root} data-conversation-composer-overlay="">
      <header style={styles.toolbar}>
        <div>
          <strong style={styles.title}>Experiment Metrics</strong>
          <span style={styles.subtitle}>成对 A/B 实验 · 真实 token 快照 · PageCraft 效果量化</span>
        </div>
        <div style={styles.toolbarActions}>
          <button type="button" onClick={refreshSessions} style={styles.secondaryButton}>刷新会话</button>
          <button type="button" disabled={experiments.length === 0} onClick={exportJson} style={styles.secondaryButton}>导出 JSON</button>
          <button type="button" disabled={experiments.length === 0} onClick={exportCsv} style={styles.secondaryButton}>导出 CSV</button>
          <button type="button" onClick={addExperiment} style={styles.primaryButton}>＋ 新建实验</button>
        </div>
      </header>

      <div style={styles.workspace}>
        <aside style={styles.sidebar}>
          <div style={styles.summaryGrid}>
            <Metric label="全部实验" value={String(aggregate.experimentCount)} />
            <Metric label="可比较" value={String(aggregate.comparableCount)} />
            <Metric label="中位节省率" value={formatRate(aggregate.medianSavingRate)} tone={(aggregate.medianSavingRate ?? 0) >= 0 ? colors.good : colors.bad} />
            <Metric label="累计节省" value={formatTokens(aggregate.totalSavedTokens)} tone={aggregate.totalSavedTokens >= 0 ? colors.good : colors.bad} />
          </div>
          <div style={styles.listHeader}>实验列表</div>
          <div style={styles.experimentList}>
            {experiments.map(experiment => {
              const itemComparison = compareExperiment(experiment)
              return (
                <button
                  type="button"
                  key={experiment.id}
                  onClick={() => setSelectedId(experiment.id)}
                  style={{ ...styles.experimentItem, ...(selectedId === experiment.id ? styles.experimentItemActive : {}) }}
                >
                  <strong style={styles.experimentTitle}>{experiment.title}</strong>
                  <span style={styles.experimentMeta}>
                    {itemComparison.kind === 'comparable' ? `节省 ${formatRate(itemComparison.savingRate)}` : itemComparison.kind === 'incomplete' ? '尚未完成' : '不可比较'}
                  </span>
                </button>
              )
            })}
            {experiments.length === 0 ? <div style={styles.empty}>新建第一个实验，分别绑定两个会话。</div> : null}
          </div>
        </aside>

        <main style={styles.main}>
          {selected === undefined ? (
            <div style={styles.heroEmpty}>
              <strong>用同一个任务，公平比较两种工作流</strong>
              <span>Control 不使用 PageCraft；实验组使用页面评注。两组必须从同一提交、同一模型开始。</span>
              <button type="button" onClick={addExperiment} style={styles.primaryButton}>新建实验</button>
            </div>
          ) : (
            <div style={styles.scrollContent}>
              <section style={styles.card}>
                <div style={styles.sectionHeader}>
                  <div><strong>实验定义</strong><span style={styles.sectionHint}>先冻结任务与验收标准，再开始两组会话</span></div>
                  <button type="button" onClick={removeExperiment} style={styles.dangerButton}>删除实验</button>
                </div>
                <div style={styles.definitionGrid}>
                  <label style={styles.label}>实验名称
                    <input value={selected.title} onChange={event => updateSelected(item => ({ ...item, title: event.target.value }))} style={styles.input} />
                  </label>
                  <label style={styles.label}>基准提交
                    <input value={selected.baseCommit} onChange={event => updateSelected(item => ({ ...item, baseCommit: event.target.value }))} style={styles.input} placeholder="Git commit SHA" />
                  </label>
                  <label style={styles.label}>模型与配置
                    <input value={selected.model} onChange={event => updateSelected(item => ({ ...item, model: event.target.value }))} style={styles.input} placeholder="例如 DeepSeek-V4-Flash High" />
                  </label>
                </div>
                <label style={styles.label}>统一任务
                  <textarea value={selected.task} onChange={event => updateSelected(item => ({ ...item, task: event.target.value }))} style={styles.textarea} placeholder="完整复制给两个会话的同一任务描述…" />
                </label>
                <label style={styles.label}>验收标准
                  <textarea value={selected.acceptanceCriteria} onChange={event => updateSelected(item => ({ ...item, acceptanceCriteria: event.target.value }))} style={styles.textarea} placeholder="可观察、可重复判定的通过条件…" />
                </label>
              </section>

              <div style={styles.armGrid}>
                <ArmPanel armKey="control" arm={selected.control} sessions={sessions} onChange={arm => updateArm('control', arm)} onRecord={kind => recordSnapshot('control', kind)} />
                <ArmPanel armKey="pagecraft" arm={selected.pagecraft} sessions={sessions} onChange={arm => updateArm('pagecraft', arm)} onRecord={kind => recordSnapshot('pagecraft', kind)} />
              </div>

              <section style={styles.resultCard}>
                <div style={styles.sectionHeader}>
                  <div><strong>成对比较结果</strong><span style={styles.sectionHint}>{comparison?.reason ?? '结果按两组起止快照自动计算'}</span></div>
                  <span style={{ ...styles.pill, color: comparison?.kind === 'comparable' ? colors.good : colors.warn }}>
                    {comparison?.kind === 'comparable' ? '可比较' : comparison?.kind === 'not-comparable' ? '不计算节省率' : '实验未完成'}
                  </span>
                </div>
                <div style={styles.resultMetrics}>
                  <Metric label="Control 总 token" value={formatTokens(comparison?.control.totalTokens)} />
                  <Metric label="PageCraft 总 token" value={formatTokens(comparison?.pagecraft.totalTokens)} />
                  <Metric label="节省 token" value={formatTokens(comparison?.savedTokens)} tone={(comparison?.savedTokens ?? 0) >= 0 ? colors.good : colors.bad} />
                  <Metric label="节省率" value={formatRate(comparison?.savingRate)} tone={(comparison?.savingRate ?? 0) >= 0 ? colors.good : colors.bad} />
                </div>
                <div style={styles.fairnessNote}>
                  <strong>公平实验检查：</strong> 两个不同会话、同一任务、同一基准提交、同一模型、同一验收标准。推荐使用两个 Git worktree，避免两组代码相互污染。
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
      <div style={styles.statusBar}>{status}</div>
    </div>
  )
}

export function apply(ctx: any): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'experiment-metrics',
    order: 30,
    label: () => '实验对比',
    inject: (sessionId: string): ExperimentMetricsInjected => ({
      currentSessionId: sessionId,
      readSessions: () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        return snapshot.ids.map((id: string) => {
          const summary = snapshot.byId[id]
          const liveUsage = ctx.sessions.binding(id)?.session.projections.get('tokenUsage')
          const projectedUsage = summary?.projectionValues?.tokenUsage
          return {
            id,
            title: summary?.displayTitle ?? id,
            cwd: summary?.cwd,
            running: Boolean(summary?.running),
            usage: normalizeTokenUsage(liveUsage ?? projectedUsage),
          }
        })
      },
    }),
  }, ExperimentMetricsView))
}

const styles: Record<string, any> = {
  root: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: colors.text, background: colors.bg, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '13px 16px', borderBottom: `1px solid ${colors.border}`, background: colors.panel, flexWrap: 'wrap' },
  title: { display: 'block', fontSize: 15 },
  subtitle: { display: 'block', marginTop: 3, color: colors.muted, fontSize: 11 },
  toolbarActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  workspace: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(240px, 290px) minmax(0, 1fr)', overflow: 'hidden', paddingBottom: 'calc(var(--dsh-composer-height, 152px) + 12px)' },
  sidebar: { minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${colors.border}`, background: colors.panel },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 12, borderBottom: `1px solid ${colors.border}` },
  listHeader: { padding: '12px 13px 7px', color: colors.muted, fontSize: 11, fontWeight: 700, letterSpacing: '.08em' },
  experimentList: { minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' },
  experimentItem: { width: '100%', display: 'block', padding: 11, marginBottom: 6, border: '1px solid transparent', borderRadius: 8, color: colors.text, background: 'transparent', cursor: 'pointer', textAlign: 'left' },
  experimentItemActive: { borderColor: colors.border, background: colors.panel2 },
  experimentTitle: { display: 'block', overflow: 'hidden', fontSize: 12, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  experimentMeta: { display: 'block', marginTop: 5, color: colors.muted, fontSize: 10 },
  main: { minWidth: 0, minHeight: 0, overflow: 'hidden' },
  scrollContent: { height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: 14, scrollbarGutter: 'stable' },
  card: { padding: 15, border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.panel },
  armGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 12, marginTop: 12 },
  armPanel: { minWidth: 0, padding: 15, border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.panel },
  resultCard: { padding: 15, marginTop: 12, border: `1px solid ${colors.border}`, borderRadius: 10, background: '#111b16' },
  sectionHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 13 },
  sectionHint: { display: 'block', marginTop: 4, color: colors.muted, fontSize: 10, lineHeight: 1.45 },
  definitionGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 },
  compactGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 12 },
  label: { display: 'block', minWidth: 0, marginTop: 9, color: colors.muted, fontSize: 10, fontWeight: 700 },
  input: { width: '100%', height: 35, marginTop: 5, boxSizing: 'border-box', padding: '0 9px', border: `1px solid ${colors.border}`, borderRadius: 7, color: colors.text, background: '#0a100d', outline: 'none', fontSize: 11 },
  textarea: { width: '100%', minHeight: 70, marginTop: 5, resize: 'vertical', boxSizing: 'border-box', padding: 9, border: `1px solid ${colors.border}`, borderRadius: 7, color: colors.text, background: '#0a100d', outline: 'none', font: '11px/1.55 inherit' },
  snapshotGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 11 },
  snapshotCard: { padding: 10, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.panel2 },
  snapshotTime: { display: 'block', minHeight: 28, margin: '5px 0 8px', color: colors.text, fontSize: 10, lineHeight: 1.4 },
  metricsRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 },
  resultMetrics: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 9 },
  metric: { minWidth: 0, padding: 10, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.panel2 },
  metricLabel: { display: 'block', color: colors.muted, fontSize: 9 },
  metricValue: { display: 'block', overflow: 'hidden', marginTop: 5, color: colors.text, fontSize: 16, textOverflow: 'ellipsis' },
  pill: { display: 'inline-flex', padding: '4px 8px', border: `1px solid ${colors.border}`, borderRadius: 99, background: colors.panel2, fontSize: 9, fontWeight: 800, whiteSpace: 'nowrap' },
  fairnessNote: { marginTop: 11, padding: 10, borderRadius: 7, color: colors.muted, background: colors.panel2, fontSize: 10, lineHeight: 1.6 },
  primaryButton: { height: 34, padding: '0 12px', border: 0, borderRadius: 7, color: '#102016', background: colors.accent, cursor: 'pointer', fontWeight: 800 },
  secondaryButton: { height: 32, padding: '0 10px', border: `1px solid ${colors.border}`, borderRadius: 7, color: colors.text, background: colors.panel2, cursor: 'pointer', fontSize: 10 },
  dangerButton: { height: 30, padding: '0 9px', border: `1px solid #6e3535`, borderRadius: 7, color: colors.bad, background: '#241616', cursor: 'pointer', fontSize: 10 },
  heroEmpty: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, color: colors.muted, textAlign: 'center', fontSize: 12 },
  empty: { padding: 18, color: colors.muted, textAlign: 'center', fontSize: 11, lineHeight: 1.6 },
  statusBar: { minHeight: 24, boxSizing: 'border-box', padding: '5px 12px', borderTop: `1px solid ${colors.border}`, color: colors.muted, background: colors.panel, fontSize: 9 },
}
