# Claude Relay Service 故障转移技术设计方案

## 1. 概述

### 1.1 目标
- **用户无感知**：在账户或API接口故障时，自动切换到可用账户，确保用户请求正常完成
- **减少投诉**：通过智能故障转移，降低因接口不可用导致的用户投诉和咨询
- **高可用性**：通过多账户轮询机制，最大化服务可用性

### 1.2 核心原则
- 任何非2xx响应都应触发故障转移
- 按优先级顺序尝试所有可用账户
- 尽可能完成用户请求，除非所有账户都不可用

## 2. 架构设计

### 2.1 整体架构
```
用户请求
    ↓
API路由层 (/v1/messages)
    ↓
统一故障转移层 (新增)
    ├── ClaudeRelayService.relayRequestWithFailover
    └── ClaudeConsoleRelayService.relayRequestWithFailover
              ↓
        账户调度器
    (unifiedClaudeScheduler)
              ↓
        账户服务层
    ├── claudeAccountService
    └── claudeConsoleAccountService
```

### 2.2 故障转移流程
```
开始请求
    ↓
选择初始账户（按优先级）
    ↓
发送请求
    ↓
响应判定
    ├── 成功(2xx) → 返回结果
    └── 失败 → 标记账户失败
                    ↓
              是否还有可用账户？
                ├── 是 → 选择下一个账户 → 重试
                └── 否 → 返回最后的错误
```

## 3. 详细设计

### 3.1 故障判定标准

#### 需要触发故障转移的情况：
```javascript
const shouldFailover = (error, response) => {
  // 1. 网络错误
  if (error) {
    if (error.code === 'ECONNREFUSED') return true
    if (error.code === 'ETIMEDOUT') return true
    if (error.code === 'ENOTFOUND') return true
    if (error.code === 'ECONNRESET') return true
    if (error.message?.includes('socket hang up')) return true
  }
  
  // 2. HTTP错误响应
  if (response) {
    // 4xx 客户端错误（除了特定的不应重试的）
    if (response.statusCode === 429) return true  // 速率限制
    if (response.statusCode === 401) return true  // 认证失败
    if (response.statusCode === 403) return true  // 权限问题
    if (response.statusCode >= 500) return true  // 所有服务器错误
  }
  
  return false
}

// 不应该重试的错误（直接返回给用户）
const isNonRetryableError = (error, response) => {
  if (response?.statusCode === 400) return true  // 请求格式错误
  if (response?.statusCode === 422) return true  // 请求内容问题
  return false
}
```

### 3.2 账户选择策略

#### 3.2.1 账户池构建
```javascript
async function buildAccountPool(apiKeyData, sessionHash, model) {
  const accountPool = []
  
  // 1. 获取分组内账户（如果有分组）
  if (apiKeyData.groupId) {
    const groupAccounts = await getGroupAccounts(apiKeyData.groupId)
    // 按优先级排序
    groupAccounts.sort((a, b) => (b.priority || 0) - (a.priority || 0))
    accountPool.push(...groupAccounts)
  }
  
  // 2. 添加默认账户（如果存在且不在分组内）
  const defaultAccount = await getDefaultAccount()
  if (defaultAccount && !accountPool.find(a => a.id === defaultAccount.id)) {
    accountPool.push(defaultAccount)
  }
  
  // 3. 过滤支持当前模型的账户
  return accountPool.filter(account => 
    isModelSupported(account, model)
  )
}
```

#### 3.2.2 账户健康度管理
```javascript
class AccountHealthManager {
  constructor() {
    // 临时故障账户记录（内存中）
    this.failedAccounts = new Map()
    // 故障恢复时间（5分钟）
    this.RECOVERY_TIME = 5 * 60 * 1000
  }
  
  markFailed(accountId, error) {
    this.failedAccounts.set(accountId, {
      timestamp: Date.now(),
      error: error.message,
      retryAfter: Date.now() + this.RECOVERY_TIME
    })
  }
  
  isHealthy(accountId) {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return true
    
    // 检查是否已过恢复时间
    if (Date.now() > failure.retryAfter) {
      this.failedAccounts.delete(accountId)
      return true
    }
    
    return false
  }
  
  getHealthScore(accountId) {
    // 返回健康分数 0-100
    if (!this.isHealthy(accountId)) return 0
    // 未来可以基于成功率计算
    return 100
  }
}
```

### 3.3 非流式请求故障转移实现

#### 3.3.1 ClaudeRelayService 增强
```javascript
async relayRequestWithFailover(requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, options = {}) {
  const sessionHash = sessionHelper.generateSessionHash(requestBody)
  const accountPool = await buildAccountPool(apiKeyData, sessionHash, requestBody.model)
  const attemptedAccounts = []
  let lastError = null
  
  logger.info(`🔄 Starting failover with ${accountPool.length} available accounts`)
  
  for (const account of accountPool) {
    // 跳过不健康的账户
    if (!accountHealthManager.isHealthy(account.id)) {
      logger.debug(`⏭️ Skipping unhealthy account: ${account.id}`)
      continue
    }
    
    try {
      attemptedAccounts.push(account.id)
      logger.info(`🎯 Attempting with account: ${account.name} (${account.id})`)
      
      // 根据账户类型调用相应的relay方法
      let response
      if (account.type === 'claude-official') {
        response = await this._relayToOfficialAPI(requestBody, account, clientHeaders, options)
      } else {
        throw new Error(`Unsupported account type: ${account.type}`)
      }
      
      // 检查响应是否成功
      if (response.statusCode >= 200 && response.statusCode < 300) {
        logger.info(`✅ Success with account: ${account.id}`)
        return response
      }
      
      // 响应不成功，记录并尝试下一个账户
      logger.warn(`⚠️ Account ${account.id} returned ${response.statusCode}`)
      lastError = new Error(`HTTP ${response.statusCode}`)
      
      // 如果是不可重试的错误，直接返回
      if (isNonRetryableError(null, response)) {
        logger.info(`🛑 Non-retryable error, returning response`)
        return response
      }
      
      // 标记账户失败
      accountHealthManager.markFailed(account.id, lastError)
      
    } catch (error) {
      logger.error(`❌ Account ${account.id} failed:`, error.message)
      lastError = error
      accountHealthManager.markFailed(account.id, error)
    }
  }
  
  // 所有账户都失败了
  logger.error(`❌ All ${attemptedAccounts.length} accounts failed`)
  throw lastError || new Error('All accounts failed')
}
```

#### 3.3.2 ClaudeConsoleRelayService 新增故障转移
```javascript
class ClaudeConsoleRelayService {
  // 新增：带故障转移的请求方法
  async relayRequestWithFailover(requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, options = {}) {
    const sessionHash = sessionHelper.generateSessionHash(requestBody)
    const accountPool = await buildConsoleAccountPool(apiKeyData, sessionHash, requestBody.model)
    const attemptedAccounts = []
    let lastError = null
    
    for (const account of accountPool) {
      if (!accountHealthManager.isHealthy(account.id)) {
        continue
      }
      
      try {
        attemptedAccounts.push(account.id)
        
        // 调用现有的relayRequest方法
        const response = await this.relayRequest(
          requestBody,
          apiKeyData,
          clientRequest,
          clientResponse,
          clientHeaders,
          account.id,
          options
        )
        
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return response
        }
        
        lastError = new Error(`HTTP ${response.statusCode}`)
        
        if (isNonRetryableError(null, response)) {
          return response
        }
        
        accountHealthManager.markFailed(account.id, lastError)
        
      } catch (error) {
        lastError = error
        accountHealthManager.markFailed(account.id, error)
      }
    }
    
    throw lastError || new Error('All console accounts failed')
  }
}
```

### 3.4 流式请求故障转移实现

#### 3.4.1 连接阶段故障转移
```javascript
async relayStreamWithFailover(requestBody, apiKeyData, responseStream, clientHeaders, usageCallback) {
  const sessionHash = sessionHelper.generateSessionHash(requestBody)
  const accountPool = await buildAccountPool(apiKeyData, sessionHash, requestBody.model)
  const attemptedAccounts = []
  let lastError = null
  
  for (const account of accountPool) {
    if (!accountHealthManager.isHealthy(account.id)) {
      continue
    }
    
    try {
      attemptedAccounts.push(account.id)
      logger.info(`🎯 Stream attempt with account: ${account.id}`)
      
      // 创建流式连接
      const streamConnection = await this._createStreamConnection(
        requestBody,
        account,
        clientHeaders
      )
      
      // 设置早期故障检测
      const failoverController = new StreamFailoverController(responseStream)
      
      // 开始流式传输
      await this._handleStreamResponse(
        streamConnection,
        responseStream,
        failoverController,
        usageCallback
      )
      
      // 如果成功完成，返回
      return { success: true, accountId: account.id }
      
    } catch (error) {
      logger.error(`❌ Stream failed with account ${account.id}:`, error.message)
      lastError = error
      
      // 判断是否可以继续故障转移
      if (error.phase === 'connection') {
        // 连接阶段失败，可以完全切换
        accountHealthManager.markFailed(account.id, error)
        continue
      } else if (error.phase === 'early_stream' && !failoverController.hasExceededThreshold()) {
        // 早期流失败，且未超过阈值，可以切换
        accountHealthManager.markFailed(account.id, error)
        continue
      } else {
        // 流已经进行到一定程度，不能切换了
        throw error
      }
    }
  }
  
  throw lastError || new Error('All accounts failed for streaming')
}
```

#### 3.4.2 流式故障控制器
```javascript
class StreamFailoverController {
  constructor(responseStream) {
    this.responseStream = responseStream
    this.startTime = Date.now()
    this.bytesSent = 0
    this.eventsSent = 0
    this.canFailover = true
    this.buffer = []
    
    // 故障转移阈值配置
    this.EARLY_STREAM_TIME = 5000    // 5秒内可以故障转移
    this.EARLY_STREAM_BYTES = 1024   // 1KB内可以故障转移
    this.EARLY_STREAM_EVENTS = 3     // 3个事件内可以故障转移
  }
  
  onData(chunk) {
    this.bytesSent += chunk.length
    
    // 缓存早期数据（用于可能的重传）
    if (this.canFailover) {
      this.buffer.push(chunk)
      
      // 检查是否超过故障转移阈值
      if (this.hasExceededThreshold()) {
        this.canFailover = false
        this.buffer = [] // 释放内存
      }
    }
  }
  
  onEvent() {
    this.eventsSent++
  }
  
  hasExceededThreshold() {
    const timeElapsed = Date.now() - this.startTime
    
    return (
      timeElapsed > this.EARLY_STREAM_TIME ||
      this.bytesSent > this.EARLY_STREAM_BYTES ||
      this.eventsSent > this.EARLY_STREAM_EVENTS
    )
  }
  
  canDoFailover() {
    return this.canFailover && !this.hasExceededThreshold()
  }
  
  getBufferedData() {
    return Buffer.concat(this.buffer)
  }
}
```

#### 3.4.3 早期故障检测
```javascript
async _handleStreamResponse(streamConnection, responseStream, failoverController, usageCallback) {
  return new Promise((resolve, reject) => {
    let phase = 'connection'
    
    // 连接超时检测
    const connectionTimeout = setTimeout(() => {
      reject(Object.assign(new Error('Connection timeout'), { phase: 'connection' }))
    }, 10000)
    
    streamConnection.on('response', (response) => {
      clearTimeout(connectionTimeout)
      phase = 'early_stream'
      
      // 检查响应状态
      if (response.statusCode !== 200) {
        reject(Object.assign(
          new Error(`HTTP ${response.statusCode}`),
          { phase, statusCode: response.statusCode }
        ))
        return
      }
      
      // 设置数据传输超时
      let dataTimeout
      const resetDataTimeout = () => {
        clearTimeout(dataTimeout)
        dataTimeout = setTimeout(() => {
          if (failoverController.canDoFailover()) {
            reject(Object.assign(new Error('Stream timeout'), { phase: 'early_stream' }))
          } else {
            // 已经发送太多数据，不能故障转移，只能报错给客户端
            responseStream.write('event: error\ndata: {"error": "Stream timeout"}\n\n')
          }
        }, 30000)
      }
      
      response.on('data', (chunk) => {
        resetDataTimeout()
        failoverController.onData(chunk)
        
        // 检查是否是SSE事件
        if (chunk.toString().includes('\n\n')) {
          failoverController.onEvent()
        }
        
        // 更新阶段
        if (!failoverController.canDoFailover()) {
          phase = 'streaming'
        }
        
        // 转发数据
        responseStream.write(chunk)
      })
      
      response.on('end', () => {
        clearTimeout(dataTimeout)
        resolve()
      })
      
      response.on('error', (error) => {
        clearTimeout(dataTimeout)
        reject(Object.assign(error, { phase }))
      })
    })
    
    streamConnection.on('error', (error) => {
      clearTimeout(connectionTimeout)
      reject(Object.assign(error, { phase }))
    })
  })
}
```

## 4. API路由层修改

### 4.1 修改 /v1/messages 端点
```javascript
// src/routes/api.js

async function handleMessagesRequest(req, res) {
  try {
    const isStream = req.body.stream === true
    
    if (isStream) {
      // 流式请求 - 使用故障转移
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      
      // 根据账户类型选择服务
      const accountType = await determineAccountType(req.apiKey, req.body.model)
      
      if (accountType === 'claude-official') {
        await claudeRelayService.relayStreamWithFailover(
          req.body,
          req.apiKey,
          res,
          req.headers,
          usageCallback
        )
      } else if (accountType === 'claude-console') {
        await claudeConsoleRelayService.relayStreamWithFailover(
          req.body,
          req.apiKey,
          res,
          req.headers,
          usageCallback
        )
      }
    } else {
      // 非流式请求 - 使用故障转移
      let response
      const accountType = await determineAccountType(req.apiKey, req.body.model)
      
      if (accountType === 'claude-official') {
        response = await claudeRelayService.relayRequestWithFailover(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers
        )
      } else if (accountType === 'claude-console') {
        response = await claudeConsoleRelayService.relayRequestWithFailover(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers
        )
      }
      
      // 处理响应
      res.status(response.statusCode)
      res.json(response.body)
    }
  } catch (error) {
    handleError(error, res)
  }
}
```

## 5. 配置管理

### 5.1 添加故障转移配置
```javascript
// config/config.js
module.exports = {
  // ... 现有配置
  
  failover: {
    // 账户健康恢复时间（毫秒）
    accountRecoveryTime: 5 * 60 * 1000,  // 5分钟
    
    // 流式故障转移阈值
    stream: {
      earlyTimeWindow: 5000,      // 5秒内可以故障转移
      earlyBytesThreshold: 1024,  // 1KB内可以故障转移
      earlyEventsThreshold: 3,    // 3个事件内可以故障转移
      connectionTimeout: 10000,   // 连接超时10秒
      dataTimeout: 30000          // 数据超时30秒
    },
    
    // 非流式请求超时
    requestTimeout: 60000,  // 60秒
    
    // 是否启用账户健康度监控
    enableHealthMonitoring: true,
    
    // 不应重试的HTTP状态码
    nonRetryableStatusCodes: [400, 422]
  }
}
```

## 6. 监控和日志

### 6.1 关键指标
```javascript
// 需要监控的指标
const metrics = {
  // 故障转移次数
  failoverAttempts: 0,
  
  // 故障转移成功率
  failoverSuccess: 0,
  failoverFailed: 0,
  
  // 各账户健康度
  accountHealth: {},
  
  // 平均故障转移时间
  avgFailoverTime: 0,
  
  // 按错误类型统计
  errorsByType: {}
}
```

### 6.2 日志规范
```javascript
// 故障转移开始
logger.info('🔄 [FAILOVER_START]', {
  apiKey: apiKeyData.name,
  model: requestBody.model,
  availableAccounts: accountPool.length,
  isStream: options.stream || false
})

// 账户尝试
logger.info('🎯 [ACCOUNT_ATTEMPT]', {
  accountId: account.id,
  accountName: account.name,
  attemptNumber: attemptedAccounts.length,
  totalAccounts: accountPool.length
})

// 账户失败
logger.warn('⚠️ [ACCOUNT_FAILED]', {
  accountId: account.id,
  error: error.message,
  statusCode: response?.statusCode,
  willRetry: hasMoreAccounts
})

// 故障转移成功
logger.info('✅ [FAILOVER_SUCCESS]', {
  finalAccountId: account.id,
  totalAttempts: attemptedAccounts.length,
  duration: Date.now() - startTime
})

// 故障转移失败
logger.error('❌ [FAILOVER_EXHAUSTED]', {
  attemptedAccounts,
  lastError: lastError.message,
  duration: Date.now() - startTime
})
```

## 7. 测试方案

### 7.1 单元测试
- 测试故障判定逻辑
- 测试账户选择策略
- 测试健康度管理

### 7.2 集成测试
- 模拟账户故障场景
- 验证故障转移流程
- 测试流式故障转移阈值

### 7.3 性能测试
- 故障转移延迟测试
- 并发故障转移测试
- 内存使用测试（特别是流式缓存）

## 8. 实施计划

### 第一阶段：非流式请求故障转移（1-2天）
1. 实现 AccountHealthManager
2. 增强 ClaudeRelayService.relayRequestWithFailover
3. 实现 ClaudeConsoleRelayService.relayRequestWithFailover
4. 修改 API 路由使用新方法
5. 测试验证

### 第二阶段：流式请求基础故障转移（2-3天）
1. 实现 StreamFailoverController
2. 实现连接阶段故障转移
3. 实现早期流故障检测
4. 添加流式故障转移到两个Service
5. 测试验证

### 第三阶段：优化和监控（1天）
1. 添加监控指标
2. 优化日志输出
3. 性能调优
4. 文档更新

## 9. 风险和注意事项

### 9.1 潜在风险
1. **重复请求风险**：故障转移会导致同一请求发送多次，需要确保幂等性
2. **成本增加**：失败的请求也会产生token消耗
3. **延迟增加**：多次尝试会增加响应时间
4. **内存使用**：流式缓存可能占用较多内存

### 9.2 注意事项
1. 确保不会无限重试，设置合理的超时
2. 记录详细的故障转移日志，便于问题排查
3. 考虑添加熔断机制，避免雪崩效应
4. 定期清理故障账户记录，避免内存泄漏

## 10. 后续优化方向

1. **智能账户选择**：基于历史成功率动态调整优先级
2. **预测性故障检测**：根据账户行为模式预测故障
3. **自适应阈值**：根据实际运行情况动态调整故障转移阈值
4. **分布式健康度**：使用Redis共享账户健康度信息
5. **细粒度故障类型**：区分不同类型的故障，采用不同的处理策略