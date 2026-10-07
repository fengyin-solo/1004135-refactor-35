import {
  buildFlightView,
  DELAY_REASON_FIELD,
  findResumeNode,
  FLIGHT_NODES,
  isBlank,
  isValidTime,
  LEGACY_FIELD,
  MANUAL_DELAY_FIELD,
  NODE_DETAIL_FIELD,
  normalizeFlightNo,
  parseNodes,
  SCHEMA_FIELD,
  SCHEMA_VERSION,
  serializeNodes,
  templateNodes,
  validateFlightField,
  WARN_FIELD,
  type FlightFieldKey,
  type FlightNode,
  type FlightView,
} from '@/domain/flight'
import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 航班保障专用服务：列表与详情页都走这里，保证
 * 1) 旧航班首次读取时迁移（补节点、标历史），中断后从待补处继续；
 * 2) 所有重试 / 继续动作都返回明确原因；
 * 3) 人工延误结论一旦确认，重复恢复不再覆盖。
 */

const KEY = 'flight_ops'
const FINAL_STATUS = '已就绪'

function readRaw(): EntryRow[] {
  let rows: EntryRow[]
  try {
    rows = listRows(KEY)
  } catch (error) {
    throw new Error(`航班保障列表读取失败：${error instanceof Error ? error.message : '本地数据不可读'}，请点重试重新拉取`)
  }
  if (!Array.isArray(rows)) {
    throw new Error('航班保障列表读取失败：数据结构损坏，请点重试或重置模块')
  }
  return rows
}

/**
 * 旧数据兼容：没有节点明细的记录按标准模板补成待补并标记历史；
 * 节点明细损坏的重建为待补；已延误的旧记录识别为人工延误结论。
 * 迁移结果一次性落库，之后刷新不再重复迁移。
 */
export function normalizeFlightRow(row: EntryRow): EntryRow {
  const migrated = Number(row[SCHEMA_FIELD] ?? 0) >= SCHEMA_VERSION
  if (migrated) {
    return row
  }

  const next: EntryRow = { ...row, [SCHEMA_FIELD]: SCHEMA_VERSION }
  const { nodes, corrupt } = parseNodes(row[NODE_DETAIL_FIELD])

  if (corrupt) {
    // 明细损坏属于当前数据故障：重建为待补，但不当作历史旧航班
    next[NODE_DETAIL_FIELD] = serializeNodes(templateNodes())
    next[WARN_FIELD] = '节点明细损坏，已按标准模板重建为待补'
    if (String(next.status) === '已就绪') {
      next.status = '保障中'
    }
  } else if (nodes.length === 0) {
    // 历史旧航班没有节点明细：按标准模板补成待补并标记，从待补处继续
    next[NODE_DETAIL_FIELD] = serializeNodes(templateNodes())
    next[LEGACY_FIELD] = true
    next[WARN_FIELD] = '历史旧航班缺节点明细，已按标准模板补录'
    if (String(next.status) === '已就绪') {
      next.status = '保障中'
    }
  }

  if (String(next.status) === '已延误') {
    next[MANUAL_DELAY_FIELD] = true
  }
  return next
}

function persist(index: number, next: EntryRow, rows: EntryRow[]): void {
  const copy = [...rows]
  copy[index] = next
  saveRows(KEY, copy)
}

function findIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === Number(id))
}

export function listFlights(filters: Record<string, string> = {}): FlightView[] {
  const rows = readRaw()
  const migrated = rows.map((row) => normalizeFlightRow(row))
  if (migrated.some((row, index) => row !== rows[index])) {
    saveRows(KEY, migrated)
  }
  return filterRows(migrated, filters)
    .map((row) => buildFlightView(row))
    .sort((a, b) => a.scheduledArrival.localeCompare(b.scheduledArrival))
}

export function getFlight(id: number): FlightView {
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    throw new Error(`航班保障详情读取失败：编号 ${id} 的航班不存在或已被删除，请返回列表重新选择`)
  }
  const normalized = normalizeFlightRow(rows[index])
  if (normalized !== rows[index]) {
    persist(index, normalized, rows)
  }
  return buildFlightView(normalized)
}

export function startFlight(id: number): ActionResult {
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `启动失败：编号 ${id} 的航班不存在` }
  }
  const view = buildFlightView(normalizeFlightRow(rows[index]))
  if (view.manualDelay) {
    return { ok: false, message: `启动失败：该航班已有人工延误结论「${view.delayReason || '已延误'}」，恢复不会覆盖，请先撤销延误结论` }
  }
  if (String(view.row.status) === '保障中') {
    return { ok: false, message: '航班已在保障中，无需重复启动' }
  }
  persist(index, { ...view.row, status: '保障中', pending: true }, rows)
  return { ok: true, message: '保障已启动，节点从首个待补项开始拉取' }
}

/** 确认就绪：统一判定航班号、计划到港、实际到港与全部保障节点，缺什么明确告诉原因。 */
export function confirmReady(id: number): ActionResult {
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `确认就绪失败：编号 ${id} 的航班不存在` }
  }
  const view = buildFlightView(normalizeFlightRow(rows[index]))
  if (view.manualDelay) {
    return { ok: false, message: `确认就绪失败：已有人工延误结论「${view.delayReason || '已延误'}」，重复恢复不覆盖人工结论` }
  }

  const reasons: string[] = []
  if (isBlank(view.row['航班号'])) {
    reasons.push('航班号为空')
  }
  if (!isValidTime(view.row['计划到港'])) {
    reasons.push('计划到港为空或格式不对')
  }
  if (isBlank(view.row['实际到港'])) {
    reasons.push('实际到港为空，航班尚未到港')
  }
  if (view.nodes.length === 0) {
    reasons.push('保障节点明细缺失')
  }
  const blocked = view.nodes.filter((node) => node.state !== '已完成')
  if (blocked.length > 0) {
    const names = blocked
      .slice(0, 4)
      .map((node) => `${node.name}（${node.state === '中断' ? `中断${node.reason ? `：${node.reason}` : ''}` : node.state}）`)
      .join('、')
    reasons.push(`保障节点未全部完成：${names}${blocked.length > 4 ? ' 等' : ''}`)
  }
  if (reasons.length > 0) {
    return { ok: false, message: `无法确认就绪：${reasons.join('；')}。请补齐后重试` }
  }

  const next: EntryRow = {
    ...view.row,
    status: FINAL_STATUS,
    pending: false,
    abnormal: false,
    '保障状态': '已就绪',
    [WARN_FIELD]: '',
  }
  persist(index, next, rows)
  return { ok: true, message: '全部节点已完成且到港数据齐全，航班确认就绪' }
}

/** 人工标记延误：写入人工结论，之后任何节点恢复 / 重试都不覆盖它。 */
export function markDelay(id: number, reason: string): ActionResult {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '标记延误失败：请填写延误原因，便于恢复时核对' }
  }
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `标记延误失败：编号 ${id} 的航班不存在` }
  }
  const current = normalizeFlightRow(rows[index])
  if (current[MANUAL_DELAY_FIELD] && String(current[DELAY_REASON_FIELD] ?? '') === trimmed) {
    return { ok: false, message: `该航班已标记相同的人工延误结论「${trimmed}」，无需重复操作` }
  }
  const next: EntryRow = {
    ...current,
    status: '已延误',
    pending: false,
    abnormal: true,
    [MANUAL_DELAY_FIELD]: true,
    [DELAY_REASON_FIELD]: trimmed,
    '保障状态': '已延误',
  }
  persist(index, next, rows)
  return { ok: true, message: `已记录人工延误结论「${trimmed}」，后续恢复不会覆盖该结论` }
}

export function updateFlightField(id: number, field: FlightFieldKey, value: string): ActionResult {
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `保存失败：编号 ${id} 的航班不存在` }
  }
  const current = normalizeFlightRow(rows[index])
  const view = buildFlightView(current)
  const error = validateFlightField(field, value, view.legacy)
  if (error) {
    return { ok: false, message: `保存失败：${error}` }
  }
  const next: EntryRow = { ...current, [field]: value.trim() }
  persist(index, next, rows)
  return { ok: true, message: `${field}已更新为「${value.trim()}」` }
}

export type ResumeResult = ActionResult & { view?: FlightView }

/**
 * 中断后继续保障：永远从「首个待补处」（中断节点优先）继续。
 * - 中断节点先重试该节点本身（重新拉取），重试原因写清楚；
 * - 全部完成且数据齐全则自动确认就绪；
 * - 人工延误结论存在时直接拒绝，不覆盖；
 * - 重复恢复是幂等的：已经完成的节点不会被改回。
 */
export function resumeFlightNode(id: number): ResumeResult {
  const rows = readRaw()
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `继续保障失败：编号 ${id} 的航班不存在，请返回列表重进详情` }
  }
  const view = buildFlightView(normalizeFlightRow(rows[index]))

  if (view.manualDelay) {
    return {
      ok: false,
      message: `继续保障被拦截：该航班已有人工延误结论「${view.delayReason || '已延误'}」，重复恢复不会覆盖人工结论；如确需继续，请先撤销延误结论`,
    }
  }
  if (isBlank(view.row['实际到港'])) {
    return { ok: false, message: '继续保障失败：实际到港为空，航班尚未到港，请先补录实际到港时间再重试' }
  }

  const target = findResumeNode(view.nodes)
  if (!target) {
    if (view.complete && String(view.row.status) !== FINAL_STATUS) {
      const ready = confirmReady(id)
      return ready.ok ? { ...ready, view: getFlight(id) } : ready
    }
    return { ok: false, message: '所有保障节点均已完成，没有可继续的待补节点，无需重复恢复' }
  }

  const nodes: FlightNode[] = view.nodes.map((node) =>
    node.name === target.name && node.state !== '已完成'
      ? { name: node.name, state: '已完成', reason: undefined }
      : node,
  )

  const wasInterrupted = target.state === '中断'
  const nowComplete = nodes.every((node) => node.state === '已完成')
  const nextNode = findResumeNode(nodes)

  const next: EntryRow = {
    ...view.row,
    status: nowComplete ? FINAL_STATUS : '保障中',
    pending: !nowComplete,
    abnormal: nowComplete ? false : view.row.abnormal,
    [NODE_DETAIL_FIELD]: serializeNodes(nodes),
    '保障节点': `${nodes.filter((n) => n.state === '已完成').length}/${nodes.length} 完成${nextNode ? `，待补：${nextNode.name}` : ''}`,
    '保障状态': nowComplete ? '已就绪' : '保障中',
    [WARN_FIELD]: '',
  }
  persist(index, next, rows)

  let message: string
  if (wasInterrupted) {
    message = `中断节点「${target.name}」已重新拉取并完成${target.reason ? `（原中断原因：${target.reason}）` : ''}`
  } else {
    message = `已从待补处继续：节点「${target.name}」拉取完成`
  }
  if (nowComplete) {
    message += '；全部节点完成、到港数据齐全，航班自动确认就绪'
  } else if (nextNode) {
    message += nextNode.state === '中断'
      ? `；下个待补节点「${nextNode.name}」处于中断，可再次点继续重新拉取（原因：${nextNode.reason || '未记录'}）`
      : `；下个待补节点：${nextNode.name}`
  }
  return { ok: true, message, view: buildFlightView(next) }
}

/** 过站监控清单同步用：按航班号给出待补节点摘要（中断优先，再按顺序补未完成项）。 */
export function pendingNodeSummary(flightNo: string): string {
  const key = normalizeFlightNo(flightNo)
  if (!key) {
    return ''
  }
  const rows = readRaw()
  const match = rows
    .map((row) => normalizeFlightRow(row))
    .find((row) => normalizeFlightNo(row['航班号']) === key)
  if (!match) {
    return ''
  }
  const view = buildFlightView(match)
  const pending = view.nodes.filter((node) => node.state !== '已完成')
  if (pending.length === 0) {
    return '节点齐'
  }
  const interrupted = pending.find((node) => node.state === '中断')
  if (interrupted) {
    return `中断：${interrupted.name}（${interrupted.reason || '原因未记录'}）；另待补 ${pending.length - 1} 项`
  }
  return `待补 ${pending.length}/${FLIGHT_NODES.length}：${pending
    .slice(0, 3)
    .map((node) => node.name)
    .join('、')}${pending.length > 3 ? ' 等' : ''}`
}

export function downloadFlights(filters: Record<string, string> = {}): void {
  const views = listFlights(filters)
  const header = [
    '编号',
    '航班号',
    '机尾号',
    '计划到港',
    '实际到港',
    '计划离港',
    '预计离港',
    '保障节点',
    '保障状态（统一判定）',
    '人工延误结论',
  ]
  const lines = [header.join(',')]
  for (const view of views) {
    const row = view.row
    lines.push(
      [
        row.id,
        view.flightNo,
        row['机尾号'] ?? '',
        view.scheduledArrival,
        view.actualArrival,
        row['计划离港'] ?? '',
        row['预计离港'] ?? '',
        `${view.nodes.filter((node) => node.state === '已完成').length}/${view.nodes.length}`,
        view.derivedStatus,
        view.manualDelay ? view.delayReason || '已延误' : '',
      ]
        .map((cell) => String(cell).replace(/,/g, '，'))
        .join(','),
    )
  }
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '航班保障-清单.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
