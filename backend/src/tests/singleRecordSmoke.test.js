/* 冒烟：原有单条录入在新 schema 下仍正常（pglite 注入） */
require('ts-node/register/transpile-only');

const { createPGlitePool } = require('./pglitePool');
const assert = (n, c, e) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) { console.log(e); process.exitCode = 1; } };

const poolModulePath = require.resolve('../db/pool');
let poolHandle;
require.cache[poolModulePath] = {
  id: poolModulePath, filename: poolModulePath, loaded: true,
  exports: new Proxy({}, { get: (_t, p) => (p === '__esModule' ? true : p === 'default' ? poolHandle : poolHandle[p]) }),
};

const run = async () => {
  const { pool, client } = await createPGlitePool();
  poolHandle = pool;

  await client._pg.exec(`
    CREATE TABLE volunteers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(100) NOT NULL,
      phone VARCHAR(20), email VARCHAR(100), total_points INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
      credit_score INTEGER NOT NULL DEFAULT 100, service_count INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE service_records (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
      service_type VARCHAR(50) NOT NULL, duration_hours DECIMAL(6,2) NOT NULL, rating INTEGER NOT NULL DEFAULT 5,
      points_earned INTEGER NOT NULL DEFAULT 0, is_no_show BOOLEAN NOT NULL DEFAULT false, location VARCHAR(200), description TEXT,
      batch_no VARCHAR(64), recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX uq_sr_dedup ON service_records
      (volunteer_id, date_trunc('second', recorded_at), service_type, duration_hours, COALESCE(location,''));
    CREATE INDEX idx_sr_vol ON service_records(volunteer_id);
    CREATE TABLE points_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, change_amount INTEGER NOT NULL,
      reason VARCHAR(200) NOT NULL, before_points INTEGER NOT NULL, after_points INTEGER NOT NULL, related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE badges (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, star_level INTEGER NOT NULL,
      badge_name VARCHAR(100) NOT NULL, description TEXT, awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(volunteer_id, star_level));
    CREATE TABLE credit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, change_amount INTEGER NOT NULL,
      reason VARCHAR(200) NOT NULL, before_score INTEGER NOT NULL, after_score INTEGER NOT NULL, related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE complaints (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, complainant_id UUID,
      complaint_type VARCHAR(50) NOT NULL, description TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', resolution TEXT,
      credit_penalty INTEGER DEFAULT 0, points_penalty INTEGER DEFAULT 0, handled_by VARCHAR(100), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TIMESTAMP);
  `);

  const { createVolunteer } = require('../services/volunteerManager');
  const { createServiceRecord, getServiceRecordById, getVolunteerServiceRecords } = require('../services/volunteerService');

  const v = await createVolunteer('赵六', '13800138009', 'zhao@example.com');
  const vid = v.data.id;
  assert('单条：创建志愿者', v.success === true);

  const r = await createServiceRecord({
    volunteer_id: vid, service_type: 'medical_assist', duration_hours: 2, rating: 5,
    is_no_show: false, location: '医院', description: '辅助',
  });
  assert('单条：录入成功', r.success === true, r);
  // medical_assist 1.6: 2*10*1.6=32 *1.2=38.4->38
  assert('单条：积分=38', r.data.newTotalPoints === 38, r.data.newTotalPoints);
  assert('单条：记录可按 id 回读', (await getServiceRecordById(r.data.record.id)).success === true);
  const list = await getVolunteerServiceRecords(vid, 1, 20);
  assert('单条：志愿者记录列表1条', list.data.records.length === 1);

  // 同一志愿者相同时间/类型/时长/地点重复 -> 拒绝（非500）
  const dup = await createServiceRecord({
    volunteer_id: vid, service_type: 'medical_assist', duration_hours: 2, rating: 5,
    is_no_show: false, location: '医院', description: '辅助',
    recorded_at: r.data.record.recorded_at,
  });
  assert('单条：重复记录被拒绝', dup.success === false, dup);

  console.log('\n单条录入冒烟完成');
};
run().catch(e => { console.error(e); process.exit(1); });
