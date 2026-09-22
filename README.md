# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- 服务记录批次整批导入（批次号幂等、整批审查、统一入账、结果/明细回读）
- 积分、徽章和信用分计算
- 投诉处理、后台调整和排行榜

## 批次导入接口（整批审查后再落账）

所有接口需要认证头：`Authorization: Bearer <ADMIN_TOKEN 或 volunteer_<志愿者ID>>`。

### 提交批次

`POST /api/v1/service-records/batch`

```json
{
  "batch_no": "20260922-001",
  "records": [
    {
      "volunteer_id": "uuid",
      "service_type": "elderly_care",
      "duration_hours": 2,
      "rating": 5,
      "location": "敬老院",
      "recorded_at": "2026-09-22T09:00:00Z"
    }
  ]
}
```

审查规则（任一不满足，整批拒绝，记录/积分/等级/徽章/信用均不写入，返回全部问题行号）：

- 志愿者必须存在且 `is_active = true`
- `recorded_at` 不能晚于当前时间（缺省取当前时间）
- 批次号不可重复；重复提交幂等返回首次的同一套结果（`replayed: true`）
- 同一志愿者在相同记录时间、类型、时长、地点下，批内或与已入账记录重复均拒绝

审查通过后在一个数据库事务内统一入账：写入全部记录、按志愿者结算积分/等级/徽章并重算信用分。
并发提交相同 `batch_no` 通过事务级咨询锁串行化，只生成一套结果。成功返回 `200`；整批校验失败返回 `400`，
`data.errors` 中包含每条问题的 `line`（从 1 开始）、`code`、`message`。

### 回读

- `GET /api/v1/service-records/batch/:batchNo` — 批次结果（状态、计数、错误、快照）
- `GET /api/v1/service-records/batch/:batchNo/details?page=1&page_size=20` — 批次入账明细（按行号排序）

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
