/* 批次导入业务逻辑集成测试：注入 PGlite 内存库，运行真实的 service 代码 */
require('ts-node/register/transpile-only');

const path = require('path');
const Module = require('module');
const { createPGlitePool } = require('./pglitePool');

const assert = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) {
    console.log('  ', typeof extra === 'object' ? JSON.stringify(extra, null, 2) : extra);
    process.exitCode = 1;
  }
};

// 注入 pglite 作为 db/pool（须在业务模块加载前）
let poolHandle;
const poolModulePath = require.resolve('../db/pool');
require.cache[poolModulePath] = {
  id: poolModulePath,
  filename: poolModulePath,
  loaded: true,
  exports: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === '__esModule') return true;
        if (prop === 'default') return poolHandle;
        return poolHandle[prop];
      },
    }
  ),
};

const run = async () => {
  const { pool, client } = await createPGlitePool();
  poolHandle = pool;

  // 建表（精简自 migrate.ts，pglite 无 pgcrypto，用 gen_random_uuid）
  await client._pg.exec(`
    CREATE TABLE volunteers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL, phone VARCHAR(20), email VARCHAR(100),
      total_points INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
      credit_score INTEGER NOT NULL DEFAULT 100, service_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE service_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
      service_type VARCHAR(50) NOT NULL, duration_hours DECIMAL(6,2) NOT NULL,
      rating INTEGER NOT NULL DEFAULT 5 CHECK (rating >=1 AND rating <=5),
      points_earned INTEGER NOT NULL DEFAULT 0, is_no_show BOOLEAN NOT NULL DEFAULT false,
      location VARCHAR(200), description TEXT, batch_no VARCHAR(64),
      recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX uq_service_records_dedup ON service_records
      (volunteer_id, date_trunc('second', recorded_at), service_type, duration_hours, COALESCE(location,''));
    CREATE INDEX idx_sr_vol ON service_records(volunteer_id);
    CREATE TABLE batch_imports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_no VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','rejected')),
      total_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0, request_payload_hash VARCHAR(128),
      result_summary JSONB, error_summary JSONB, created_by VARCHAR(100) NOT NULL DEFAULT 'anonymous',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP
    );
    CREATE TABLE batch_import_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES batch_imports(id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL, service_record_id UUID REFERENCES service_records(id) ON DELETE SET NULL,
      volunteer_id UUID NOT NULL, service_type VARCHAR(50) NOT NULL, duration_hours DECIMAL(6,2) NOT NULL,
      rating INTEGER NOT NULL, is_no_show BOOLEAN NOT NULL DEFAULT false, location VARCHAR(200),
      description TEXT, recorded_at TIMESTAMP NOT NULL, points_earned INTEGER,
      status VARCHAR(20) NOT NULL CHECK (status IN ('accepted','rejected')), error_codes JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(batch_id, line_number)
    );
    CREATE TABLE points_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
      change_amount INTEGER NOT NULL, reason VARCHAR(200) NOT NULL, before_points INTEGER NOT NULL,
      after_points INTEGER NOT NULL, related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE badges (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
      star_level INTEGER NOT NULL CHECK (star_level>=1 AND star_level<=5), badge_name VARCHAR(100) NOT NULL,
      description TEXT, awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(volunteer_id, star_level));
    CREATE TABLE credit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
      change_amount INTEGER NOT NULL, reason VARCHAR(200) NOT NULL, before_score INTEGER NOT NULL,
      after_score INTEGER NOT NULL, related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE complaints (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
      complainant_id UUID, complaint_type VARCHAR(50) NOT NULL, description TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending', resolution TEXT, credit_penalty INTEGER DEFAULT 0,
      points_penalty INTEGER DEFAULT 0, handled_by VARCHAR(100), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TIMESTAMP);
  `);

  const {
    submitBatchImport,
    getBatchImportResult,
    listBatchImportItems,
  } = require('../services/batchImportService');

  // 两个启用志愿者 + 一个停用志愿者
  const active1 = (await pool.query(`INSERT INTO volunteers(name) VALUES ('张三') RETURNING id`)).rows[0].id;
  const active2 = (await pool.query(`INSERT INTO volunteers(name) VALUES ('王五') RETURNING id`)).rows[0].id;
  const inactive = (await pool.query(`INSERT INTO volunteers(name,is_active) VALUES ('李四',false) RETURNING id`)).rows[0].id;
  const missingId = '00000000-0000-0000-0000-000000000000';

  const past = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const future = (mins) => new Date(Date.now() + mins * 60000).toISOString();

  // 场景 1：全部合格 -> 入账
  const good = await submitBatchImport({
    batch_no: 'BATCH-GOOD-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: '社区A', recorded_at: past(120) },
      { volunteer_id: active2, service_type: 'education', duration_hours: 1, rating: 4, is_no_show: false, location: '社区B', recorded_at: past(60) },
    ],
  });
  assert('合格批次 success=true 201', good.success && good.statusCode === 201, good);
  assert('合格批次 status=completed', good.data.status === 'completed');
  assert('合格批次 success_count=2', good.data.success_count === 2);
  assert('合格批次明细全部 accepted', good.data.items.every(i => i.status === 'accepted'));
  assert('合格批次明细有 service_record_id', good.data.items.every(i => !!i.service_record_id));
  assert('合格批次返回志愿者维度结果(2人)', Array.isArray(good.data.volunteers) && good.data.volunteers.length === 2, good.data.volunteers);

  const v1After = (await pool.query(`SELECT * FROM volunteers WHERE id=$1`, [active1])).rows[0];
  // elderly_care 权重1.5，2h*10*1.5=30，rating5 bonus (5-3)*0.1=0.2 -> 36
  assert('积分已写入志愿者(张三=36)', v1After.total_points === 36, v1After.total_points);
  assert('service_count 已增加(张三=1)', v1After.service_count === 1);

  const srCount = (await pool.query(`SELECT COUNT(*)::int c FROM service_records WHERE batch_no=$1`, ['BATCH-GOOD-1'])).rows[0].c;
  assert('service_records 带 batch_no 共2条', srCount === 2);

  const pointsLogs = (await pool.query(`SELECT COUNT(*)::int c FROM points_logs WHERE volunteer_id=$1`, [active1])).rows[0].c;
  assert('积分流水已写(1条)', pointsLogs === 1);

  // 信用分在提交后重算（1次服务、评分5）：100 + min(1*0.5,10) + (5-3)*15 = 130.5 -> 131（封顶120）
  const v1Credit = (await pool.query(`SELECT credit_score FROM volunteers WHERE id=$1`, [active1])).rows[0].credit_score;
  assert('提交后信用分已重算(封顶120)', v1Credit === 120, v1Credit);
  const creditLogs1 = (await pool.query(`SELECT COUNT(*)::int c FROM credit_logs WHERE volunteer_id=$1 AND related_type='batch_import'`, [active1])).rows[0].c;
  assert('信用流水已记录(batch_import)', creditLogs1 === 1, creditLogs1);
  const goodOutcome1 = good.data.volunteers.find(o => o.volunteer_id === active1);
  assert('批次结果回传信用分', goodOutcome1.credit_score === 120 && goodOutcome1.credit_change === 20, goodOutcome1);

  // 场景 2：幂等重放（同 batch_no 同内容）
  const replay = await submitBatchImport({
    batch_no: 'BATCH-GOOD-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: '社区A', recorded_at: past(120) },
      { volunteer_id: active2, service_type: 'education', duration_hours: 1, rating: 4, is_no_show: false, location: '社区B', recorded_at: past(60) },
    ],
  });
  assert('幂等重放 success=true', replay.success === true, replay);
  assert('幂等重放 idempotent=true', replay.data.idempotent === true);
  const srCountAfterReplay = (await pool.query(`SELECT COUNT(*)::int c FROM service_records WHERE batch_no=$1`, ['BATCH-GOOD-1'])).rows[0].c;
  assert('幂等重放不重复入账(仍2条)', srCountAfterReplay === 2);
  const v1AfterReplay = (await pool.query(`SELECT total_points FROM volunteers WHERE id=$1`, [active1])).rows[0].total_points;
  assert('幂等重放积分不变(仍36)', v1AfterReplay === 36);

  // 场景 3：同 batch_no 不同内容 -> 409
  const conflict = await submitBatchImport({
    batch_no: 'BATCH-GOOD-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'other', duration_hours: 9, rating: 3, is_no_show: false, location: 'X', recorded_at: past(10) },
    ],
  });
  assert('同批次号不同内容 409', conflict.success === false && conflict.statusCode === 409, conflict);

  // 场景 4：审查不通过，返回全部行号，且不写任何业务数据
  const pointsBefore = (await pool.query(`SELECT SUM(total_points)::int s FROM volunteers`)).rows[0].s;
  const bad = await submitBatchImport({
    batch_no: 'BATCH-BAD-1',
    operator_id: 'admin',
    records: [
      { line: 1, volunteer_id: missingId, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { line: 2, volunteer_id: inactive, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { line: 3, volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: future(30) },
      // 行4：与行5批内重复
      { line: 4, volunteer_id: active2, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { line: 5, volunteer_id: active2, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { line: 6, volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: '社区A', recorded_at: past(120) },
    ],
  });
  assert('问题批次 success=false 400', bad.success === false && bad.statusCode === 400, bad.statusCode);
  assert('问题批次 status=rejected', bad.data.status === 'rejected');
  assert('返回全部问题行号 [1,2,3,5,6]', JSON.stringify(bad.data.error_lines) === JSON.stringify([1, 2, 3, 5, 6]), bad.data.error_lines);
  const row1 = bad.data.error_rows.find(r => r.line_number === 1);
  assert('行1 错误码 VOLUNTEER_NOT_FOUND', row1.error_codes.includes('VOLUNTEER_NOT_FOUND'), row1);
  const row2 = bad.data.error_rows.find(r => r.line_number === 2);
  assert('行2 错误码 VOLUNTEER_INACTIVE', row2.error_codes.includes('VOLUNTEER_INACTIVE'), row2);
  const row3 = bad.data.error_rows.find(r => r.line_number === 3);
  assert('行3 错误码 FUTURE_RECORDED_AT', row3.error_codes.includes('FUTURE_RECORDED_AT'), row3);
  const row5 = bad.data.error_rows.find(r => r.line_number === 5);
  assert('行5 错误码 DUPLICATE_RECORD 且指向行4', row5.error_codes.includes('DUPLICATE_RECORD') && row5.duplicate_of_line === 4, row5);
  const row6 = bad.data.error_rows.find(r => r.line_number === 6);
  assert('行6 与库内已入账记录重复', row6.error_codes.includes('DUPLICATE_RECORD'), row6);

  const pointsAfter = (await pool.query(`SELECT SUM(total_points)::int s FROM volunteers`)).rows[0].s;
  assert('问题批次积分完全不写(总和不变)', pointsBefore === pointsAfter, { pointsBefore, pointsAfter });
  const newRecordsBad = (await pool.query(`SELECT COUNT(*)::int c FROM service_records WHERE batch_no=$1`, ['BATCH-BAD-1'])).rows[0].c;
  assert('问题批次不写 service_records(0条)', newRecordsBad === 0);
  const newBadges = (await pool.query(`SELECT COUNT(*)::int c FROM badges`)).rows[0].c;
  assert('问题批次不写徽章', newBadges === 0);
  // 问题批次明细全部 rejected
  assert('问题批次明细全部 rejected', bad.data.items.every(i => i.status === 'rejected'));

  // 场景 5：被拒绝批次同内容重放 -> 同样 rejected 且不补写
  const replayRej = await submitBatchImport({
    batch_no: 'BATCH-BAD-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: missingId, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { volunteer_id: inactive, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: future(30) },
      { volunteer_id: active2, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { volunteer_id: active2, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: 'L', recorded_at: past(30) },
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: '社区A', recorded_at: past(120) },
    ],
  });
  assert('拒绝批次重放仍 rejected(400)', replayRej.success === false && replayRej.statusCode === 400);
  assert('拒绝批次重放行号一致', JSON.stringify(replayRej.data.error_lines) === JSON.stringify([1, 2, 3, 5, 6]));

  // 场景 6：回读批次结果
  const read = await getBatchImportResult('BATCH-GOOD-1');
  assert('回读成功', read.success && read.data.batch_no === 'BATCH-GOOD-1');
  assert('回读含明细2条', read.data.items.length === 2);
  const readMissing = await getBatchImportResult('NOT-EXIST');
  assert('回读不存在批次 404', readMissing.success === false && readMissing.statusCode === 404);

  // 场景 7：分明细分页回读
  const items = await listBatchImportItems('BATCH-BAD-1', 1, 3);
  assert('明细分页 page1 返回3条', items.data.items.length === 3 && items.data.pagination.total_pages === 2, items.data.pagination);
  assert('明细分页按 line_number 排序', items.data.items[0].line_number === 1 && items.data.items[2].line_number === 3);

  // 场景 8：跨批次重复（库内已存在同键）
  const crossDup = await submitBatchImport({
    batch_no: 'BATCH-CROSS-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: false, location: '社区A', recorded_at: past(120) },
    ],
  });
  assert('跨批次库内重复被整批拒绝', crossDup.success === false && crossDup.data.error_lines.includes(1), crossDup.data);

  // 场景 9：等级与徽章升级（足够积分到 level2）
  const lvlBatch = await submitBatchImport({
    batch_no: 'BATCH-LEVEL-1',
    operator_id: 'admin',
    records: [
      // disaster_relief 权重2.0：5h*10*2=100, rating5 *1.2=120
      { volunteer_id: active2, service_type: 'disaster_relief', duration_hours: 5, rating: 5, is_no_show: false, location: '灾区', recorded_at: past(200) },
    ],
  });
  assert('升级批次成功', lvlBatch.success === true, lvlBatch);
  const v2 = (await pool.query(`SELECT * FROM volunteers WHERE id=$1`, [active2])).rows[0];
  // education 1h rating4: 1*10*1.3=13, bonus (4-3)*.1=.1 -> 14；+120 = 134 -> level2
  assert('王五积分=134', v2.total_points === 134, v2.total_points);
  assert('王五等级=2', v2.level === 2, v2.level);
  const badge = (await pool.query(`SELECT * FROM badges WHERE volunteer_id=$1`, [active2])).rows;
  assert('王五获得二星徽章', badge.length === 1 && badge[0].star_level === 2, badge);
  const lvlOutcome = lvlBatch.data.volunteers.find(o => o.volunteer_id === active2);
  assert('批次结果含 level_up 与新徽章', lvlOutcome.level_up === true && lvlOutcome.new_badges.length === 1, lvlOutcome);

  // 场景 10：爽约记录扣分但不计服务次数
  const noShow = await submitBatchImport({
    batch_no: 'BATCH-NOSHOW-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'elderly_care', duration_hours: 2, rating: 5, is_no_show: true, location: '爽约点', recorded_at: past(300) },
    ],
  });
  assert('爽约批次成功', noShow.success === true, noShow);
  const v1ns = (await pool.query(`SELECT * FROM volunteers WHERE id=$1`, [active1])).rows[0];
  assert('爽约扣20分(36-20=16)', v1ns.total_points === 16, v1ns.total_points);
  assert('爽约不计服务次数(仍1)', v1ns.service_count === 1, v1ns.service_count);

  // 场景 11：location 空白归一化（'  ' 与 undefined 视为同地点）
  const blankDup = await submitBatchImport({
    batch_no: 'BATCH-BLANK-1',
    operator_id: 'admin',
    records: [
      { volunteer_id: active1, service_type: 'other', duration_hours: 1, rating: 3, is_no_show: false, location: '   ', recorded_at: past(420) },
      { volunteer_id: active1, service_type: 'other', duration_hours: 1, rating: 3, is_no_show: false, recorded_at: past(420) },
    ],
  });
  assert('空白/缺省地点归一判定批内重复', blankDup.success === false && JSON.stringify(blankDup.data.error_lines) === '[2]', blankDup.data && blankDup.data.error_lines);

  // 场景 12：同批次号并发提交（Promise 并发），只能生成一套结果
  const concurrentRecords = [
    { volunteer_id: active1, service_type: 'environmental', duration_hours: 1, rating: 5, is_no_show: false, location: '并发点', recorded_at: past(500) },
  ];
  const [rA, rB] = await Promise.all([
    submitBatchImport({ batch_no: 'BATCH-CONC-1', operator_id: 'admin', records: concurrentRecords }),
    submitBatchImport({ batch_no: 'BATCH-CONC-1', operator_id: 'admin', records: concurrentRecords }),
  ]);
  const concSuccessCount = [rA, rB].filter(r => r.success).length;
  assert('并发同批次号至少一个成功', concSuccessCount >= 1, { a: rA.statusCode, b: rB.statusCode });
  const concRecords = (await pool.query(`SELECT COUNT(*)::int c FROM service_records WHERE batch_no='BATCH-CONC-1'`)).rows[0].c;
  assert('并发同批次号只入账一套(1条)', concRecords === 1, concRecords);
  const concBatchRows = (await pool.query(`SELECT COUNT(*)::int c FROM batch_imports WHERE batch_no='BATCH-CONC-1'`)).rows[0].c;
  assert('并发同批次号只生成一个批次行', concBatchRows === 1, concBatchRows);

  console.log('\n批次导入集成测试完成');
};

run().catch(e => {
  console.error(e);
  process.exit(1);
});
