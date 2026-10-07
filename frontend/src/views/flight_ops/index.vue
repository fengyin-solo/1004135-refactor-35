<template>
  <section class="page" data-module="flight_ops">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">围绕航班号、计划到港、实际到港与保障节点统一判定就绪状态；实际到港为空或节点未完成时不会显示已就绪。</p>
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

    <!-- 读取异常：列表内联给出原因与重试入口，不再只在页脚报错 -->
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
          <th>保障详情</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in views" :key="item.row.id">
          <td>{{ item.flightNo || '—' }}</td>
          <td>{{ item.row['机尾号'] || '—' }}</td>
          <td :class="{ 'cell-missing': !item.scheduledArrival }">
            {{ item.scheduledArrival || '待补录' }}
          </td>
          <td :class="{ 'cell-missing': !item.actualArrival }">
            {{ item.actualArrival || '未到港（待补）' }}
          </td>
          <td>{{ item.row['计划离港'] || '—' }}</td>
          <td>{{ item.row['预计离港'] || '—' }}</td>
          <td>{{ nodeSummary(item) }}</td>
          <td><span class="status-badge" :class="badgeClass(item.derivedStatus)">{{ item.derivedStatus }}</span></td>
          <td>
            <RouterLink class="link" :to="`/flight_ops/${item.row.id}`">进入详情</RouterLink>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('启动保障', item)">启动保障</button>
            <button class="link" type="button" @click="runAction('确认就绪', item)">确认就绪</button>
            <button class="link" type="button" @click="promptDelay(item)">标记延误</button>
          </td>
        </tr>
        <tr v-if="!views.length">
          <!-- 空数据：列表入口给「暂无」提示，与读取异常区分开 -->
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的航班保障数据，可调整筛选条件或先登记航班保障</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录（状态由航班号、计划到港、保障节点统一判定）</span>
      <span v-if="actionMessage" :class="actionOk ? 'ok-text' : 'error-text'">{{ actionMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmReady,
  downloadFlights,
  listFlights,
  markDelay,
  startFlight,
} from '@/api/flight-service'
import type { FlightView } from '@/domain/flight'

const columns = ['航班号', '机尾号', '计划到港', '实际到港', '计划离港', '预计离港', '保障节点', '保障状态']
const filterFields = ['航班号', '机尾号', '计划到港']

const views = ref<FlightView[]>([])
const total = ref(0)
const loadError = ref('')
const actionMessage = ref('')
const actionOk = ref(true)
const filters = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: '待保障航班', value: countBy((item) => item.row.status === '待保障') },
  { label: '保障中航班', value: countBy((item) => item.row.status === '保障中') },
  { label: '缺数据航班', value: countBy((item) => item.derivedStatus.includes('缺数据') || item.derivedStatus.includes('节点中断')) },
  { label: '延误航班', value: countBy((item) => item.manualDelay) },
])

function countBy(predicate: (item: FlightView) => boolean): number {
  return views.value.filter(predicate).length
}

const statusSummary = computed(() =>
  ['待保障', '保障中', '已就绪', '已延误'].map((status) => ({
    status,
    count: views.value.filter((item) => item.row.status === status).length,
  })),
)

function nodeSummary(item: FlightView): string {
  const done = item.nodes.filter((node) => node.state === '已完成').length
  const interrupted = item.nodes.find((node) => node.state === '中断')
  if (interrupted) {
    return `${done}/${item.nodes.length} · 中断：${interrupted.name}`
  }
  const next = item.resumeNode
  if (next) {
    return `${done}/${item.nodes.length} · 待补：${next.name}`
  }
  return `${done}/${item.nodes.length} · 全部完成`
}

function badgeClass(status: string): string {
  if (status.startsWith('已延误')) {
    return 'badge-danger'
  }
  if (status.includes('缺数据') || status.includes('中断')) {
    return 'badge-warning'
  }
  if (status === '已就绪') {
    return 'badge-success'
  }
  return 'badge-neutral'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadFlights(filters.value)
}

function openCreate() {
  actionOk.value = false
  actionMessage.value = '航班保障登记入口尚未接入审批流'
}

function runAction(action: '启动保障' | '确认就绪', item: FlightView) {
  const result = action === '启动保障'
    ? startFlight(Number(item.row.id))
    : confirmReady(Number(item.row.id))
  actionOk.value = result.ok
  // 重试 / 校验失败必须说明原因，便于值班员知道卡在哪
  actionMessage.value = result.message
  if (result.ok) {
    reload()
  }
}

function promptDelay(item: FlightView) {
  const current = item.manualDelay ? `（当前结论：${item.delayReason || '已延误'}）` : ''
  const input = window.prompt(`请填写${item.flightNo || '该航班'}的延误原因${current}：`, item.delayReason)
  if (input === null) {
    return
  }
  const result = markDelay(Number(item.row.id), input)
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    reload()
  }
}

function reload() {
  loadError.value = ''
  actionMessage.value = ''
  try {
    const payload = listFlights(filters.value)
    views.value = payload
    total.value = payload.length
  } catch (error) {
    // 读取异常时清空旧列表，避免旧数据与错误提示同时出现
    views.value = []
    total.value = 0
    loadError.value = error instanceof Error ? error.message : '航班保障列表读取失败，请点重试重新拉取'
  }
}

onMounted(reload)
</script>
