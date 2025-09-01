const accountHealthService = require('./accountHealthService')
const smartGroupScheduler = require('./smartGroupScheduler')
const accountGroupService = require('./accountGroupService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class AccountRecoveryManager {
  constructor() {
    this.RECOVERY_CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟检查一次恢复
    this.SESSION_MIGRATION_PREFIX = 'session_migration:'
    this.RECOVERY_ATTEMPT_PREFIX = 'recovery_attempt:'
    this.MAX_RECOVERY_ATTEMPTS = 5 // 最大恢复尝试次数
    this.RECOVERY_BACKOFF_BASE = 2 // 指数退避基数（分钟）
    this.isRunning = false
  }

  // 🚀 启动恢复管理器
  async start() {
    if (this.isRunning) {
      logger.warn('⚠️ Account recovery manager is already running')
      return
    }

    this.isRunning = true
    logger.success('🔄 Starting account recovery manager...')

    // 启动健康检查服务
    await accountHealthService.start()

    // 立即执行一次恢复检查
    await this.performRecoveryCheck()

    // 设置定时恢复检查
    this.recoveryInterval = setInterval(() => {
      this.performRecoveryCheck().catch((error) => {
        logger.error('❌ Recovery check interval error:', error)
      })
    }, this.RECOVERY_CHECK_INTERVAL)
  }

  // ⏹️ 停止恢复管理器
  stop() {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval)
      this.recoveryInterval = null
    }

    accountHealthService.stop()
    this.isRunning = false
    logger.info('⏹️ Account recovery manager stopped')
  }

  // 🔄 执行恢复检查
  async performRecoveryCheck() {
    try {
      logger.info('🔄 Starting account recovery check...')

      await Promise.allSettled([
        this.checkQuarantinedAccountRecovery(),
        this.migrateFallbackSessions(),
        this.cleanupExpiredRecoveryData()
      ])

      logger.success('✅ Account recovery check completed')
    } catch (error) {
      logger.error('❌ Failed to perform recovery check:', error)
    }
  }

  // 🏥 检查被隔离账户的恢复状态
  async checkQuarantinedAccountRecovery() {
    try {
      const client = redis.getClientSafe()
      const healthKeys = await client.keys('account_health:*')

      let recoveryAttempts = 0

      for (const healthKey of healthKeys) {
        const healthData = await client.hgetall(healthKey)

        if (healthData.quarantined === 'true') {
          const accountId = healthKey.replace('account_health:', '')

          // 检查隔离是否已过期
          if (healthData.quarantineUntil && new Date() > new Date(healthData.quarantineUntil)) {
            logger.info(
              `⏰ Quarantine period expired for account ${accountId}, attempting recovery`
            )
            await this.attemptAccountRecovery(accountId, healthData.accountType)
            recoveryAttempts++
          }

          // 检查是否应该进行主动恢复尝试
          else if (await this.shouldAttemptRecovery(accountId)) {
            logger.info(`🔄 Proactively attempting recovery for account ${accountId}`)
            await this.attemptAccountRecovery(accountId, healthData.accountType)
            recoveryAttempts++
          }
        }
      }

      if (recoveryAttempts > 0) {
        logger.info(`🔄 Attempted recovery for ${recoveryAttempts} quarantined accounts`)
      }
    } catch (error) {
      logger.error('❌ Failed to check quarantined account recovery:', error)
    }
  }

  // 🏥 尝试账户恢复
  async attemptAccountRecovery(accountId, accountType) {
    try {
      const attemptKey = `${this.RECOVERY_ATTEMPT_PREFIX}${accountId}`
      const client = redis.getClientSafe()

      // 检查恢复尝试历史
      const attemptData = await client.hgetall(attemptKey)
      const attempts = parseInt(attemptData.attempts) || 0

      if (attempts >= this.MAX_RECOVERY_ATTEMPTS) {
        logger.warn(`⚠️ Maximum recovery attempts reached for account ${accountId}`)
        return false
      }

      // 计算退避时间
      const lastAttempt = attemptData.lastAttempt ? new Date(attemptData.lastAttempt) : new Date(0)
      const backoffMinutes = Math.pow(this.RECOVERY_BACKOFF_BASE, attempts)
      const nextAttemptTime = new Date(lastAttempt.getTime() + backoffMinutes * 60 * 1000)

      if (Date.now() < nextAttemptTime.getTime()) {
        logger.debug(
          `⏰ Too early for recovery attempt on ${accountId}, next attempt at ${nextAttemptTime}`
        )
        return false
      }

      logger.info(
        `🔄 Attempting recovery for account ${accountId} (attempt ${attempts + 1}/${this.MAX_RECOVERY_ATTEMPTS})`
      )

      // 执行健康检查
      const isHealthy = await this.testAccountHealth(accountId, accountType)

      if (isHealthy) {
        logger.success(`✅ Account ${accountId} recovered successfully`)

        // 恢复账户
        await accountHealthService.recoverAccount(accountId, accountType, `Recovered by manager`)

        // 清理恢复尝试记录
        await client.del(attemptKey)

        // 触发会话迁移回原账户
        await this.triggerSessionMigration(accountId, accountType)

        return true
      } else {
        // 记录失败的恢复尝试
        await client.hmset(attemptKey, {
          attempts: (attempts + 1).toString(),
          lastAttempt: new Date().toISOString(),
          accountType
        })
        await client.expire(attemptKey, 86400 * 7) // 7天过期

        logger.warn(`❌ Recovery attempt failed for account ${accountId}`)
        return false
      }
    } catch (error) {
      logger.error(`❌ Failed to attempt account recovery for ${accountId}:`, error)
      return false
    }
  }

  // 🧪 测试账户健康状态
  async testAccountHealth(accountId, accountType) {
    try {
      // 使用健康检查服务进行测试
      await accountHealthService.checkSingleAccount(accountId, accountType)

      // 获取检查结果
      const healthStatus = await accountHealthService.getAccountHealthStatus(accountId)
      return healthStatus.healthy && !healthStatus.quarantined
    } catch (error) {
      logger.error(`❌ Failed to test account health for ${accountId}:`, error)
      return false
    }
  }

  // 🔄 迁移后备账户的会话
  async migrateFallbackSessions() {
    try {
      const client = redis.getClientSafe()
      const sessionKeys = await client.keys('smart_session_mapping:*')

      let migrationAttempts = 0

      for (const sessionKey of sessionKeys) {
        const sessionData = await client.get(sessionKey)

        if (sessionData) {
          try {
            const mapping = JSON.parse(sessionData)

            // 只处理后备账户的会话
            if (mapping.source === 'fallback' && mapping.originalGroupId) {
              const sessionHash = sessionKey.replace('smart_session_mapping:', '')

              // 尝试迁移回原分组
              const migrated = await smartGroupScheduler.attemptGroupRecovery(sessionHash)

              if (migrated) {
                migrationAttempts++
                logger.success(
                  `🔄 Migrated session ${sessionHash} back to group ${mapping.originalGroupId}`
                )
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }

      if (migrationAttempts > 0) {
        logger.info(`🔄 Migrated ${migrationAttempts} sessions back to their original groups`)
      }
    } catch (error) {
      logger.error('❌ Failed to migrate fallback sessions:', error)
    }
  }

  // 🎯 触发特定账户的会话迁移
  async triggerSessionMigration(accountId, accountType) {
    try {
      const client = redis.getClientSafe()

      // 查找所有可能受影响的分组
      const affectedGroups = await this.findGroupsWithAccount(accountId)

      for (const groupId of affectedGroups) {
        logger.info(
          `🎯 Triggering session migration for group ${groupId} after account ${accountId} recovery`
        )

        // 记录迁移触发
        const migrationKey = `${this.SESSION_MIGRATION_PREFIX}${groupId}`
        await client.setex(
          migrationKey,
          3600,
          JSON.stringify({
            triggeredBy: accountId,
            accountType,
            triggerTime: new Date().toISOString(),
            reason: 'account_recovery'
          })
        )
      }
    } catch (error) {
      logger.error('❌ Failed to trigger session migration:', error)
    }
  }

  // 🔍 查找包含特定账户的分组
  async findGroupsWithAccount(accountId) {
    try {
      const allGroups = await accountGroupService.getAllGroups()
      const affectedGroups = []

      for (const group of allGroups) {
        const memberIds = await accountGroupService.getGroupMembers(group.id)
        if (memberIds.includes(accountId)) {
          affectedGroups.push(group.id)
        }
      }

      return affectedGroups
    } catch (error) {
      logger.error('❌ Failed to find groups with account:', error)
      return []
    }
  }

  // 🤔 判断是否应该尝试恢复
  async shouldAttemptRecovery(accountId) {
    try {
      const client = redis.getClientSafe()
      const attemptKey = `${this.RECOVERY_ATTEMPT_PREFIX}${accountId}`
      const attemptData = await client.hgetall(attemptKey)

      const attempts = parseInt(attemptData.attempts) || 0

      // 如果已达到最大尝试次数，不再尝试
      if (attempts >= this.MAX_RECOVERY_ATTEMPTS) {
        return false
      }

      // 检查是否有活跃的后备会话（说明有用户受影响）
      const hasActiveFallbackSessions = await this.hasActiveFallbackSessions(accountId)

      return hasActiveFallbackSessions
    } catch (error) {
      logger.error('❌ Failed to check if should attempt recovery:', error)
      return false
    }
  }

  // 📊 检查是否有活跃的后备会话
  async hasActiveFallbackSessions(accountId) {
    try {
      const client = redis.getClientSafe()

      // 查找该账户所在的分组
      const affectedGroups = await this.findGroupsWithAccount(accountId)

      if (affectedGroups.length === 0) {
        return false
      }

      // 检查是否有会话因为这些分组的问题而使用后备账户
      const sessionKeys = await client.keys('smart_session_mapping:*')

      for (const sessionKey of sessionKeys) {
        const sessionData = await client.get(sessionKey)

        if (sessionData) {
          try {
            const mapping = JSON.parse(sessionData)

            if (mapping.source === 'fallback' && affectedGroups.includes(mapping.originalGroupId)) {
              return true
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }

      return false
    } catch (error) {
      logger.error('❌ Failed to check active fallback sessions:', error)
      return false
    }
  }

  // 🧹 清理过期的恢复数据
  async cleanupExpiredRecoveryData() {
    try {
      const client = redis.getClientSafe()

      // 清理过期的恢复尝试记录
      const attemptKeys = await client.keys(`${this.RECOVERY_ATTEMPT_PREFIX}*`)
      let cleanedAttempts = 0

      for (const key of attemptKeys) {
        const ttl = await client.ttl(key)
        if (ttl === -2) {
          // 已过期但未删除
          await client.del(key)
          cleanedAttempts++
        }
      }

      // 清理过期的迁移记录
      const migrationKeys = await client.keys(`${this.SESSION_MIGRATION_PREFIX}*`)
      let cleanedMigrations = 0

      for (const key of migrationKeys) {
        const ttl = await client.ttl(key)
        if (ttl === -2) {
          await client.del(key)
          cleanedMigrations++
        }
      }

      if (cleanedAttempts > 0 || cleanedMigrations > 0) {
        logger.info(
          `🧹 Cleaned up ${cleanedAttempts} expired recovery attempts and ${cleanedMigrations} migration records`
        )
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup expired recovery data:', error)
    }
  }

  // 📊 获取恢复管理器状态
  async getRecoveryStatus() {
    try {
      const client = redis.getClientSafe()

      // 统计各类数据
      const healthKeys = await client.keys('account_health:*')
      const attemptKeys = await client.keys(`${this.RECOVERY_ATTEMPT_PREFIX}*`)
      const migrationKeys = await client.keys(`${this.SESSION_MIGRATION_PREFIX}*`)
      const sessionKeys = await client.keys('smart_session_mapping:*')

      let quarantinedCount = 0
      let fallbackSessionCount = 0

      // 统计隔离账户
      for (const healthKey of healthKeys) {
        const healthData = await client.hgetall(healthKey)
        if (healthData.quarantined === 'true') {
          quarantinedCount++
        }
      }

      // 统计后备会话
      for (const sessionKey of sessionKeys) {
        const sessionData = await client.get(sessionKey)
        if (sessionData) {
          try {
            const mapping = JSON.parse(sessionData)
            if (mapping.source === 'fallback') {
              fallbackSessionCount++
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }

      // 获取健康统计
      const healthStats = await accountHealthService.getHealthStats()

      return {
        isRunning: this.isRunning,
        quarantinedAccounts: quarantinedCount,
        activeRecoveryAttempts: attemptKeys.length,
        pendingMigrations: migrationKeys.length,
        fallbackSessions: fallbackSessionCount,
        totalSessions: sessionKeys.length,
        healthStats,
        lastCheck: new Date().toISOString()
      }
    } catch (error) {
      logger.error('❌ Failed to get recovery status:', error)
      return {
        isRunning: this.isRunning,
        error: error.message
      }
    }
  }

  // 🔧 手动触发账户恢复
  async manualRecovery(accountId, accountType) {
    try {
      logger.info(`🔧 Manual recovery triggered for account ${accountId}`)

      // 重置恢复尝试计数
      const client = redis.getClientSafe()
      const attemptKey = `${this.RECOVERY_ATTEMPT_PREFIX}${accountId}`
      await client.del(attemptKey)

      // 尝试恢复
      const result = await this.attemptAccountRecovery(accountId, accountType)

      return {
        success: result,
        message: result ? 'Account recovered successfully' : 'Recovery attempt failed'
      }
    } catch (error) {
      logger.error('❌ Manual recovery failed:', error)
      return {
        success: false,
        message: error.message
      }
    }
  }

  // 🎯 手动迁移会话
  async manualSessionMigration(sessionHash) {
    try {
      logger.info(`🎯 Manual session migration triggered for ${sessionHash}`)

      const result = await smartGroupScheduler.attemptGroupRecovery(sessionHash)

      return {
        success: result,
        message: result ? 'Session migrated successfully' : 'Migration attempt failed'
      }
    } catch (error) {
      logger.error('❌ Manual session migration failed:', error)
      return {
        success: false,
        message: error.message
      }
    }
  }
}

module.exports = new AccountRecoveryManager()
