<template>
  <section class="page" data-module="flight_ops">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">维护航班保障，围绕航班号、机尾号、计划到港、实际到港做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记航班保障</button>
        <button class="btn" type="button" @click="exportRows">导出航班保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>待补节点</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>{{ missingText(row) }}</td>
          <td>
            {{ assessFlight(row).effectiveStatus }}
            <span v-if="assessFlight(row).interrupted" class="tag tag-warn">中断</span>
            <span v-if="assessFlight(row).manualDelay" class="tag tag-delay">人工延误</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            <template v-if="loadFailed">
              暂无航班保障数据：{{ errorMessage }}
              <button class="link" type="button" @click="reload">重试拉取</button>
            </template>
            <template v-else>暂无航班保障数据，可先登记航班保障</template>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="!loadFailed && errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailVisible" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>航班保障详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <p v-if="detailError" class="error-text">
          {{ detailError }}
          <button class="link" type="button" @click="reloadDetail">重试拉取</button>
        </p>
        <template v-else-if="detailRow && detailAssessment">
          <dl class="detail-grid">
            <template v-for="column in columns" :key="column">
              <dt>{{ column }}</dt>
              <dd>{{ displayCell(detailRow, column) }}</dd>
            </template>
            <dt>当前状态</dt>
            <dd>{{ detailAssessment.effectiveStatus }}</dd>
            <dt>待补节点</dt>
            <dd>{{ detailAssessment.missing.join('、') || '无' }}</dd>
            <template v-if="detailAssessment.interrupted">
              <dt>中断原因</dt>
              <dd>{{ detailAssessment.cause }}</dd>
            </template>
          </dl>
          <div class="drawer-actions">
            <button
              v-if="detailAssessment.interrupted"
              class="btn primary"
              type="button"
              @click="retryDetail"
            >
              重新拉取
            </button>
          </div>
          <p v-if="detailMessage" class="retry-message">{{ detailMessage }}</p>
        </template>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  assessFlight,
  downloadEntries,
  getFlightEntry,
  listFlightEntries,
  moduleMeta,
  retryFlightFetch,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flight_ops')
const columns = ["航班号", "机尾号", "计划到港", "实际到港", "计划离港", "预计离港", "保障节点", "保障状态"]
const actions = ["启动保障", "确认就绪", "标记延误"]
const statuses = ["待保障", "保障中", "已就绪", "已延误"]
const stats = [{"label": "待保障航班", "value": 0}, {"label": "保障中航班", "value": 0}, {"label": "延误航班", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const detailVisible = ref(false)
const detailRow = ref<EntryRow | null>(null)
const detailId = ref<number | null>(null)
const detailError = ref('')
const detailMessage = ref('')
const detailAssessment = computed(() => (detailRow.value ? assessFlight(detailRow.value) : null))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => assessFlight(row).effectiveStatus === status).length,
  })),
)

function displayCell(row: EntryRow, column: string) {
  const value = row[column]
  return value === undefined || value === null || String(value).trim() === '' ? '—' : value
}

function missingText(row: EntryRow) {
  const missing = assessFlight(row).missing
  return missing.length ? missing.join('、') : '无'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '航班保障登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  loadFailed.value = false
  try {
    const payload = listFlightEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    rows.value = []
    total.value = 0
    loadFailed.value = true
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  detailVisible.value = true
  detailMessage.value = ''
  reloadDetail()
}

function reloadDetail() {
  detailError.value = ''
  if (detailId.value === null) {
    return
  }
  try {
    detailRow.value = getFlightEntry(detailId.value)
  } catch (error) {
    detailRow.value = null
    detailError.value = error instanceof Error ? error.message : '航班保障详情读取失败'
  }
}

function retryDetail() {
  if (detailId.value === null) {
    return
  }
  const result = retryFlightFetch(detailId.value)
  // 重试结果一定说明原因：成功讲清从哪个待补节点继续，失败讲清为什么不能重试。
  detailMessage.value = result.message
  if (result.ok) {
    reload()
    reloadDetail()
  }
}

function closeDetail() {
  detailVisible.value = false
  detailRow.value = null
  detailId.value = null
  detailError.value = ''
  detailMessage.value = ''
}

onMounted(reload)
</script>
