/**
 * 批次整批导入端到端验证（使用内存假数据库执行器，精确模拟所用 SQL 语义：
 * 事务、pg_advisory_xact_lock 串行锁、ANY 数组查询、VALUES JOIN 重复判定、
 * RETURNING 以及积分/徽章/信用结算查询）。
 */
import { randomUUID } from 'crypto';
import pool from '../db/pool';
import { importServiceRecordBatch, getServiceRecordBatch, getServiceRecordBatchDetails } from '../services/batchService';
import { createServiceRecord } from '../services/volunteerService';
import { calculatePoints } from '../services/pointsCalculator';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: unknown;
}

const testResults: TestResult[] = [];
const assert = (name: string, condition: boolean, error?: string, details?: unknown): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  console.log(`${condition ? '✓ PASS' : '✗ FAIL'} ${name}`);
  if (!condition && error) console.log(`  Error: ${error}`);
  if (details) console.log(`  Details: ${JSON.stringify(details)}`);
};

const NOW = new Date('2026-09-22T10:00:00.000Z');

interface VolunteerRow {
  id: string; name: string; phone: string | null; email: string | null;
  total_points: number; level: number; credit_score: number; service_count: number;
  is_active: boolean; created_at: Date; updated_at: Date;
}
interface RecordRow {
  id: string; volunteer_id: string; service_type: string; duration_hours: number;
  rating: number; points_earned: number; is_no_show: boolean; location: string | null;
  description: string | null; recorded_at: Date; batch_id: string | null; line_no: number | null;
  created_at: Date; updated_at: Date;
}
interface BatchRow {
  id: string; batch_no: string; status: 'processing' | 'completed' | 'rejected';
  total_count: number; success_count: number; fail_count: number;
  errors: unknown; result_snapshot: unknown; created_by: string; created_at: Date; processed_at: Date | null;
}

const volunteers = new Map<string, VolunteerRow>();
const serviceRecords: RecordRow[] = [];
const batches = new Map<string, BatchRow>();
const pointsLogs: unknown[] = [];
const creditLogs: unknown[] = [];
const badgesList: { volunteer_id: string; star_level: number }[] = [];
const complaints: { volunteer_id: string; status: string }[] = [];

const mkVolunteer = (id: string, overrides: Partial<VolunteerRow> = {}): void => {
  volunteers.set(id, {
    id, name: 'v' + id.slice(0, 4), phone: null, email: null,
    total_points: 0, level: 1, credit_score: 100, service_count: 0,
    is_active: true, created_at: NOW, updated_at: NOW, ...overrides,
  });
};

// ---- 咨询锁真实串行化 ----
const lockWaiters = new Map<string, Array<() => void>>();
const heldLocks = new Set<string>();
const acquireLock = (key: string): Promise<void> | void => {
  if (heldLocks.has(key)) {
    return new Promise<void>(resolve => {
      const arr = lockWaiters.get(key) || [];
      arr.push(resolve);
      lockWaiters.set(key, arr);
    });
  }
  heldLocks.add(key);
};
const releaseLocks = (): void => {
  heldLocks.clear();
  lockWaiters.forEach(waiters => waiters.forEach(w => w()));
  lockWaiters.clear();
};

const hashKey = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
};

const clampCredit = (v: VolunteerRow): number => {
  const recs = serviceRecords.filter(r => r.volunteer_id === v.id).slice(-50);
  let score = 100;
  score += Math.min(v.service_count * 0.5, 10);
  if (recs.length) {
    const avg = recs.reduce((s, r) => s + r.rating, 0) / recs.length;
    score += (avg - 3) * 15;
  }
  score -= serviceRecords.filter(r => r.volunteer_id === v.id && r.is_no_show).length * 20;
  score -= complaints.filter(c => c.volunteer_id === v.id && (c.status === 'pending' || c.status === 'resolved')).length * 15;
  return Math.max(0, Math.min(120, Math.round(score)));
};

const fakeQuery = async (text: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
  const t = text.replace(/\s+/g, ' ').trim();

  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
    if (t !== 'BEGIN') releaseLocks();
    return { rows: [] };
  }
  if (t.startsWith('SELECT hashtextextended')) return { rows: [{ lock_key: hashKey(String(params[0])) }] };
  if (t.startsWith('SELECT pg_advisory_xact_lock')) {
    const r = acquireLock(String(params[0]));
    if (r) await r;
    return { rows: [] };
  }
  if (t.startsWith('SELECT CURRENT_TIMESTAMP')) return { rows: [{ now: NOW }] };

  // 批次
  if (t.startsWith('SELECT * FROM service_record_batches WHERE batch_no')) {
    const row = batches.get(String(params[0]));
    return { rows: row ? [row] : [] };
  }
  if (t.startsWith('INSERT INTO service_record_batches')) {
    const row: BatchRow = {
      id: randomUUID(), batch_no: String(params[0]), status: 'processing',
      total_count: Number(params[1]), success_count: 0, fail_count: 0,
      errors: null, result_snapshot: null, created_by: String(params[2]),
      created_at: NOW, processed_at: null,
    };
    batches.set(row.batch_no, row);
    return { rows: [row] };
  }
  if (t.startsWith('UPDATE service_record_batches') && t.includes("'rejected'")) {
    const id = String(params[2]);
    const row = [...batches.values()].find(b => b.id === id)!;
    row.status = 'rejected';
    row.fail_count = Number(params[0]);
    row.errors = JSON.parse(String(params[1]));
    row.processed_at = NOW;
    return { rows: [] };
  }
  if (t.startsWith('UPDATE service_record_batches') && t.includes("'completed'")) {
    const id = String(params[2]);
    const row = [...batches.values()].find(b => b.id === id)!;
    row.status = 'completed';
    row.success_count = Number(params[0]);
    row.result_snapshot = JSON.parse(String(params[1]));
    row.processed_at = NOW;
    return { rows: [row] };
  }

  // 志愿者
  if (t.startsWith('SELECT * FROM volunteers WHERE id = ANY')) {
    const ids = params[0] as string[];
    return { rows: ids.map(id => volunteers.get(id)).filter(Boolean).sort((a, b) => a!.id.localeCompare(b!.id)) };
  }
  if (t.startsWith('SELECT * FROM volunteers WHERE id = $1')) {
    const v = volunteers.get(String(params[0]));
    return { rows: v ? [v] : [] };
  }
  if (t.startsWith('UPDATE volunteers SET total_points')) {
    const v = volunteers.get(String(params[3]))!;
    v.total_points = Number(params[0]);
    v.level = Number(params[1]);
    v.service_count += Number(params[2]);
    return { rows: [] };
  }
  if (t.startsWith('UPDATE volunteers SET credit_score')) {
    const v = volunteers.get(String(params[1]))!;
    v.credit_score = Number(params[0]);
    return { rows: [] };
  }

  // 服务记录
  if (t.startsWith('INSERT INTO service_records')) {
    const isBatch = params.length === 11;
    const row: RecordRow = isBatch
      ? {
          id: randomUUID(),
          volunteer_id: String(params[0]), service_type: String(params[1]),
          duration_hours: Number(params[2]), rating: Number(params[3]),
          points_earned: Number(params[4]), is_no_show: Boolean(params[5]),
          location: (params[6] as string | null) ?? null,
          description: (params[7] as string | null) ?? null,
          recorded_at: new Date(params[8] as string), batch_id: String(params[9]),
          line_no: Number(params[10]), created_at: NOW, updated_at: NOW,
        }
      : {
          id: randomUUID(),
          volunteer_id: String(params[0]), service_type: String(params[1]),
          duration_hours: Number(params[2]), rating: Number(params[3]),
          points_earned: Number(params[4]), is_no_show: Boolean(params[5]),
          location: (params[6] as string | null) ?? null,
          description: (params[7] as string | null) ?? null,
          recorded_at: NOW, batch_id: null, line_no: null,
          created_at: NOW, updated_at: NOW,
        };
    serviceRecords.push(row);
    return { rows: [row] };
  }
  if (t.includes('FROM service_records WHERE volunteer_id = $1 ORDER BY recorded_at DESC LIMIT 50')) {
    return { rows: serviceRecords.filter(r => r.volunteer_id === String(params[0])).slice(-50).reverse() };
  }
  if (t.includes('COUNT(*) as count FROM service_records WHERE volunteer_id = $1 AND is_no_show = true')) {
    return { rows: [{ count: String(serviceRecords.filter(r => r.volunteer_id === String(params[0]) && r.is_no_show).length) }] };
  }
  if (t.startsWith('SELECT COUNT(*) AS total FROM service_records WHERE batch_id')) {
    return { rows: [{ count: String(serviceRecords.filter(r => r.batch_id === String(params[0])).length) }] };
  }
  if (t.startsWith('SELECT * FROM service_records WHERE batch_id')) {
    return { rows: serviceRecords.filter(r => r.batch_id === String(params[0])).sort((a, b) => a.line_no! - b.line_no!) };
  }

  // VALUES JOIN 重复判定
  if (t.includes('JOIN service_records sr')) {
    const matchedLines = new Set<number>();
    for (let i = 0; i < params.length; i += 6) {
      const [vid, at, type, dur, loc, line] = params.slice(i, i + 6);
      const hit = serviceRecords.some(r =>
        r.volunteer_id === String(vid) &&
        new Date(r.recorded_at).getTime() === new Date(at as Date).getTime() &&
        r.service_type === String(type) &&
        Number(r.duration_hours).toFixed(2) === Number(dur).toFixed(2) &&
        (r.location ?? '') === (loc == null ? '' : String(loc))
      );
      if (hit) matchedLines.add(Number(line));
    }
    return { rows: [...matchedLines].map(line => ({ line })) };
  }

  // 积分/信用日志
  if (t.startsWith('INSERT INTO points_logs')) {
    pointsLogs.push({ volunteer_id: String(params[0]), change_amount: Number(params[1]), reason: String(params[2]) });
    return { rows: [] };
  }
  if (t.startsWith('INSERT INTO credit_logs')) {
    creditLogs.push({ volunteer_id: String(params[0]), change_amount: Number(params[1]), reason: String(params[2]) });
    return { rows: [] };
  }

  // 徽章
  if (t.startsWith('SELECT * FROM badges WHERE volunteer_id')) {
    return { rows: badgesList.filter(b => b.volunteer_id === String(params[0])) };
  }
  if (t.startsWith('INSERT INTO badges')) {
    badgesList.push({ volunteer_id: String(params[0]), star_level: Number(params[1]) });
    return { rows: [{ volunteer_id: String(params[0]), star_level: Number(params[1]) }] };
  }

  // 投诉（信用重算用）
  if (t.startsWith('SELECT * FROM complaints WHERE volunteer_id')) {
    return { rows: complaints.filter(c => c.volunteer_id === String(params[0])) };
  }

  throw new Error('未模拟的 SQL: ' + t);
};

// 将假库注入 pg 池
(pool as any).query = (text: string, params?: unknown[]) => fakeQuery(text, params);
(pool as any).connect = async () => ({
  query: (text: string, params?: unknown[]) => fakeQuery(text, params),
  release: () => undefined,
});

// 让信用重算逻辑使用与服务端完全一致的算法分支：fake 的 UPDATE volunteers SET credit_score 已模拟，
// 这里重算结果由服务函数自身计算，fake 只负责存储。
const run = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  批次整批导入验证（内存数据库）');
  console.log('========================================\n');

  const v1 = '11111111-1111-1111-1111-111111111111';
  const v2 = '22222222-2222-2222-2222-222222222222';
  const v3 = '33333333-3333-3333-3333-333333333333';
  mkVolunteer(v1, { total_points: 95 });
  mkVolunteer(v2);
  mkVolunteer(v3, { is_active: false });

  // 预置一条已入账记录（v2），用于库内重复判定
  const existingAt = new Date('2026-09-20T08:00:00.000Z');
  serviceRecords.push({
    id: randomUUID(), volunteer_id: v2, service_type: 'education', duration_hours: 1.5,
    rating: 5, points_earned: 20, is_no_show: false, location: '图书馆',
    description: null, recorded_at: existingAt, batch_id: null, line_no: null,
    created_at: NOW, updated_at: NOW,
  });

  // ---------------- 场景1：全部合格，整批入账 ----------------
  console.log('--- 场景1: 全部合格统一入账 ---');
  const goodRecords = [
    { volunteer_id: v1, service_type: 'elderly_care', duration_hours: 2, rating: 5, location: '敬老院', recorded_at: new Date('2026-09-21T09:00:00Z') },
    { volunteer_id: v1, service_type: 'environmental', duration_hours: 4, rating: 5, location: '河边公园', recorded_at: new Date('2026-09-21T14:00:00Z') },
  ];
  const good = await importServiceRecordBatch('BATCH-OK-001', goodRecords, 'admin');
  assert('合格批次返回200', good.status === 200, `实际 ${good.status}`, good.body);
  assert('success=true', good.body.success === true);
  const gdata = good.body.data as any;
  assert('成功2条', gdata.successCount === 2 && gdata.total === 2, undefined, gdata);
  assert('生成2条记录ID', gdata.recordIds.length === 2);
  const inserted = serviceRecords.filter(r => r.batch_id === gdata.batch_id);
  assert('服务记录已写入2条', inserted.length === 2);
  const p1 = calculatePoints(2, 'elderly_care', 5);
  const p2 = calculatePoints(4, 'environmental', 5);
  assert('记录积分正确', inserted[0].points_earned === p1 && inserted[1].points_earned === p2,
    `${p1}/${p2}`, inserted.map(r => r.points_earned));
  const v1row = volunteers.get(v1)!;
  assert('志愿者积分累计更新', v1row.total_points === 95 + p1 + p2, undefined, { total: v1row.total_points });
  assert('服务次数+2', v1row.service_count === 2);
  assert('等级提升到2级', v1row.level === 2, undefined, { level: v1row.level });
  assert('二星徽章已发放', badgesList.some(b => b.volunteer_id === v1 && b.star_level === 2));
  assert('积分日志2条', pointsLogs.filter(l => (l as any).volunteer_id === v1).length === 2);
  // 信用: 100 + min(2*0.5,10)=1 + (5-3)*15=30 => 131 clamp 120
  assert('信用分重算为120', v1row.credit_score === 120, undefined, { credit: v1row.credit_score });
  assert('信用日志已记录', creditLogs.some(l => (l as any).volunteer_id === v1 && (l as any).change_amount === 20));
  assert('行号被保存', inserted[0].line_no === 1 && inserted[1].line_no === 2);

  // ---------------- 场景2：整批审查失败，返回全部行号，零写入 ----------------
  console.log('\n--- 场景2: 存在问题整批拒绝，返回全部行号 ---');
  const pointsBefore = v1row.total_points;
  const recordsBefore = serviceRecords.length;
  const logsBefore = pointsLogs.length;
  const badRecords = [
    { volunteer_id: v1, service_type: 'education', duration_hours: 1, rating: 5, location: 'A点', recorded_at: new Date('2026-09-21T08:00:00Z') }, // 行1 合格
    { volunteer_id: v3, service_type: 'education', duration_hours: 1, rating: 5, location: 'A点', recorded_at: new Date('2026-09-21T08:00:00Z') }, // 行2 未启用
    { volunteer_id: v1, service_type: 'education', duration_hours: 1, rating: 5, location: '未来', recorded_at: new Date('2027-01-01T00:00:00Z') }, // 行3 未来时间
    { volunteer_id: v1, service_type: 'education', duration_hours: 1, rating: 5, location: 'A点', recorded_at: new Date('2026-09-21T08:00:00Z') }, // 行4 批内重复(与行1)
    { volunteer_id: v2, service_type: 'education', duration_hours: 1.5, rating: 5, location: '图书馆', recorded_at: existingAt }, // 行5 与库内重复
    { volunteer_id: 'not-a-uuid', service_type: 'education', duration_hours: 1 }, // 行6 格式错误
  ];
  const bad = await importServiceRecordBatch('BATCH-BAD-001', badRecords, 'admin');
  assert('问题批次返回400', bad.status === 400, `实际 ${bad.status}`);
  assert('success=false', bad.body.success === false);
  const bdata = bad.body.data as any;
  const lines = bdata.errors.map((e: any) => e.line).sort((a: number, b: number) => a - b);
  assert('返回全部问题行号 [2,3,4,5,6]', JSON.stringify(lines) === JSON.stringify([2, 3, 4, 5, 6]), undefined, lines);
  const codes = Object.fromEntries(bdata.errors.map((e: any) => [e.line, e.code]));
  assert('行2=未启用', codes[2] === 'VOLUNTEER_INACTIVE');
  assert('行3=未来时间', codes[3] === 'FUTURE_RECORDED_AT');
  assert('行4=批内重复', codes[4] === 'DUPLICATE_IN_BATCH');
  assert('行5=库内重复', codes[5] === 'DUPLICATE_EXISTING');
  assert('行6=格式错误', codes[6] === 'INVALID_FORMAT');
  assert('零服务记录写入', serviceRecords.length === recordsBefore);
  assert('零积分日志写入', pointsLogs.length === logsBefore);
  assert('志愿者积分未变', volunteers.get(v1)!.total_points === pointsBefore);
  assert('服务次数未变', volunteers.get(v1)!.service_count === 2);
  const rejectedBatch = batches.get('BATCH-BAD-001')!;
  assert('拒绝批次已持久化(status=rejected)', rejectedBatch.status === 'rejected');
  assert('拒绝批次fail_count=6', rejectedBatch.fail_count === 6);

  // ---------------- 场景3：批次号重复 = 幂等回读，不产生第二套结果 ----------------
  console.log('\n--- 场景3: 批次号重复幂等 ---');
  const replay = await importServiceRecordBatch('BATCH-OK-001', goodRecords, 'admin');
  assert('重复批次返回200', replay.status === 200);
  const rdata = replay.body.data as any;
  assert('标记 replayed=true', rdata.replayed === true);
  assert('仍只有2条记录', serviceRecords.filter(r => r.batch_id === rdata.batch_id).length === 2);
  assert('志愿者积分未二次累加', volunteers.get(v1)!.total_points === pointsBefore);
  const replayBad = await importServiceRecordBatch('BATCH-BAD-001', badRecords, 'admin');
  assert('拒绝批次重复提交仍为400', replayBad.status === 400);
  assert('拒绝批次回读标记 replayed=true', (replayBad.body.data as any).replayed === true);

  // ---------------- 场景4：并发提交同一批次号只产生一套结果 ----------------
  console.log('\n--- 场景4: 并发同批次号 ---');
  mkVolunteer('44444444-4444-4444-4444-444444444444');
  const concRecs = [{
    volunteer_id: '44444444-4444-4444-4444-444444444444',
    service_type: 'other', duration_hours: 1, rating: 4, location: '并发点',
    recorded_at: new Date('2026-09-22T09:00:00Z'),
  }];
  const [c1, c2] = await Promise.all([
    importServiceRecordBatch('BATCH-CONC-001', concRecs, 'admin'),
    importServiceRecordBatch('BATCH-CONC-001', concRecs, 'admin'),
  ]);
  const replayedFlags = [c1.body.data, c2.body.data].map((d: any) => d.replayed).sort();
  assert('并发结果一个首次一个回放', JSON.stringify(replayedFlags) === JSON.stringify([false, true]),
    undefined, { a: (c1.body.data as any).replayed, b: (c2.body.data as any).replayed });
  assert('只写入1条记录', serviceRecords.filter(r => r.batch_id === (c1.body.data as any).batch_id).length === 1);
  assert('两条响应快照一致(记录ID)',
    (c1.body.data as any).recordIds[0] === (c2.body.data as any).recordIds[0]);

  // ---------------- 场景5：批次结果与明细回读 ----------------
  console.log('\n--- 场景5: 批次回读 ---');
  const summary = await getServiceRecordBatch('BATCH-OK-001');
  assert('批次结果可回读', summary.success === true && summary.data!.status === 'completed');
  const details = await getServiceRecordBatchDetails('BATCH-OK-001', 1, 20);
  assert('批次明细可回读', details.success === true && details.data!.records.length === 2);
  assert('明细按行号排序', details.data!.records[0].line_no === 1 && details.data!.records[1].line_no === 2);
  const rejectSummary = await getServiceRecordBatch('BATCH-BAD-001');
  assert('拒绝批次也可回读', rejectSummary.success === true && rejectSummary.data!.status === 'rejected');
  const missing = await getServiceRecordBatch('NOT-EXIST');
  assert('不存在批次返回失败', missing.success === false);

  // ---------------- 场景6：志愿者不存在 + 缺省时间/地点 ----------------
  console.log('\n--- 场景6: 志愿者不存在 ---');
  const ghost = await importServiceRecordBatch('BATCH-GHOST-1', [
    { volunteer_id: '99999999-9999-9999-9999-999999999999', service_type: 'other', duration_hours: 1, rating: 5 },
  ], 'admin');
  assert('返回400', ghost.status === 400);
  assert('行1报 VOLUNTEER_NOT_FOUND',
    (ghost.body.data as any).errors[0].code === 'VOLUNTEER_NOT_FOUND' &&
    (ghost.body.data as any).errors[0].line === 1);

  // ---------------- 场景7：原有单条录入规则不变 ----------------
  console.log('\n--- 场景7: 单条录入规则不变 ---');
  mkVolunteer('55555555-5555-5555-5555-555555555555');
  const single = await createServiceRecord({
    volunteer_id: '55555555-5555-5555-5555-555555555555',
    service_type: 'community_service', duration_hours: 2, rating: 5,
  });
  assert('单条录入成功', single.success === true && single.data!.newTotalPoints > 0, undefined, single.error);
  assert('单条无批次号(batch_id为空)', serviceRecords[serviceRecords.length - 1].batch_id === null);

  mkVolunteer('66666666-6666-6666-6666-666666666666', { credit_score: 20 });
  const limited = await createServiceRecord({
    volunteer_id: '66666666-6666-6666-6666-666666666666',
    service_type: 'community_service', duration_hours: 2, rating: 5,
  });
  assert('低信用单条仍被拒绝', limited.success === false && limited.error === '信用分过低，无法接单');

  // ---------------- 汇总 ----------------
  console.log('\n========================================');
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  console.log(`总计: ${testResults.length}  通过: ${passed}  失败: ${failed}`);
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
};

run().catch(err => {
  console.error('测试执行出错:', err);
  process.exit(1);
});
