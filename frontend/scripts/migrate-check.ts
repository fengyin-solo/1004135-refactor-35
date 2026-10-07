// 模拟旧骨架用户（localStorage 里是改动前的占位文本种子）的迁移路径
const assert = require('node:assert')
const storage = new Map()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k: string, v: string) => storage.set(k, v),
  },
}

async function main() {
  const legacyStorage = {
    flight_ops: [
      {
        id: 1, status: '待保障', pending: true, abnormal: false,
        '航班号': '航班保障样例1', '机尾号': '航班保障样例1', '计划到港': '航班保障样例1',
        '实际到港': '航班保障样例1', '计划离港': '航班保障样例1', '预计离港': '航班保障样例1',
        '保障节点': '航班保障样例1', '保障状态': '航班保障样例1',
      },
      {
        id: 3, status: '已就绪', pending: false, abnormal: false,
        '航班号': '航班保障样例3', '机尾号': '航班保障样例3', '计划到港': '航班保障样例3',
        '实际到港': '航班保障样例3', '计划离港': '航班保障样例3', '预计离港': '航班保障样例3',
        '保障节点': '航班保障样例3', '保障状态': '航班保障样例3',
      },
    ],
  }
  storage.set('airport-ground-handling:entries', JSON.stringify(legacyStorage))
  const svc = require('../src/api/flight-service')

  const views = svc.listFlights()
  assert.strictEqual(views.length, 2)
  for (const v of views) {
    assert.ok(v.legacy, `${v.flightNo} 应识别为历史旧航班`)
    assert.strictEqual(v.nodes.length, 10)
    assert.ok(v.nodes.every((n: any) => n.state === '待补'))
    assert.ok(v.derivedStatus.includes('缺数据'), v.derivedStatus)
  }
  const oldReady = views.find((v: any) => v.row.id === 3)
  assert.ok(!oldReady.ready)
  assert.ok(oldReady.derivedStatus.includes('计划到港缺失'), oldReady.derivedStatus)
  const r = svc.resumeFlightNode(3)
  assert.ok(r.ok, r.message)
  assert.ok(r.message.includes('靠桥/客梯'), r.message)
  console.log('旧骨架数据迁移检查通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
