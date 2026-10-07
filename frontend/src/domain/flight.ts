import type { EntryRow } from '@/data/types'

/**
 * 航班保障领域规则：航班号、计划到港、保障节点、保障状态的判定全部收敛在这里，
 * 航班保障列表、详情页、过站监控清单共用同一份口径，避免各页面各判各的。
 */

// 标准保障节点，按作业先后排列；历史旧航班没有节点明细时按这份模板补成待补。
export const FLIGHT_NODES = [
  '靠桥/客梯',
  '开舱下客',
  '行李卸机',
  '货物装卸',
  '加油作业',
  '航食配餐',
  '客舱清洁',
  '排污加水',
  '装舱上客',
  '关舱离港',
] as const

export type NodeState = '待补' | '进行中' | '已完成' | '中断'

export type FlightNode = {
  name: string
  state: NodeState
  reason?: string
}

export type FlightFieldKey =
  | '航班号'
  | '机尾号'
  | '计划到港'
  | '实际到港'
  | '计划离港'
  | '预计离港'

// 持久化在 EntryRow 上的结构化字段：节点明细（JSON）、人工延误结论、中断原因等。
export const NODE_DETAIL_FIELD = '节点明细'
export const LEGACY_FIELD = '历史数据'
export const MANUAL_DELAY_FIELD = '人工延误'
export const DELAY_REASON_FIELD = '延误结论'
export const WARN_FIELD = '数据告警'
export const SCHEMA_FIELD = '数据版本'
export const SCHEMA_VERSION = 2

export type MissingReason =
  | '航班号缺失'
  | '计划到港缺失'
  | '实际到港为空（航班未到港）'
  | '保障节点未完成'
  | '节点明细缺失'
  | '节点明细损坏'

export type FlightView = {
  row: EntryRow
  flightNo: string
  scheduledArrival: string
  actualArrival: string
  nodes: FlightNode[]
  legacy: boolean
  manualDelay: boolean
  delayReason: string
  warnings: string[]
  /** 统一判定出的展示状态，例如「缺数据 · 实际到港为空（航班未到港）」 */
  derivedStatus: string
  ready: boolean
  complete: boolean
  resumeNode: FlightNode | null
}

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

// 时间字段统一按 YYYY-MM-DD HH:mm 判定，占位文本（如「航班保障样例1」）一律视为缺数据。
export function isValidTime(value: unknown): boolean {
  if (isBlank(value)) {
    return false
  }
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(value).trim())
}

export function normalizeFlightNo(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

export function parseNodes(raw: unknown): { nodes: FlightNode[]; corrupt: boolean } {
  if (isBlank(raw)) {
    return { nodes: [], corrupt: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return { nodes: [], corrupt: true }
  }
  if (!Array.isArray(parsed)) {
    return { nodes: [], corrupt: true }
  }
  const states: NodeState[] = ['待补', '进行中', '已完成', '中断']
  const nodes: FlightNode[] = parsed.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>
    const name = isBlank(record.name) ? '未命名节点' : String(record.name)
    const state = states.includes(record.state as NodeState) ? (record.state as NodeState) : '待补'
    const reason = isBlank(record.reason) ? undefined : String(record.reason)
    return reason ? { name, state, reason } : { name, state }
  })
  return { nodes, corrupt: false }
}

export function serializeNodes(nodes: FlightNode[]): string {
  return JSON.stringify(nodes)
}

// 历史旧航班按标准模板补节点：旧记录里没有节点明细，一律先补成待补，由人工继续拉取。
export function templateNodes(): FlightNode[] {
  return FLIGHT_NODES.map((name) => ({ name, state: '待补' as NodeState }))
}

function blankReasons(row: EntryRow): MissingReason[] {
  const reasons: MissingReason[] = []
  if (isBlank(row['航班号'])) {
    reasons.push('航班号缺失')
  }
  if (!isValidTime(row['计划到港'])) {
    reasons.push('计划到港缺失')
  }
  if (isBlank(row['实际到港'])) {
    reasons.push('实际到港为空（航班未到港）')
  }
  return reasons
}

// 节点恢复入口：中断节点优先，其次取最早一个未完成节点；全部完成则无需再拉取。
export function findResumeNode(nodes: FlightNode[]): FlightNode | null {
  return (
    nodes.find((node) => node.state === '中断') ??
    nodes.find((node) => node.state !== '已完成') ??
    null
  )
}

/**
 * 统一保障状态判定：
 * - 已就绪必须同时满足「到港时间齐全 + 节点全部完成」，任一缺失都降级为缺数据，不再照旧显示已就绪
 * - 人工延误结论始终保留，任何恢复动作都不覆盖
 * - 节点中断时状态带「节点中断」并注明卡在哪个节点
 */
export function buildFlightView(row: EntryRow): FlightView {
  const legacy = Boolean(row[LEGACY_FIELD])
  const flightNo = String(row['航班号'] ?? '').trim()
  const scheduledArrival = String(row['计划到港'] ?? '').trim()
  const actualArrival = String(row['实际到港'] ?? '').trim()

  const { nodes, corrupt } = parseNodes(row[NODE_DETAIL_FIELD])

  const warnings: string[] = []
  if (legacy) {
    warnings.push('历史旧航班：节点按标准模板补录，请核对后再继续')
  }
  if (corrupt) {
    warnings.push('节点明细已损坏：已按标准模板重建为待补，请从待补节点重新拉取')
  }
  const rawWarn = String(row[WARN_FIELD] ?? '').trim()
  if (rawWarn && !warnings.includes(rawWarn)) {
    warnings.push(rawWarn)
  }

  const reasons = blankReasons(row)
  const complete = nodes.length > 0 && nodes.every((node) => node.state === '已完成')
  if (!complete) {
    reasons.push(nodes.length === 0 ? '节点明细缺失' : '保障节点未完成')
  }

  const manualDelay = Boolean(row[MANUAL_DELAY_FIELD]) || String(row.status) === '已延误'
  const delayReason = String(row[DELAY_REASON_FIELD] ?? '').trim()
  const baseStatus = String(row.status)
  const resumeNode = findResumeNode(nodes)
  const interrupted = nodes.find((node) => node.state === '中断')

  let derivedStatus = baseStatus
  if (manualDelay) {
    derivedStatus = delayReason ? `已延误（${delayReason}）` : '已延误'
  } else if (baseStatus === '已就绪' && reasons.length > 0) {
    // 核心修复：实际到港为空等缺数据场景，不再照旧显示「已就绪」
    derivedStatus = `缺数据 · ${reasons.join('、')}`
  } else if (interrupted) {
    derivedStatus = `保障中 · 节点中断（${interrupted.name}${interrupted.reason ? `：${interrupted.reason}` : ''}）`
  } else if (baseStatus === '保障中' && reasons.length > 0) {
    derivedStatus = `保障中 · 缺数据 · ${reasons.join('、')}`
  } else if (legacy && reasons.length > 0) {
    derivedStatus = `${baseStatus} · 缺数据 · ${reasons.join('、')}`
  }

  return {
    row,
    flightNo,
    scheduledArrival,
    actualArrival,
    nodes,
    legacy,
    manualDelay,
    delayReason,
    warnings,
    derivedStatus,
    ready: baseStatus === '已就绪' && reasons.length === 0,
    complete,
    resumeNode,
  }
}

/** 校验航班号 / 时间等必填项，返回人话原因；旧航班不做格式硬校验，只要求不为空。 */
export function validateFlightField(
  field: FlightFieldKey,
  value: string,
  legacy: boolean,
): string | null {
  const text = value.trim()
  if (isBlank(text)) {
    return `${field}不能为空`
  }
  if (legacy) {
    return null
  }
  if (field === '航班号' && !/^[A-Z0-9]{2}\d{3,4}$/.test(text.toUpperCase())) {
    return '航班号格式不正确，示例：CA1831'
  }
  if ((field === '计划到港' || field === '实际到港') && !isValidTime(text)) {
    return `${field}需为 YYYY-MM-DD HH:mm 格式`
  }
  return null
}
