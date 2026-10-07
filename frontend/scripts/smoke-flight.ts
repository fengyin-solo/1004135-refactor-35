// 冒烟测试：验证统一判定、旧航班迁移、中断恢复、人工延误保护、过站待补同步。
// 用 tsc 转译为 CommonJS 后运行（仓库构建走 vite，这里仅用于无浏览器环境的逻辑验证）。
const assert = require('node:assert')

// localStorage 垫片，预置一份与种子等价的数据（含旧结构与损坏明细）
const storage = new Map()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k: string, v: string) => storage.set(k, v),
  },
}

async function main() {
  const { SEED_ROWS } = require('../src/data/seed')

  let svc: any
  let domain: any
  function resetState() {
    // 每轮检查回到种子数据并丢弃模块级内存缓存，避免上一轮操作影响本轮断言
    storage.set('airport-ground-handling:entries', JSON.stringify(SEED_ROWS))
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/smoke-build/src/')) {
        delete require.cache[key]
      }
    }
    svc = require('../src/api/flight-service')
    domain = require('../src/domain/flight')
  }

  let pass = 0
  function check(name: string, fn: () => void) {
    resetState()
    fn()
    pass++
    console.log('PASS:', name)
  }

  // 1. CA1831 已就绪但实际到港为空 → 统一判定必须降级为缺数据
  check('实际到港为空不显示已就绪', () => {
    const views = svc.listFlights()
    const ca1831 = views.find((v: any) => v.flightNo === 'CA1831')
    assert.ok(ca1831, 'CA1831 存在')
    assert.ok(!ca1831.ready, 'ready 必须为 false')
    assert.ok(ca1831.derivedStatus.startsWith('缺数据'), '状态降级为缺数据，实际：' + ca1831.derivedStatus)
    assert.ok(ca1831.derivedStatus.includes('实际到港为空'), '原因注明实际到港为空')
    const ready = svc.confirmReady(ca1831.row.id)
    assert.ok(!ready.ok, '确认就绪必须被拦截')
    assert.ok(ready.message.includes('实际到港为空'), '重试说明原因：' + ready.message)
  })

  // 2. CA1832 加油中断 → 恢复先重试中断节点，再逐个继续
  check('中断节点可重新拉取并从待补处继续', () => {
    let views = svc.listFlights()
    const id = views.find((v: any) => v.flightNo === 'CA1832').row.id
    assert.ok(views.find((v: any) => v.flightNo === 'CA1832').derivedStatus.includes('节点中断（加油作业'))

    const r1 = svc.resumeFlightNode(id)
    assert.ok(r1.ok, r1.message)
    assert.ok(r1.message.includes('中断节点「加油作业」已重新拉取'), r1.message)
    assert.ok(r1.message.includes('航食配餐'), '提示下一个待补节点：' + r1.message)

    // 继续 5 次：航食、清洁、排污、装舱、关舱 → 全部完成自动就绪
    let last
    for (let i = 0; i < 5; i++) {
      last = svc.resumeFlightNode(id)
      assert.ok(last.ok, `第 ${i + 1} 次继续失败：${last.message}`)
    }
    assert.ok(last.message.includes('自动确认就绪'), last.message)
    views = svc.listFlights()
    const done = views.find((v: any) => v.row.id === id)
    assert.strictEqual(done.row.status, '已就绪')
    assert.ok(done.ready)
  })

  // 3. MU5206 人工延误 → 重复恢复不覆盖结论
  check('重复恢复不覆盖人工延误结论', () => {
    const views = svc.listFlights()
    const v = views.find((x: any) => x.flightNo === 'MU5206')
    assert.ok(v.manualDelay)
    const r = svc.resumeFlightNode(v.row.id)
    assert.ok(!r.ok)
    assert.ok(r.message.includes('人工延误结论'), r.message)
    const ready = svc.confirmReady(v.row.id)
    assert.ok(!ready.ok && ready.message.includes('人工延误结论'))
    const after = svc.listFlights().find((x: any) => x.flightNo === 'MU5206')
    assert.strictEqual(after.row.status, '已延误')
    assert.ok(after.derivedStatus.includes('流控等待起飞时刻'))
  })

  // 4. 历史旧航班 CA199 无节点明细 → 迁移补录为待补，可继续
  check('历史旧航班兼容：补节点并可从待补继续', () => {
    let views = svc.listFlights()
    const legacy = views.find((v: any) => v.flightNo === 'CA199')
    assert.ok(legacy.legacy)
    assert.strictEqual(legacy.nodes.length, domain.FLIGHT_NODES.length)
    assert.ok(legacy.nodes.every((n: any) => n.state === '待补'))
    assert.ok(legacy.warnings.some((w: string) => w.includes('历史旧航班')))
    const r = svc.resumeFlightNode(legacy.row.id)
    assert.ok(r.ok, r.message)
    assert.ok(r.message.includes('从待补处继续') && r.message.includes('靠桥/客梯'), r.message)
    views = svc.listFlights()
    const again = views.find((v: any) => v.flightNo === 'CA199')
    assert.strictEqual(again.nodes[0].state, '已完成')
  })

  // 5. HU7802 节点明细损坏 → 自愈重建并告警
  check('损坏节点明细自愈', () => {
    const v = svc.listFlights().find((x: any) => x.flightNo === 'HU7802')
    assert.strictEqual(v.nodes.length, 10)
    assert.ok(v.warnings.some((w: string) => w.includes('损坏')))
  })

  // 6. CZ3180 未到港 → 继续保障被拦截并说明原因；补录实际到港后放行
  check('实际到港为空时继续拦截，补录后继续', () => {
    let v = svc.listFlights().find((x: any) => x.flightNo === 'CZ3180')
    const blocked = svc.resumeFlightNode(v.row.id)
    assert.ok(!blocked.ok && blocked.message.includes('实际到港为空'), blocked.message)
    const save = svc.updateFlightField(v.row.id, '实际到港', '2026-10-07 11:02')
    assert.ok(save.ok, save.message)
    v = svc.listFlights().find((x: any) => x.flightNo === 'CZ3180')
    const r = svc.resumeFlightNode(v.row.id)
    assert.ok(r.ok && r.message.includes('开舱下客'), r.message)
  })

  // 7. 字段校验：航班号 / 时间格式
  check('统一字段判定', () => {
    assert.ok(domain.isValidTime('2026-10-07 09:02'))
    assert.ok(!domain.isValidTime('航班保障样例1'))
    assert.ok(!domain.isValidTime(''))
    assert.ok(domain.validateFlightField('航班号', 'ca1831', false) === null)
    assert.ok(domain.validateFlightField('航班号', 'CA18', false).includes('格式'))
    assert.ok(domain.validateFlightField('计划到港', '', false).includes('不能为空'))
    assert.strictEqual(domain.normalizeFlightNo(' ca1832 '), 'CA1832')
  })

  // 8. 过站监控清单同步待补节点
  check('过站清单同步待补节点', () => {
    assert.ok(svc.pendingNodeSummary('CA1832').startsWith('中断：加油作业'), svc.pendingNodeSummary('CA1832'))
    assert.ok(svc.pendingNodeSummary('CA1833').includes('待补'), svc.pendingNodeSummary('CA1833'))
    assert.ok(svc.pendingNodeSummary('MU5206').startsWith('待补'))
    assert.strictEqual(svc.pendingNodeSummary('CA1820'), '')
  })

  // 9. 读取不存在的航班详情给出明确原因
  check('详情读取异常说明原因', () => {
    assert.throws(() => svc.getFlight(99999), /不存在或已被删除/)
  })

  console.log(`\n全部 ${pass} 组检查通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
