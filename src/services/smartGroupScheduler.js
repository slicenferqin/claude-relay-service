const accountGroupService = require('./accountGroupService')
const accountHealthService = require('./accountHealthService')
const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const geminiAccountService = require('./geminiAccountService')
const openaiAccountService = require('./openaiAccountService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class SmartGroupScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'smart_session_mapping:'
    this.FALLBACK_ACCOUNT_PREFIX = 'fallback_account:'
    this.ACCOUNT_FAILURE_PREFIX = 'account_failure:'
    this.RETRY_THRESHOLD = 3 // 失败3次后切换账户
    this.FALLBACK_COOLDOWN = 10 * 60 * 1000 // 10分钟后尝试回切
  }

  // 🎯 智能分组调度 - 主入口
  async selectAccountFromGroup(groupId, sessionHash = null, requestedModel = null, requestContext = {}) {
    try {
      logger.info(`🎯 Smart group scheduling for group: ${groupId}`)
      
      // 获取分组信息
      const group = await accountGroupService.getGroup(groupId)
      if (!group) {
        throw new Error(`Group ${groupId} not found`)
      }

      // 检查会话粘性
      if (sessionHash) {
        const result = await this.handleSessionAffinity(groupId, sessionHash, requestedModel, requestContext)
        if (result) return result
      }

      // 获取分组内健康的账户
      const healthyAccounts = await this.getHealthyAccountsInGroup(groupId, requestedModel)
      
      if (healthyAccounts.length > 0) {
        // 从健康账户中选择
        const selectedAccount = await this.selectOptimalAccount(healthyAccounts, requestContext)
        
        // 建立会话映射
        if (sessionHash) {
          await this.createSessionMapping(sessionHash, selectedAccount, groupId)
        }
        
        logger.success(`✅ Selected healthy account: ${selectedAccount.name} from group ${group.name}`)
        return {
          accountId: selectedAccount.accountId,
          accountType: selectedAccount.accountType,
          source: 'group',
          groupId: groupId
        }
      }

      // 分组内无健康账户，尝试使用后备账户
      logger.warn(`⚠️ No healthy accounts in group ${group.name}, trying fallback`)
      const fallbackAccount = await this.getFallbackAccount(group.platform, requestedModel)
      
      if (fallbackAccount) {
        // 建立临时会话映射到后备账户
        if (sessionHash) {
          await this.createFallbackSessionMapping(sessionHash, fallbackAccount, groupId)
        }
        
        logger.warn(`🔄 Using fallback account: ${fallbackAccount.name} for group ${group.name}`)
        return {
          accountId: fallbackAccount.accountId,
          accountType: fallbackAccount.accountType,
          source: 'fallback',
          originalGroupId: groupId
        }
      }

      throw new Error(`No healthy accounts available in group ${group.name} and no fallback account configured`)
      
    } catch (error) {
      logger.error('❌ Smart group scheduling failed:', error)
      throw error
    }
  }

  // 🔄 处理会话粘性
  async handleSessionAffinity(groupId, sessionHash, requestedModel, requestContext) {
    try {
      const sessionMapping = await this.getSessionMapping(sessionHash)
      
      if (!sessionMapping) {
        logger.debug(`🔍 No existing session mapping for ${sessionHash}`)
        return null
      }

      // 检查映射的账户是否仍然健康
      const healthStatus = await accountHealthService.getAccountHealthStatus(
        sessionMapping.accountId
      )

      // 如果账户健康且仍在分组中，继续使用
      if (healthStatus.healthy && !healthStatus.quarantined) {
        // 验证账户仍属于该分组（除非是后备账户）
        if (sessionMapping.source === 'fallback' || await this.isAccountInGroup(sessionMapping.accountId, groupId)) {
          logger.info(`✅ Using existing session mapping: ${sessionMapping.accountId} for ${sessionHash}`)
          return {
            accountId: sessionMapping.accountId,
            accountType: sessionMapping.accountType,
            source: sessionMapping.source || 'group',
            groupId: groupId
          }
        }
      }

      // 账户不健康或已被移出分组，需要重新选择
      logger.warn(`⚠️ Session mapping ${sessionHash} -> ${sessionMapping.accountId} is invalid, reassigning`)
      await this.clearSessionMapping(sessionHash)
      
      // 记录故障转移
      await this.recordFailover(sessionHash, sessionMapping.accountId, sessionMapping.accountType, 'unhealthy_account')
      
      return null
    } catch (error) {
      logger.error('❌ Failed to handle session affinity:', error)
      return null
    }
  }

  // 🏥 获取分组内健康的账户
  async getHealthyAccountsInGroup(groupId, requestedModel = null) {
    try {
      const memberIds = await accountGroupService.getGroupMembers(groupId)
      const healthyAccounts = []

      for (const memberId of memberIds) {
        const account = await this.getAccountDetails(memberId)
        if (!account) continue

        // 检查健康状态
        const healthStatus = await accountHealthService.getAccountHealthStatus(memberId)
        
        if (healthStatus.healthy && !healthStatus.quarantined) {
          // 检查模型支持
          if (requestedModel && !await this.supportsModel(account, requestedModel)) {
            logger.debug(`🚫 Account ${account.name} does not support model ${requestedModel}`)
            continue
          }

          // 检查基本可用性
          if (await this.isAccountAvailable(account)) {
            healthyAccounts.push({
              ...account,
              accountId: memberId,
              healthStatus: healthStatus
            })
          }
        } else {
          logger.debug(`🚫 Account ${memberId} is not healthy: ${healthStatus.error || 'unknown error'}`)
        }
      }

      logger.info(`📊 Found ${healthyAccounts.length}/${memberIds.length} healthy accounts in group ${groupId}`)
      return healthyAccounts
    } catch (error) {
      logger.error('❌ Failed to get healthy accounts in group:', error)
      return []
    }
  }

  // 🎯 选择最优账户
  async selectOptimalAccount(accounts, requestContext = {}) {
    try {
      // 按优先级和健康状态排序
      const sortedAccounts = accounts.sort((a, b) => {
        // 优先级越低数字越小，优先级越高
        const priorityA = parseInt(a.priority) || 50
        const priorityB = parseInt(b.priority) || 50
        
        if (priorityA !== priorityB) {
          return priorityA - priorityB
        }

        // 相同优先级按响应时间排序
        const responseTimeA = a.healthStatus?.responseTime || 9999
        const responseTimeB = b.healthStatus?.responseTime || 9999
        
        return responseTimeA - responseTimeB
      })

      return sortedAccounts[0]
    } catch (error) {
      logger.error('❌ Failed to select optimal account:', error)
      return accounts[0] // 降级返回第一个
    }
  }

  // 🔄 获取后备账户
  async getFallbackAccount(platform, requestedModel = null) {
    try {
      const client = redis.getClientSafe()
      const fallbackKey = `${this.FALLBACK_ACCOUNT_PREFIX}${platform}`
      
      // 尝试获取配置的后备账户
      const fallbackConfig = await client.get(fallbackKey)
      let fallbackAccountId = null
      
      if (fallbackConfig) {
        try {
          const config = JSON.parse(fallbackConfig)
          fallbackAccountId = config.accountId
        } catch (e) {
          fallbackAccountId = fallbackConfig // 简单字符串格式
        }
      }

      // 如果没有配置后备账户，自动选择一个健康的共享账户
      if (!fallbackAccountId) {
        fallbackAccountId = await this.autoSelectFallbackAccount(platform, requestedModel)
      }

      if (fallbackAccountId) {
        const account = await this.getAccountDetails(fallbackAccountId)
        if (account && await this.isAccountAvailable(account)) {
          const healthStatus = await accountHealthService.getAccountHealthStatus(fallbackAccountId)
          
          if (healthStatus.healthy && !healthStatus.quarantined) {
            return {
              ...account,
              accountId: fallbackAccountId
            }
          }
        }
      }

      return null
    } catch (error) {
      logger.error('❌ Failed to get fallback account:', error)
      return null
    }
  }

  // 🤖 自动选择后备账户
  async autoSelectFallbackAccount(platform, requestedModel = null) {
    try {
      let accounts = []
      
      switch (platform) {
        case 'claude':
          // 获取Claude OAuth账户
          const claudeAccounts = await redis.getAllClaudeAccounts()
          accounts = claudeAccounts.filter(acc => 
            acc.isActive === 'true' && 
            acc.status !== 'error' && 
            (acc.accountType === 'shared' || !acc.accountType) &&
            acc.schedulable !== 'false'
          ).map(acc => ({ ...acc, accountId: acc.id, accountType: 'claude-official' }))
          
          // 也考虑Claude Console账户
          const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
          const availableConsoleAccounts = consoleAccounts.filter(acc =>
            acc.isActive === true &&
            acc.status === 'active' &&
            (acc.accountType === 'shared' || !acc.accountType) &&
            acc.schedulable !== false
          ).map(acc => ({ ...acc, accountId: acc.id, accountType: 'claude-console' }))
          
          accounts = [...accounts, ...availableConsoleAccounts]
          break
          
        case 'gemini':
          const geminiAccounts = await geminiAccountService.getAllAccounts()
          accounts = geminiAccounts.filter(acc => 
            acc.isActive === true && 
            acc.status === 'active' &&
            (acc.accountType === 'shared' || !acc.accountType) &&
            acc.schedulable !== false
          ).map(acc => ({ ...acc, accountId: acc.id, accountType: 'gemini' }))
          break
          
        case 'openai':
          const openaiAccounts = await openaiAccountService.getAllAccounts()
          accounts = openaiAccounts.filter(acc => 
            acc.isActive === true && 
            acc.status === 'active' &&
            (acc.accountType === 'shared' || !acc.accountType) &&
            acc.schedulable !== false
          ).map(acc => ({ ...acc, accountId: acc.id, accountType: 'openai' }))
          break
      }

      // 选择健康的账户作为后备
      for (const account of accounts) {
        const healthStatus = await accountHealthService.getAccountHealthStatus(account.accountId)
        if (healthStatus.healthy && !healthStatus.quarantined) {
          // 检查模型支持
          if (requestedModel && !await this.supportsModel(account, requestedModel)) {
            continue
          }
          
          logger.info(`🤖 Auto-selected fallback account: ${account.name} for platform ${platform}`)
          return account.accountId
        }
      }

      return null
    } catch (error) {
      logger.error('❌ Failed to auto-select fallback account:', error)
      return null
    }
  }

  // 📝 创建会话映射
  async createSessionMapping(sessionHash, account, groupId) {
    try {
      const client = redis.getClientSafe()
      const mappingKey = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      
      const mapping = {
        accountId: account.accountId,
        accountType: account.accountType,
        groupId: groupId,
        source: 'group',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      }
      
      await client.setex(mappingKey, 3600, JSON.stringify(mapping)) // 1小时过期
      logger.debug(`📝 Created session mapping: ${sessionHash} -> ${account.accountId}`)
    } catch (error) {
      logger.error('❌ Failed to create session mapping:', error)
    }
  }

  // 🔄 创建后备账户的会话映射
  async createFallbackSessionMapping(sessionHash, account, originalGroupId) {
    try {
      const client = redis.getClientSafe()
      const mappingKey = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      
      const mapping = {
        accountId: account.accountId,
        accountType: account.accountType,
        originalGroupId: originalGroupId,
        source: 'fallback',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      }
      
      await client.setex(mappingKey, 1800, JSON.stringify(mapping)) // 30分钟过期（比正常映射短）
      logger.debug(`🔄 Created fallback session mapping: ${sessionHash} -> ${account.accountId}`)
    } catch (error) {
      logger.error('❌ Failed to create fallback session mapping:', error)
    }
  }

  // 📖 获取会话映射
  async getSessionMapping(sessionHash) {
    try {
      const client = redis.getClientSafe()
      const mappingKey = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      const mappingData = await client.get(mappingKey)
      
      if (mappingData) {
        return JSON.parse(mappingData)
      }
      return null
    } catch (error) {
      logger.error('❌ Failed to get session mapping:', error)
      return null
    }
  }

  // 🗑️ 清除会话映射
  async clearSessionMapping(sessionHash) {
    try {
      const client = redis.getClientSafe()
      const mappingKey = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      await client.del(mappingKey)
      logger.debug(`🗑️ Cleared session mapping: ${sessionHash}`)
    } catch (error) {
      logger.error('❌ Failed to clear session mapping:', error)
    }
  }

  // 📊 记录故障转移
  async recordFailover(sessionHash, fromAccountId, accountType, reason) {
    try {
      const client = redis.getClientSafe()
      const failureKey = `${this.ACCOUNT_FAILURE_PREFIX}${fromAccountId}`
      
      const failureRecord = {
        sessionHash,
        accountType,
        reason,
        timestamp: new Date().toISOString()
      }
      
      // 记录故障历史（最近10次）
      await client.lpush(failureKey, JSON.stringify(failureRecord))
      await client.ltrim(failureKey, 0, 9)
      await client.expire(failureKey, 86400) // 24小时过期
      
      logger.warn(`📊 Recorded failover: ${fromAccountId} -> ${reason}`)
    } catch (error) {
      logger.error('❌ Failed to record failover:', error)
    }
  }

  // 🔍 检查账户是否在分组中
  async isAccountInGroup(accountId, groupId) {
    try {
      const memberIds = await accountGroupService.getGroupMembers(groupId)
      return memberIds.includes(accountId)
    } catch (error) {
      logger.error('❌ Failed to check if account is in group:', error)
      return false
    }
  }

  // 📋 获取账户详情
  async getAccountDetails(accountId) {
    try {
      // 尝试从不同服务获取账户信息
      let account = await redis.getClaudeAccount(accountId)
      if (account) {
        return { ...account, accountType: 'claude-official' }
      }

      account = await claudeConsoleAccountService.getAccount(accountId)
      if (account) {
        return { ...account, accountType: 'claude-console' }
      }

      account = await geminiAccountService.getAccount(accountId)
      if (account) {
        return { ...account, accountType: 'gemini' }
      }

      account = await openaiAccountService.getAccount(accountId)
      if (account) {
        return { ...account, accountType: 'openai' }
      }

      return null
    } catch (error) {
      logger.error('❌ Failed to get account details:', error)
      return null
    }
  }

  // ✅ 检查账户是否可用
  async isAccountAvailable(account) {
    try {
      if (!account) return false

      switch (account.accountType) {
        case 'claude-official':
          return account.isActive === 'true' && 
                 account.status !== 'error' && 
                 account.status !== 'blocked' &&
                 account.schedulable !== 'false'
                 
        case 'claude-console':
          return account.isActive === true && 
                 account.status === 'active' &&
                 account.schedulable !== false
                 
        case 'gemini':
        case 'openai':
          return account.isActive === true && 
                 account.status === 'active' &&
                 account.schedulable !== false
                 
        default:
          return false
      }
    } catch (error) {
      logger.error('❌ Failed to check account availability:', error)
      return false
    }
  }

  // 🎯 检查模型支持
  async supportsModel(account, requestedModel) {
    try {
      if (!requestedModel) return true

      // 检查Opus模型支持
      if (requestedModel.toLowerCase().includes('opus')) {
        if (account.accountType === 'claude-official') {
          if (account.subscriptionInfo) {
            try {
              const info = typeof account.subscriptionInfo === 'string' 
                ? JSON.parse(account.subscriptionInfo) 
                : account.subscriptionInfo
              
              // Pro和Free账号不支持Opus
              if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
                return false
              }
              if (info.accountType === 'claude_pro' || info.accountType === 'claude_free') {
                return false
              }
            } catch (e) {
              // 解析失败，默认支持（兼容旧数据）
            }
          }
        }
      }

      return true
    } catch (error) {
      logger.error('❌ Failed to check model support:', error)
      return true // 默认支持
    }
  }

  // ⚙️ 配置后备账户
  async setFallbackAccount(platform, accountId) {
    try {
      const client = redis.getClientSafe()
      const fallbackKey = `${this.FALLBACK_ACCOUNT_PREFIX}${platform}`
      
      const config = {
        accountId,
        configuredAt: new Date().toISOString()
      }
      
      await client.set(fallbackKey, JSON.stringify(config))
      logger.success(`⚙️ Configured fallback account for ${platform}: ${accountId}`)
    } catch (error) {
      logger.error('❌ Failed to set fallback account:', error)
      throw error
    }
  }

  // 📊 获取分组调度统计
  async getGroupSchedulingStats(groupId) {
    try {
      const group = await accountGroupService.getGroup(groupId)
      if (!group) {
        throw new Error(`Group ${groupId} not found`)
      }

      const memberIds = await accountGroupService.getGroupMembers(groupId)
      const stats = {
        groupId,
        groupName: group.name,
        platform: group.platform,
        totalMembers: memberIds.length,
        healthyMembers: 0,
        quarantinedMembers: 0,
        unhealthyMembers: 0,
        members: []
      }

      for (const memberId of memberIds) {
        const account = await this.getAccountDetails(memberId)
        const healthStatus = await accountHealthService.getAccountHealthStatus(memberId)
        
        const memberInfo = {
          accountId: memberId,
          name: account?.name || 'Unknown',
          accountType: account?.accountType || 'unknown',
          healthy: healthStatus.healthy,
          quarantined: healthStatus.quarantined,
          lastCheck: healthStatus.lastCheck,
          responseTime: healthStatus.responseTime,
          error: healthStatus.error
        }

        if (healthStatus.quarantined) {
          stats.quarantinedMembers++
        } else if (healthStatus.healthy) {
          stats.healthyMembers++
        } else {
          stats.unhealthyMembers++
        }

        stats.members.push(memberInfo)
      }

      return stats
    } catch (error) {
      logger.error('❌ Failed to get group scheduling stats:', error)
      throw error
    }
  }

  // 🔄 尝试回切到原分组账户
  async attemptGroupRecovery(sessionHash) {
    try {
      const sessionMapping = await this.getSessionMapping(sessionHash)
      
      if (!sessionMapping || sessionMapping.source !== 'fallback') {
        return false // 不是后备账户映射
      }

      const originalGroupId = sessionMapping.originalGroupId
      if (!originalGroupId) {
        return false
      }

      // 检查原分组是否有健康账户
      const healthyAccounts = await this.getHealthyAccountsInGroup(originalGroupId)
      
      if (healthyAccounts.length > 0) {
        const selectedAccount = await this.selectOptimalAccount(healthyAccounts)
        
        // 创建新的会话映射回到分组
        await this.createSessionMapping(sessionHash, selectedAccount, originalGroupId)
        
        logger.success(`🔄 Recovered session ${sessionHash} back to group ${originalGroupId}`)
        return true
      }

      return false
    } catch (error) {
      logger.error('❌ Failed to attempt group recovery:', error)
      return false
    }
  }
}

module.exports = new SmartGroupScheduler()