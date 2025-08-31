# 🧠 智能账号分组调度系统使用指南

## 📖 概述

这是一个全新的智能账号管理和分组调度系统，解决了以下核心问题：

- ✅ **自动故障检测**: 定期发送"你好"测试所有账号状态
- ✅ **智能故障转移**: 账号出问题时自动切换到分组内其他健康账号
- ✅ **会话粘性管理**: 故障时重新分配会话，恢复后智能回切
- ✅ **后备账号机制**: 分组内所有账号都有问题时使用默认账号
- ✅ **自动恢复系统**: 定期检测账号恢复状态，自动恢复调度

## 🏗️ 系统架构

### 核心组件

1. **AccountHealthService** - 账号健康检查服务
2. **SmartGroupScheduler** - 智能分组调度器  
3. **AccountRecoveryManager** - 账号自动恢复管理器
4. **UnifiedClaudeScheduler** - 统一调度器（已增强）

### 数据流程

```
API请求 → API Key验证 → 分组调度 → 健康检查 → 账号选择 → 会话管理 → 响应
                                     ↓
                          故障检测 → 故障转移 → 后备账号 → 自动恢复
```

## 🚀 快速开始

### 1. 启动系统

智能调度系统会在应用启动时自动启动，无需额外配置。

```bash
npm start
```

系统启动后会看到：
```
🏥 Starting account health monitoring services...
✅ Account health monitoring services started successfully
```

### 2. 创建账号分组

通过管理后台创建分组：

```bash
curl -X POST http://localhost:3000/admin/account-groups \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude Pro Group",
    "platform": "claude",
    "description": "Claude Pro 账户分组"
  }'
```

### 3. 添加账号到分组

创建账号时指定分组：

```bash
curl -X POST http://localhost:3000/admin/claude-accounts \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude Account 1",
    "accountType": "group",
    "groupId": "your-group-id",
    "claudeAiOauth": "..."
  }'
```

### 4. 创建使用分组的API Key

```bash
curl -X POST http://localhost:3000/admin/api-keys \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test API Key",
    "claudeAccountId": "group:your-group-id",
    "tokenLimit": 1000000
  }'
```

### 5. 设置后备账号

为平台设置后备账号：

```bash
curl -X POST http://localhost:3000/admin/fallback/claude \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "your-fallback-account-id"
  }'
```

## 🔧 API 接口

### 健康检查接口

- `GET /admin/health/stats` - 获取健康统计
- `GET /admin/health/:accountId` - 获取特定账号健康状态
- `POST /admin/health/:accountId/check` - 手动检查账号健康
- `POST /admin/health/check-all` - 触发全系统健康检查

### 恢复管理接口

- `GET /admin/recovery/status` - 获取恢复管理器状态
- `POST /admin/recovery/start` - 启动恢复管理器
- `POST /admin/recovery/stop` - 停止恢复管理器
- `POST /admin/recovery/:accountId/manual` - 手动恢复账号

### 分组管理接口

- `GET /admin/groups/:groupId/stats` - 获取分组调度统计
- `POST /admin/fallback/:platform` - 设置后备账号
- `POST /admin/sessions/:sessionHash/migrate` - 手动迁移会话

### 系统监控接口

- `GET /admin/system/health` - 获取系统整体健康状态
- `GET /admin/health/:accountId/history` - 获取账号健康历史
- `DELETE /admin/sessions/account/:accountId` - 清除账号会话映射

## 🧪 测试和调试

### 运行测试套件

```bash
# 完整测试
node scripts/test-smart-scheduling.js test

# 仅健康检查测试
node scripts/test-smart-scheduling.js health

# 查看系统概览
node scripts/test-smart-scheduling.js overview
```

### 手动测试故障转移

1. 创建测试分组和账号
2. 模拟账号故障（通过API标记为隔离）
3. 发送请求观察自动切换
4. 恢复账号观察回切行为

### 监控日志

关键日志标识：
- `🏥` - 健康检查相关
- `🔄` - 恢复和迁移相关
- `🎯` - 调度选择相关
- `⚠️` - 警告和故障相关
- `🚫` - 隔离和阻止相关

## ⚙️ 配置说明

### 健康检查配置

```javascript
// 在 accountHealthService.js 中
const CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟检查一次
const FAILURE_THRESHOLD = 3 // 连续失败3次标记为不健康
const RECOVERY_THRESHOLD = 2 // 连续成功2次标记为恢复
const QUARANTINE_DURATION = 30 * 60 * 1000 // 30分钟隔离时间
```

### 恢复管理配置

```javascript
// 在 accountRecoveryManager.js 中
const RECOVERY_CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟检查恢复
const MAX_RECOVERY_ATTEMPTS = 5 // 最大恢复尝试次数
const RECOVERY_BACKOFF_BASE = 2 // 指数退避基数（分钟）
```

### 会话管理配置

```javascript
// 在 smartGroupScheduler.js 中
const RETRY_THRESHOLD = 3 // 失败3次后切换账户
const FALLBACK_COOLDOWN = 10 * 60 * 1000 // 10分钟后尝试回切
```

## 🎯 使用场景

### 场景1：正常分组调度

```
用户请求 → API Key绑定分组 → 选择分组内最优账号 → 建立会话粘性 → 正常响应
```

### 场景2：账号故障转移

```
用户请求 → 发现绑定账号不健康 → 选择分组内其他健康账号 → 重新建立会话粘性
```

### 场景3：分组全部故障

```
用户请求 → 分组内无健康账号 → 使用平台后备账号 → 临时会话映射 → 持续监控分组恢复
```

### 场景4：自动恢复

```
后台定期检查 → 发现账号恢复健康 → 清理隔离状态 → 恢复调度 → 迁移临时会话回原分组
```

## 📊 监控和告警

### 关键指标监控

- **账号健康率**: 健康账号数/总账号数
- **故障转移次数**: 每小时故障转移统计
- **恢复成功率**: 自动恢复成功的账号比例
- **后备账号使用率**: 使用后备账号的请求比例

### 告警配置建议

- 账号健康率低于80%时告警
- 大量故障转移时告警（可能系统性问题）
- 后备账号使用率持续高于30%时告警
- 恢复管理器停止运行时告警

## 🔍 故障排除

### 常见问题

1. **账号一直显示不健康**
   - 检查账号OAuth token是否有效
   - 检查代理配置是否正确
   - 手动触发健康检查：`POST /admin/health/:accountId/check`

2. **故障转移不工作**
   - 确认分组内有多个账号
   - 检查分组配置和账号归属
   - 查看调度日志确认选择逻辑

3. **会话不回切**
   - 检查恢复管理器是否运行：`GET /admin/recovery/status`
   - 手动触发恢复检查：`POST /admin/recovery/check`
   - 查看账号是否真正恢复健康

4. **后备账号不生效**
   - 确认已设置平台后备账号：`POST /admin/fallback/:platform`
   - 检查后备账号是否健康和可用
   - 查看调度日志确认后备逻辑

### 调试步骤

1. 查看系统整体状态：`GET /admin/system/health`
2. 检查特定账号状态：`GET /admin/health/:accountId`
3. 查看分组调度统计：`GET /admin/groups/:groupId/stats`
4. 检查会话映射状态和清理异常映射
5. 手动触发恢复和迁移进行测试

## 🚀 性能优化建议

### 生产环境配置

1. **调整检查频率**: 根据账号数量和稳定性调整健康检查间隔
2. **配置后备账号**: 为每个平台配置稳定的后备账号
3. **监控资源使用**: 关注Redis内存使用和键值数量
4. **日志级别调整**: 生产环境可调整为info级别减少日志量

### 扩展性考虑

- 支持多平台（Claude、Gemini、OpenAI）
- 支持自定义健康检查逻辑
- 支持webhook通知故障和恢复事件
- 支持更复杂的调度策略（地理位置、负载均衡等）

## 📚 更多资源

- 查看 `scripts/test-smart-scheduling.js` 了解完整测试示例
- 查看 `src/services/` 目录下的服务源码
- 查看 `src/routes/accountHealth.js` 了解完整API文档
- 在CLAUDE.md中查看项目整体架构说明

---

🎉 **恭喜！** 你现在拥有了一个完全自动化的智能账号管理系统，再也不用担心账号故障影响用户体验了！