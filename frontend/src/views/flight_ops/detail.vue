<template>
  <section class="page" data-module="flight_ops_detail">
    <header class="page-head">
      <div>
        <h2>
          航班保障详情
          <span v-if="view" class="title-sub">（{{ view.flightNo || '航班号待补' }} · 编号 {{ flightId }}）</span>
        </h2>
        <p class="page-desc">节点中断后可在此重新拉取；恢复永远从首个待补节点继续，重复恢复不会覆盖人工延误结论。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/flight_ops">返回航班保障清单</RouterLink>
      </div>
    </header>

    <div v-if="loadError" class="state-banner error">
      <span>{{ loadError }}</span>
      <span class="banner-actions">
        <button class="btn small" type="button" @click="load">重试拉取</button>
        <RouterLink class="btn small ghost" to="/flight_ops">返回清单</RouterLink>
      </span>
    </div>

    <template v-else-if="view">
      <p v-for="warning in view.warnings" :key="warning" class="state-banner warning">{{ warning }}</p>

      <div class="detail-grid">
        <div class="detail-card">
          <h3>航班信息</h3>
          <dl class="detail-list">
            <template v-for="field in infoFields" :key="field.key">
              <dt>{{ field.label }}</dt>
              <dd>
                <input
                  class="inline-input"
                  :value="field.value"
                  :placeholder="field.placeholder"
                  @change="onFieldChange(field.key, ($event.target as HTMLInputElement).value)"
                />
                <span v-if="field.missing" class="field-flag">待补</span>
              </dd>
            </template>
          </dl>
        </div>

        <div class="detail-card">
          <h3>保障状态</h3>
          <p class="status-line">
            <span class="status-badge" :class="badgeClass">{{ view.derivedStatus }}</span>
          </p>
          <p v-if="view.manualDelay" class="delay-note">
            人工延误结论：{{ view.delayReason || '已延误' }}。节点恢复不会覆盖该结论。
          </p>
          <p v-else-if="view.ready" class="ok-text">到港数据齐全且全部节点完成，航班已就绪。</p>
          <p v-else-if="view.resumeNode" class="muted-text">
            下一待补节点：{{ view.resumeNode.name }}
            <template v-if="view.resumeNode.state === '中断'">
              （中断，原因：{{ view.resumeNode.reason || '未记录' }}，可重新拉取）
            </template>
          </p>
          <div class="detail-actions">
            <button class="btn primary" type="button" :disabled="busy" @click="resume">
              {{ resumeLabel }}
            </button>
            <button class="btn" type="button" :disabled="busy" @click="ready">确认就绪</button>
          </div>
          <p v-if="actionMessage" :class="actionOk ? 'ok-text action-msg' : 'error-text action-msg'">
            {{ actionMessage }}
          </p>
        </div>
      </div>

      <div class="detail-card">
        <h3>保障节点（{{ doneCount }}/{{ view.nodes.length }} 完成）</h3>
        <ol class="node-list">
          <li v-for="node in view.nodes" :key="node.name" class="node-item">
            <span class="node-name">{{ node.name }}</span>
            <span class="status-badge small" :class="nodeBadgeClass(node.state)">{{ node.state }}</span>
            <span v-if="node.reason" class="node-reason">{{ node.reason }}</span>
            <span v-if="view.resumeNode?.name === node.name" class="node-next">← 从这里继续</span>
          </li>
        </ol>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  confirmReady,
  getFlight,
  resumeFlightNode,
  updateFlightField,
} from '@/api/flight-service'
import { isValidTime, type FlightFieldKey, type FlightView, type NodeState } from '@/domain/flight'

const route = useRoute()
const flightId = Number(route.params.id)

const view = ref<FlightView | null>(null)
const loadError = ref('')
const actionMessage = ref('')
const actionOk = ref(true)
const busy = ref(false)

const infoFields = computed(() => {
  if (!view.value) {
    return []
  }
  const row = view.value.row
  const define = (
    key: FlightFieldKey,
    label: string,
    value: string,
    missing: boolean,
    placeholder: string,
  ) => ({ key, label, value, missing, placeholder })
  return [
    define('航班号', '航班号', view.value.flightNo, !view.value.flightNo, '例：CA1831'),
    define('机尾号', '机尾号', String(row['机尾号'] ?? ''), !row['机尾号'], '例：B-6610'),
    define('计划到港', '计划到港', view.value.scheduledArrival, !isValidTime(view.value.scheduledArrival), 'YYYY-MM-DD HH:mm'),
    define('实际到港', '实际到港', view.value.actualArrival, !view.value.actualArrival, '航班未到港则为空'),
    define('计划离港', '计划离港', String(row['计划离港'] ?? ''), false, 'YYYY-MM-DD HH:mm'),
    define('预计离港', '预计离港', String(row['预计离港'] ?? ''), false, 'YYYY-MM-DD HH:mm'),
  ]
})

const doneCount = computed(() =>
  view.value ? view.value.nodes.filter((node) => node.state === '已完成').length : 0,
)

const resumeLabel = computed(() => {
  const target = view.value?.resumeNode
  if (!target) {
    return '无待补节点'
  }
  return target.state === '中断'
    ? `重新拉取「${target.name}」`
    : `从待补处继续：${target.name}`
})

const badgeClass = computed(() => {
  const status = view.value?.derivedStatus ?? ''
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
})

function nodeBadgeClass(state: NodeState): string {
  if (state === '已完成') {
    return 'badge-success'
  }
  if (state === '中断') {
    return 'badge-danger'
  }
  if (state === '进行中') {
    return 'badge-neutral'
  }
  return 'badge-warning'
}

function load() {
  loadError.value = ''
  actionMessage.value = ''
  try {
    view.value = getFlight(flightId)
  } catch (error) {
    view.value = null
    loadError.value = error instanceof Error ? error.message : '航班保障详情读取失败，请点重试重新拉取'
  }
}

function onFieldChange(field: FlightFieldKey, value: string) {
  // 允许清空实际到港（表示仍未到港），其余字段清空会被服务拦下并说明原因
  const result = updateFlightField(flightId, field, value)
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    load()
  }
}

function resume() {
  busy.value = true
  try {
    // 中断后从待补处继续：中断节点先重试本身，再顺序往后拉；失败时把原因讲清楚
    const result = resumeFlightNode(flightId)
    actionOk.value = result.ok
    actionMessage.value = result.message
    if (result.ok) {
      load()
    }
  } finally {
    busy.value = false
  }
}

function ready() {
  const result = confirmReady(flightId)
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    load()
  }
}

load()
</script>
