import type { EntryRow } from './types'

// 航班保障的统一判定：航班号、计划到港、保障节点、保障状态怎么看，全仓库只看这一份。
// 列表、详情、动作流转、中断重试、过站监控同步都从这里走，避免各页面各写一套。
export const FLIGHT_OPS_KEY = 'flight_ops'
export const TURNAROUND_KEY = 'turnaround'

// 就绪前必须补齐的保障节点：缺一个都算「待补」，不允许确认就绪。
export const FLIGHT_REQUIRED_NODES = ['航班号', '计划到港', '实际到港', '保障节点'] as const

// 基础节点缺失说明航班还没真正进入保障，状态只能停在「待保障」。
const BASIC_NODES = ['航班号', '计划到港']

// 正常流转的状态顺序，用于「数据不全时状态不能往上走」的封顶判定。
const STATUS_ORDER = ['待保障', '保障中', '已就绪']

export type FlightAssessment = {
  missing: string[] // 待补节点
  manualDelay: boolean // 是否人工延误结论（含历史旧航班直接存的已延误）
  interrupted: boolean // 是否中断任务（拉取异常，需要重新拉取）
  effectiveStatus: string // 统一判定后的保障状态
  cause: string // 中断原因；未中断时为空
}

export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

export function missingFlightNodes(row: EntryRow): string[] {
  return FLIGHT_REQUIRED_NODES.filter((field) => isBlank(row[field]))
}

export function isManualDelay(row: EntryRow): boolean {
  if (String(row.延误标记 ?? '').trim() === '人工') {
    return true
  }
  // 历史旧航班没有延误标记字段：凡是已经存成已延误的，都按人工结论对待，恢复时不覆盖。
  return String(row.status ?? '') === '已延误'
}

export function effectiveFlightStatus(row: EntryRow): string {
  if (isManualDelay(row)) {
    return '已延误'
  }
  const missing = missingFlightNodes(row)
  const cap =
    missing.length === 0
      ? '已就绪'
      : missing.some((field) => BASIC_NODES.includes(field))
        ? '待保障'
        : '保障中'
  const storedIndex = STATUS_ORDER.indexOf(String(row.status ?? ''))
  if (storedIndex < 0) {
    // 历史数据状态不在流转表里，按数据兜底。
    return cap
  }
  // 数据不全时状态不能往上走：实际到港等着补节点为空，就不允许显示已就绪。
  return STATUS_ORDER[Math.min(storedIndex, STATUS_ORDER.indexOf(cap))]
}

export function assessFlight(row: EntryRow): FlightAssessment {
  const interrupted = row.abnormal === true
  return {
    missing: missingFlightNodes(row),
    manualDelay: isManualDelay(row),
    interrupted,
    effectiveStatus: effectiveFlightStatus(row),
    cause: interrupted ? String(row.中断原因 ?? '').trim() || '历史数据未记录中断原因' : '',
  }
}

// 历史旧航班兼容：老数据可能缺 pending/abnormal，保障状态也可能和节点数据对不上，
// 读取时按统一判定补默认，不回写存储，有写操作时再落盘。
export function normalizeFlightRow(row: EntryRow): EntryRow {
  return {
    ...row,
    pending: typeof row.pending === 'boolean' ? row.pending : missingFlightNodes(row).length > 0,
    abnormal: row.abnormal === true,
    保障状态: effectiveFlightStatus(row),
  }
}
