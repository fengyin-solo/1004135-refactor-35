<template>
  <section class="page" data-module="turnaround">
    <header class="page-head">
      <div>
        <h2>过站监控管理</h2>
        <p class="page-desc">过站清单与航班保障节点同源：关联航班的中断、待补节点会同步显示在「待补节点」列。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记过站记录</button>
        <button class="btn" type="button" @click="exportRows">导出过站监控清单</button>
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

    <!-- 读取异常：列表入口给出原因与重试，不再静默留在旧数据 -->
    <div v-if="loadError" class="state-banner error">
      <span>{{ loadError }}</span>
      <span class="banner-actions">
        <button class="btn small" type="button" @click="reload">重试拉取</button>
      </span>
    </div>

    <table v-else class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '待补节点'">
              <span :class="pendingClass(row)">{{ pendingText(row) }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的过站监控数据，可调整筛选条件或先登记过站记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条过站监控记录（待补节点与航班保障详情实时同步）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { pendingNodeSummary } from '@/api/flight-service'
import { normalizeFlightNo } from '@/domain/flight'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('turnaround')
// 待补节点列紧跟保障进度，与航班保障详情用同一份节点判定。
const columns = ['过站编号', '关联航班', '计划到港', '实际到港', '过站时长', '保障进度', '待补节点', '异常事项', '过站状态']
const actions = ['开始监测', '正常完成', '标记超时']
const statuses = ['待监测', '监测中', '正常完成', '已超时']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const loadError = ref('')
// 待补节点与航班保障同源：reload 时一次性同步，避免渲染期逐行重复拉取
const pendingMap = ref<Map<string, string>>(new Map())
const filters = ref<Record<string, string>>({})
const filterFields = ['过站编号', '关联航班', '计划到港']

const stats = computed(() => [
  { label: '监测中航班', value: rows.value.filter((row) => row.status === '监测中').length },
  { label: '正常完成航班', value: rows.value.filter((row) => row.status === '正常完成').length },
  { label: '超时航班', value: rows.value.filter((row) => row.status === '已超时').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function pendingText(row: EntryRow): string {
  // 同步航班保障侧的待补节点；空串表示关联不到对应航班，明确提示避免空白误导
  const summary = pendingMap.value.get(normalizeFlightNo(row['关联航班'])) ?? ''
  return summary || '未关联到航班保障节点'
}

function pendingClass(row: EntryRow): string {
  const text = pendingText(row)
  if (text.startsWith('中断')) {
    return 'cell-danger'
  }
  if (text.startsWith('待补')) {
    return 'cell-warning'
  }
  if (text === '节点齐') {
    return 'cell-ok'
  }
  return 'cell-muted'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '过站记录登记入口尚未接入审批流'
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
  loadError.value = ''
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 同步关联航班的待补节点（该调用会顺带完成旧航班的节点迁移）
    const map = new Map<string, string>()
    for (const row of payload.items) {
      const key = normalizeFlightNo(row['关联航班'])
      if (key && !map.has(key)) {
        map.set(key, pendingNodeSummary(key))
      }
    }
    pendingMap.value = map
  } catch (error) {
    rows.value = []
    total.value = 0
    loadError.value = error instanceof Error ? error.message : '过站监控列表读取失败，请点重试重新拉取'
  }
}

onMounted(reload)
</script>
