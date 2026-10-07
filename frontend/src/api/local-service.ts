import {
  FLIGHT_OPS_KEY,
  TURNAROUND_KEY,
  assessFlight,
  effectiveFlightStatus,
  missingFlightNodes,
  normalizeFlightRow,
} from '@/data/flight-ops'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 页面渲染需要的纯判定也从这里出口，保持「页面不直接碰数据层」的约定。
export { assessFlight }
export type { FlightAssessment } from '@/data/flight-ops'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 航班保障动作的统一判定：缺节点时给出原因并拦下，不允许数据不全还往上流转。
function guardFlightAction(row: EntryRow, action: string): ActionResult | null {
  const missing = missingFlightNodes(row)
  if (action === '启动保障') {
    const basics = missing.filter((field) => field === '航班号' || field === '计划到港')
    if (basics.length > 0) {
      return { ok: false, message: `不能启动保障：${basics.join('、')}未登记（待补节点：${missing.join('、')}）` }
    }
  }
  if (action === '确认就绪' && missing.length > 0) {
    return { ok: false, message: `不能确认就绪：待补节点 ${missing.join('、')} 未补齐` }
  }
  return null
}

function applyFlightAction(row: EntryRow, action: string, target: string): EntryRow {
  const normalized = normalizeFlightRow(row)
  const updated: EntryRow = {
    ...normalized,
    status: target,
    保障状态: target,
    pending: target !== '已就绪',
    // 中断标记只能由「重新拉取」清除，普通动作不顺手抹掉。
    abnormal: normalized.abnormal,
  }
  if (action === '标记延误') {
    updated.延误标记 = '人工'
  } else {
    // 人工重新处置后，旧的延误结论不再生效。
    updated.延误标记 = ''
  }
  return updated
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 航班保障按统一判定后的状态做重复校验，历史数据里「已就绪但缺节点」不会被当成重复。
  const current = key === FLIGHT_OPS_KEY ? effectiveFlightStatus(rows[index]) : String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  let updated: EntryRow
  if (key === FLIGHT_OPS_KEY) {
    const blocked = guardFlightAction(rows[index], action)
    if (blocked) {
      return blocked
    }
    updated = applyFlightAction(rows[index], action, target)
  } else {
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    updated = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === FLIGHT_OPS_KEY) {
    syncTurnaroundPending()
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 航班保障列表：读取时做统一判定与历史数据兼容；数据损坏时抛错，由页面给出「暂无」提示。
export function listFlightEntries(filters: Record<string, string> = {}): PageResult {
  const raw = listRows(FLIGHT_OPS_KEY)
  if (!Array.isArray(raw)) {
    throw new Error('航班保障数据读取异常：本地缓存不是列表，可能已损坏')
  }
  const matched = filterRows(raw.map(normalizeFlightRow), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 单条航班详情：找不到记录会抛错，详情页据此提示原因并重试拉取。
export function getFlightEntry(id: number): EntryRow {
  const row = listRows(FLIGHT_OPS_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的航班保障，可能已被清理`)
  }
  return normalizeFlightRow(row)
}

// 中断任务重新拉取：说明中断原因，从待补节点继续；人工延误结论不覆盖。
export function retryFlightFetch(id: number): ActionResult {
  const rows = listRows(FLIGHT_OPS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的航班保障，可能已被清理` }
  }
  const row = normalizeFlightRow(rows[index])
  const assessment = assessFlight(row)
  const flightNo = String(row.航班号 ?? '').trim() || `编号${id}`
  if (!assessment.interrupted) {
    const tail = assessment.missing.length > 0 ? `，待补节点：${assessment.missing.join('、')}` : ''
    return {
      ok: false,
      message: `航班 ${flightNo} 没有中断记录，无需重新拉取；当前状态「${assessment.effectiveStatus}」${tail}`,
    }
  }
  const updated: EntryRow = { ...row, abnormal: false, 中断原因: '' }
  let message: string
  if (assessment.manualDelay) {
    // 重复恢复也不覆盖人工延误结论：只清中断标记，状态保持已延误。
    updated.status = '已延误'
    updated.保障状态 = '已延误'
    updated.pending = true
    message = `航班 ${flightNo} 已重新拉取（原中断原因：${assessment.cause}）；存在人工延误结论，状态保持「已延误」不覆盖`
  } else {
    // 中断后从待补处继续：状态落在待补节点对应的位置，不回退到待保障重来。
    updated.status = assessment.effectiveStatus
    updated.保障状态 = assessment.effectiveStatus
    updated.pending = assessment.missing.length > 0
    message =
      assessment.missing.length > 0
        ? `航班 ${flightNo} 已重新拉取（原中断原因：${assessment.cause}），从待补节点「${assessment.missing.join('、')}」继续保障，当前状态「${assessment.effectiveStatus}」`
        : `航班 ${flightNo} 已重新拉取（原中断原因：${assessment.cause}），节点齐全，恢复为「已就绪」`
  }
  const next = [...rows]
  next[index] = updated
  saveRows(FLIGHT_OPS_KEY, next)
  syncTurnaroundPending()
  return { ok: true, message }
}

// 过站监控清单同步航班保障的待补节点：按「关联航班 ↔ 航班号」对齐，返回本次更新的条数。
export function syncTurnaroundPending(): number {
  const flights = listRows(FLIGHT_OPS_KEY).map(normalizeFlightRow)
  const byFlightNo = new Map(flights.map((row) => [String(row.航班号 ?? '').trim(), row]))
  const rows = listRows(TURNAROUND_KEY)
  let changed = 0
  const next = rows.map((row) => {
    const flightNo = String(row.关联航班 ?? '').trim()
    const flight = flightNo ? byFlightNo.get(flightNo) : undefined
    const missing = flight ? missingFlightNodes(flight) : []
    const pendingText = !flightNo
      ? '未关联航班'
      : !flight
        ? '未找到航班'
        : missing.length > 0
          ? missing.join('、')
          : '无'
    const pending = flight ? missing.length > 0 : row.pending === true
    if (row.待补节点 === pendingText && row.pending === pending) {
      return row
    }
    changed += 1
    return { ...row, 待补节点: pendingText, pending }
  })
  if (changed > 0) {
    saveRows(TURNAROUND_KEY, next)
  }
  return changed
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
