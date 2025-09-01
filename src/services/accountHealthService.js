const axios = require('axios')
const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const geminiAccountService = require('./geminiAccountService')
const openaiAccountService = require('./openaiAccountService')
const accountGroupService = require('./accountGroupService')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')

class AccountHealthService {
  constructor() {
    this.HEALTH_CHECK_PREFIX = 'account_health:'
    this.HEALTH_HISTORY_PREFIX = 'account_health_history:'
    this.FALLBACK_ACCOUNT_PREFIX = 'fallback_account:'
    this.CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟检查一次
    this.FAILURE_THRESHOLD = 3 // 连续失败3次标记为不健康
    this.RECOVERY_THRESHOLD = 2 // 连续成功2次标记为恢复
    this.QUARANTINE_DURATION = 30 * 60 * 1000 // 30分钟隔离时间
    this.isRunning = false
  }

  // 🚀 启动健康检查服务
  async start() {
    if (this.isRunning) {
      logger.warn('⚠️ Account health service is already running')
      return
    }

    this.isRunning = true
    logger.success('🔍 Starting account health monitoring service...')
    
    // 立即执行一次检查
    await this.performHealthCheck()
    
    // 设置定时检查
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck().catch(error => {
        logger.error('❌ Health check interval error:', error)
      })
    }, this.CHECK_INTERVAL)
  }

  // ⏹️ 停止健康检查服务
  stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    this.isRunning = false
    logger.info('⏹️ Account health monitoring service stopped')
  }

  // 🏥 执行完整的健康检查
  async performHealthCheck() {
    try {
      logger.info('🔍 Starting comprehensive account health check...')
      
      const promises = [
        this.checkClaudeAccounts(),
        this.checkClaudeConsoleAccounts(),
        this.checkGeminiAccounts(),
        this.checkOpenAIAccounts()
      ]

      await Promise.allSettled(promises)
      
      // 清理过期的健康记录
      await this.cleanupExpiredRecords()
      
      logger.success('✅ Account health check completed')
    } catch (error) {
      logger.error('❌ Failed to perform health check:', error)
    }
  }

  // 🎭 检查Claude OAuth账户
  async checkClaudeAccounts() {
    try {
      const accounts = await redis.getAllClaudeAccounts()
      const activeAccounts = accounts.filter(acc => 
        acc.isActive === 'true' && acc.status !== 'blocked'
      )

      logger.info(`🔍 Checking ${activeAccounts.length} Claude OAuth accounts...`)
      
      for (const account of activeAccounts) {
        try {
          await this.checkSingleAccount(account.id, 'claude-official', account.name)
        } catch (error) {
          logger.error(`❌ Failed to check Claude account ${account.name}:`, error)
        }
      }
    } catch (error) {
      logger.error('❌ Failed to check Claude accounts:', error)
    }
  }

  // 🎮 检查Claude Console账户
  async checkClaudeConsoleAccounts() {
    try {
      const accounts = await claudeConsoleAccountService.getAllAccounts()
      const activeAccounts = accounts.filter(acc => 
        acc.isActive === true && acc.status === 'active'
      )

      logger.info(`🔍 Checking ${activeAccounts.length} Claude Console accounts...`)
      
      for (const account of activeAccounts) {
        try {
          await this.checkSingleAccount(account.id, 'claude-console', account.name)
        } catch (error) {
          logger.error(`❌ Failed to check Claude Console account ${account.name}:`, error)
        }
      }
    } catch (error) {
      logger.error('❌ Failed to check Claude Console accounts:', error)
    }
  }

  // 🧠 检查Gemini账户
  async checkGeminiAccounts() {
    try {
      const accounts = await geminiAccountService.getAllAccounts()
      const activeAccounts = accounts.filter(acc => 
        acc.isActive === true && acc.status === 'active'
      )

      logger.info(`🔍 Checking ${activeAccounts.length} Gemini accounts...`)
      
      for (const account of activeAccounts) {
        try {
          await this.checkSingleAccount(account.id, 'gemini', account.name)
        } catch (error) {
          logger.error(`❌ Failed to check Gemini account ${account.name}:`, error)
        }
      }
    } catch (error) {
      logger.error('❌ Failed to check Gemini accounts:', error)
    }
  }

  // 🤖 检查OpenAI账户
  async checkOpenAIAccounts() {
    try {
      const accounts = await openaiAccountService.getAllAccounts()
      const activeAccounts = accounts.filter(acc => 
        acc.isActive === true && acc.status === 'active'
      )

      logger.info(`🔍 Checking ${activeAccounts.length} OpenAI accounts...`)
      
      for (const account of activeAccounts) {
        try {
          await this.checkSingleAccount(account.id, 'openai', account.name)
        } catch (error) {
          logger.error(`❌ Failed to check OpenAI account ${account.name}:`, error)
        }
      }
    } catch (error) {
      logger.error('❌ Failed to check OpenAI accounts:', error)
    }
  }

  // 🔍 检查单个账户健康状态
  async checkSingleAccount(accountId, accountType, accountName = 'Unknown') {
    try {
      const startTime = Date.now()
      let isHealthy = false
      let errorMessage = null
      let testResult = null
      
      try {
        // 根据账户类型发送测试请求
        switch (accountType) {
          case 'claude-official':
            isHealthy = await this.testClaudeAccount(accountId)
            break
          case 'claude-console':
            testResult = await this.testClaudeConsoleAccount(accountId)
            isHealthy = testResult && testResult.success
            break
          case 'gemini':
            isHealthy = await this.testGeminiAccount(accountId)
            break
          case 'openai':
            isHealthy = await this.testOpenAIAccount(accountId)
            break
          default:
            throw new Error(`Unsupported account type: ${accountType}`)
        }
      } catch (error) {
        isHealthy = false
        errorMessage = error.message
      }

      const responseTime = Date.now() - startTime
      
      // 构建健康状态对象
      const healthStatus = {
        healthy: isHealthy,
        responseTime,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }

      // 如果是Claude Console账户且有模型支持信息，添加到状态中
      if (accountType === 'claude-console' && testResult && testResult.modelSupport) {
        healthStatus.modelSupport = testResult.modelSupport
        healthStatus.testedAt = testResult.testedAt
      }
      
      // 记录健康状态
      await this.recordHealthStatus(accountId, accountType, healthStatus)

      // 分析健康趋势并采取行动
      await this.analyzeHealthTrend(accountId, accountType, accountName)

      if (isHealthy) {
        const modelInfo = (testResult && testResult.modelSupport) ? 
          ` (Models: ${Object.keys(testResult.modelSupport).filter(m => testResult.modelSupport[m].supported).length}/4 supported)` : ''
        logger.debug(`✅ Account ${accountName} (${accountType}) is healthy (${responseTime}ms)${modelInfo}`)
      } else {
        logger.warn(`❌ Account ${accountName} (${accountType}) is unhealthy: ${errorMessage}`)
      }

    } catch (error) {
      logger.error(`❌ Failed to check account ${accountName} (${accountType}):`, error)
    }
  }

  // 🧪 测试Claude OAuth账户
  async testClaudeAccount(accountId) {
    try {
      // 获取账户信息和OAuth token
      const account = await redis.getClaudeAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      // 检查是否需要刷新token
      await claudeAccountService.ensureValidToken(accountId)
      
      const updatedAccount = await redis.getClaudeAccount(accountId)
      const accessToken = claudeAccountService.decryptToken(updatedAccount.claudeAiOauth, 'accessToken')

      // 发送简单的测试请求
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-haiku-20240307',
          max_tokens: 10,
          messages: [{ role: 'user', content: '你好' }]
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          timeout: 30000,
          ...(account.proxyConfig && { httpsAgent: claudeAccountService.createProxyAgent(account.proxyConfig) })
        }
      )

      return response.status === 200 && response.data.content
    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('Rate limited')
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('Authentication failed')
      } else if (error.response?.status >= 500) {
        throw new Error('Server error')
      }
      throw new Error(`Request failed: ${error.message}`)
    }
  }

  // 🧪 测试Claude Console账户
  async testClaudeConsoleAccount(accountId) {
    try {
      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      // 使用账户配置的apiUrl，如果没有则使用默认值
      let testUrl = account.apiUrl
      if (!testUrl) {
        // 如果没有配置apiUrl，尝试构建默认URL
        if (account.organizationId) {
          testUrl = `https://claude.ai/api/organizations/${account.organizationId}/chat_conversations`
        } else {
          throw new Error('No API URL or organization ID configured for this account')
        }
      }

      // 定义要测试的模型列表
      const modelsToTest = [
        'claude-sonnet-4-20250514',
        'claude-opus-4-1-20250805', 
        'claude-3-7-sonnet-20250219',
        'claude-3-5-haiku-20241022'
      ]

      const modelSupport = {}
      let overallSuccess = false

      // 为每个模型发送测试请求
      for (const model of modelsToTest) {
        try {
          const response = await axios.post(
            testUrl,
            {
              prompt: 'Hi',
              model: model,
              timezone: 'Asia/Shanghai'
            },
            {
              headers: {
                'Cookie': account.sessionKey,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
              },
              timeout: 30000,
              ...(account.proxyConfig && { httpsAgent: claudeConsoleAccountService.createProxyAgent(account.proxyConfig) })
            }
          )

          modelSupport[model] = {
            supported: response.status === 200,
            status: response.status,
            error: null
          }

          if (response.status === 200) {
            overallSuccess = true
          }

        } catch (error) {
          let errorMessage = 'Unknown error'
          if (error.response?.status === 429) {
            errorMessage = 'Rate limited'
          } else if (error.response?.status === 401 || error.response?.status === 403) {
            errorMessage = 'Session expired'
          } else if (error.response?.status === 400) {
            errorMessage = 'Model not supported or invalid request'
          } else if (error.response?.status === 404) {
            errorMessage = 'Model not found'
          } else {
            errorMessage = error.message
          }

          modelSupport[model] = {
            supported: false,
            status: error.response?.status || null,
            error: errorMessage
          }
        }

        // 在模型测试之间添加短暂延迟，避免触发速率限制
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      // 将模型支持信息存储到账户数据中
      if (account.id) {
        const updatedAccount = {
          ...account,
          modelSupport: modelSupport,
          lastModelTest: new Date().toISOString()
        }
        await claudeConsoleAccountService.updateAccount(account.id, { 
          modelSupport: modelSupport,
          lastModelTest: new Date().toISOString()
        })
      }

      return {
        success: overallSuccess,
        modelSupport: modelSupport,
        testedAt: new Date().toISOString()
      }

    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('Rate limited')
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('Session expired')
      }
      throw new Error(`Request failed: ${error.message}`)
    }
  }

  // 🧪 测试Gemini账户
  async testGeminiAccount(accountId) {
    try {
      const account = await geminiAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${account.apiKey}`,
        {
          contents: [{ parts: [{ text: '你好' }] }],
          generationConfig: { maxOutputTokens: 10 }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      )

      return response.status === 200 && response.data.candidates
    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('Rate limited')
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('API key invalid')
      }
      throw new Error(`Request failed: ${error.message}`)
    }
  }

  // 🧪 测试OpenAI账户
  async testOpenAIAccount(accountId) {
    try {
      const account = await openaiAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Account not found')
      }

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 10
        },
        {
          headers: {
            'Authorization': `Bearer ${account.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      )

      return response.status === 200 && response.data.choices
    } catch (error) {
      if (error.response?.status === 429) {
        throw new Error('Rate limited')
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('API key invalid')
      }
      throw new Error(`Request failed: ${error.message}`)
    }
  }

  // 📊 记录健康状态
  async recordHealthStatus(accountId, accountType, status) {
    try {
      const client = redis.getClientSafe()
      const healthKey = `${this.HEALTH_CHECK_PREFIX}${accountId}`
      const historyKey = `${this.HEALTH_HISTORY_PREFIX}${accountId}`
      
      // 基础状态信息
      const healthData = {
        accountType,
        healthy: status.healthy.toString(),
        responseTime: status.responseTime.toString(),
        error: status.error || '',
        lastCheck: status.timestamp,
        updatedAt: new Date().toISOString()
      }

      // 如果有模型支持信息，添加到健康数据中
      if (status.modelSupport) {
        healthData.modelSupport = JSON.stringify(status.modelSupport)
        healthData.modelTestedAt = status.testedAt || status.timestamp
        
        // 统计支持的模型数量
        const supportedModels = Object.keys(status.modelSupport).filter(
          model => status.modelSupport[model].supported
        )
        healthData.supportedModelsCount = supportedModels.length.toString()
        healthData.supportedModels = supportedModels.join(',')
      }
      
      // 更新当前状态
      await client.hmset(healthKey, healthData)

      // 记录历史状态（最近50次）
      await client.lpush(historyKey, JSON.stringify(status))
      await client.ltrim(historyKey, 0, 49)
      
      // 设置过期时间
      await client.expire(healthKey, 86400) // 24小时
      await client.expire(historyKey, 86400) // 24小时

    } catch (error) {
      logger.error('❌ Failed to record health status:', error)
    }
  }

  // 📈 分析健康趋势
  async analyzeHealthTrend(accountId, accountType, accountName) {
    try {
      const client = redis.getClientSafe()
      const historyKey = `${this.HEALTH_HISTORY_PREFIX}${accountId}`
      
      // 获取最近的检查记录
      const recentChecks = await client.lrange(historyKey, 0, 9) // 最近10次
      
      if (recentChecks.length === 0) return
      
      const healthHistory = recentChecks.map(record => {
        try {
          return JSON.parse(record)
        } catch {
          return null
        }
      }).filter(Boolean)

      const recentFailures = healthHistory.filter(check => !check.healthy).length
      const recentSuccesses = healthHistory.filter(check => check.healthy).length
      
      const currentStatus = await this.getAccountHealthStatus(accountId)
      
      // 判断是否需要标记为不健康
      if (recentFailures >= this.FAILURE_THRESHOLD && !currentStatus.quarantined) {
        await this.quarantineAccount(accountId, accountType, accountName, 'consecutive_failures')
      }
      
      // 判断是否可以恢复
      else if (recentSuccesses >= this.RECOVERY_THRESHOLD && currentStatus.quarantined) {
        await this.recoverAccount(accountId, accountType, accountName)
      }

    } catch (error) {
      logger.error('❌ Failed to analyze health trend:', error)
    }
  }

  // 🚫 隔离不健康的账户
  async quarantineAccount(accountId, accountType, accountName, reason) {
    try {
      const client = redis.getClientSafe()
      const healthKey = `${this.HEALTH_CHECK_PREFIX}${accountId}`
      
      await client.hmset(healthKey, {
        quarantined: 'true',
        quarantineReason: reason,
        quarantineTime: new Date().toISOString(),
        quarantineUntil: new Date(Date.now() + this.QUARANTINE_DURATION).toISOString()
      })

      // 自动设置账户为不可调度
      await this.setAccountSchedulable(accountId, accountType, false)
      
      logger.warn(`🚫 Quarantined unhealthy account: ${accountName} (${accountType}) - ${reason}`)
      
      // 清除相关的会话映射
      await this.clearAccountSessionMappings(accountId, accountType)

    } catch (error) {
      logger.error('❌ Failed to quarantine account:', error)
    }
  }

  // 🔄 恢复健康的账户
  async recoverAccount(accountId, accountType, accountName) {
    try {
      const client = redis.getClientSafe()
      const healthKey = `${this.HEALTH_CHECK_PREFIX}${accountId}`
      
      await client.hmset(healthKey, {
        quarantined: 'false',
        recoveryTime: new Date().toISOString()
      })

      // 恢复账户调度
      await this.setAccountSchedulable(accountId, accountType, true)
      
      logger.success(`✅ Recovered healthy account: ${accountName} (${accountType})`)

    } catch (error) {
      logger.error('❌ Failed to recover account:', error)
    }
  }

  // 📋 获取账户健康状态
  async getAccountHealthStatus(accountId) {
    try {
      const client = redis.getClientSafe()
      const healthKey = `${this.HEALTH_CHECK_PREFIX}${accountId}`
      const healthData = await client.hgetall(healthKey)
      
      if (!healthData || Object.keys(healthData).length === 0) {
        return { healthy: null, quarantined: false }
      }

      // 检查隔离是否过期
      if (healthData.quarantined === 'true' && healthData.quarantineUntil) {
        const quarantineEnd = new Date(healthData.quarantineUntil)
        if (Date.now() > quarantineEnd.getTime()) {
          // 隔离期已过，自动恢复
          await this.recoverAccount(accountId, healthData.accountType, 'Auto-recovered')
          return { healthy: true, quarantined: false }
        }
      }

      return {
        healthy: healthData.healthy === 'true',
        quarantined: healthData.quarantined === 'true',
        responseTime: parseInt(healthData.responseTime) || 0,
        lastCheck: healthData.lastCheck,
        error: healthData.error || null,
        quarantineReason: healthData.quarantineReason || null,
        quarantineUntil: healthData.quarantineUntil || null
      }
    } catch (error) {
      logger.error('❌ Failed to get account health status:', error)
      return { healthy: null, quarantined: false }
    }
  }

  // ⚙️ 设置账户调度状态
  async setAccountSchedulable(accountId, accountType, schedulable) {
    try {
      switch (accountType) {
        case 'claude-official':
          const account = await redis.getClaudeAccount(accountId)
          if (account) {
            account.schedulable = schedulable.toString()
            await redis.setClaudeAccount(accountId, account)
          }
          break
        case 'claude-console':
          await claudeConsoleAccountService.updateAccount(accountId, { schedulable })
          break
        case 'gemini':
          await geminiAccountService.updateAccount(accountId, { schedulable })
          break
        case 'openai':
          await openaiAccountService.updateAccount(accountId, { schedulable })
          break
      }
      
      logger.info(`⚙️ Set account ${accountId} (${accountType}) schedulable: ${schedulable}`)
    } catch (error) {
      logger.error('❌ Failed to set account schedulable:', error)
    }
  }

  // 🗑️ 清除账户的会话映射
  async clearAccountSessionMappings(accountId, accountType) {
    try {
      const client = redis.getClientSafe()
      const sessionPattern = 'unified_claude_session_mapping:*'
      
      const keys = await client.keys(sessionPattern)
      let clearedCount = 0
      
      for (const key of keys) {
        const mappingData = await client.get(key)
        if (mappingData) {
          try {
            const mapping = JSON.parse(mappingData)
            if (mapping.accountId === accountId && mapping.accountType === accountType) {
              await client.del(key)
              clearedCount++
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }

      if (clearedCount > 0) {
        logger.info(`🗑️ Cleared ${clearedCount} session mappings for account ${accountId}`)
      }
    } catch (error) {
      logger.error('❌ Failed to clear account session mappings:', error)
    }
  }

  // 🧹 清理过期记录
  async cleanupExpiredRecords() {
    try {
      const client = redis.getClientSafe()
      
      // 清理过期的健康检查记录
      const healthKeys = await client.keys(`${this.HEALTH_CHECK_PREFIX}*`)
      const historyKeys = await client.keys(`${this.HEALTH_HISTORY_PREFIX}*`)
      
      const expiredKeys = []
      
      for (const key of [...healthKeys, ...historyKeys]) {
        const ttl = await client.ttl(key)
        if (ttl === -1) { // 没有设置过期时间
          await client.expire(key, 86400)
        } else if (ttl === -2) { // 已过期
          expiredKeys.push(key)
        }
      }

      if (expiredKeys.length > 0) {
        await client.del(...expiredKeys)
        logger.info(`🧹 Cleaned up ${expiredKeys.length} expired health records`)
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup expired records:', error)
    }
  }

  // 📊 获取健康统计信息
  async getHealthStats() {
    try {
      const client = redis.getClientSafe()
      const healthKeys = await client.keys(`${this.HEALTH_CHECK_PREFIX}*`)
      
      const stats = {
        total: healthKeys.length,
        healthy: 0,
        unhealthy: 0,
        quarantined: 0,
        byType: {}
      }
      
      for (const key of healthKeys) {
        const healthData = await client.hgetall(key)
        if (healthData && Object.keys(healthData).length > 0) {
          const accountType = healthData.accountType || 'unknown'
          
          if (!stats.byType[accountType]) {
            stats.byType[accountType] = { healthy: 0, unhealthy: 0, quarantined: 0 }
          }
          
          if (healthData.quarantined === 'true') {
            stats.quarantined++
            stats.byType[accountType].quarantined++
          } else if (healthData.healthy === 'true') {
            stats.healthy++
            stats.byType[accountType].healthy++
          } else {
            stats.unhealthy++
            stats.byType[accountType].unhealthy++
          }
        }
      }
      
      return stats
    } catch (error) {
      logger.error('❌ Failed to get health stats:', error)
      return { total: 0, healthy: 0, unhealthy: 0, quarantined: 0, byType: {} }
    }
  }

  // 🔧 手动触发账户检查
  async checkAccountManually(accountId, accountType) {
    try {
      logger.info(`🔧 Manually checking account: ${accountId} (${accountType})`)
      await this.checkSingleAccount(accountId, accountType)
      return await this.getAccountHealthStatus(accountId)
    } catch (error) {
      logger.error('❌ Failed to manually check account:', error)
      throw error
    }
  }
}

module.exports = new AccountHealthService()