const logger = require('./logger')
const config = require('../../config/config')

/**
 * 账户健康度管理器
 * 用于跟踪账户的健康状态，记录失败信息，并提供恢复机制
 */
class AccountHealthManager {
  constructor() {
    // 临时故障账户记录（内存中）
    this.failedAccounts = new Map()

    // 故障恢复时间（默认5分钟）
    this.RECOVERY_TIME = config.failover?.accountRecoveryTime || 5 * 60 * 1000

    // 定期清理过期的故障记录
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredFailures()
    }, 60 * 1000) // 每分钟清理一次
  }

  /**
   * 标记账户为失败状态
   * @param {string} accountId - 账户ID
   * @param {Error|Object} error - 错误信息
   * @param {number} statusCode - HTTP状态码（可选）
   */
  markFailed(accountId, error, statusCode = null) {
    const failureInfo = {
      timestamp: Date.now(),
      error: error.message || error.toString(),
      statusCode,
      retryAfter: Date.now() + this.RECOVERY_TIME,
      failureCount: 1
    }

    // 如果已经存在失败记录，增加失败次数
    const existingFailure = this.failedAccounts.get(accountId)
    if (existingFailure) {
      failureInfo.failureCount = existingFailure.failureCount + 1
      // 根据失败次数调整恢复时间（指数退避）
      const backoffMultiplier = Math.min(failureInfo.failureCount, 5) // 最多5倍
      failureInfo.retryAfter = Date.now() + this.RECOVERY_TIME * backoffMultiplier
    }

    this.failedAccounts.set(accountId, failureInfo)

    logger.warn(`⚠️ [ACCOUNT_HEALTH] Account ${accountId} marked as failed`, {
      accountId,
      error: failureInfo.error,
      statusCode,
      failureCount: failureInfo.failureCount,
      retryAfter: new Date(failureInfo.retryAfter).toISOString()
    })
  }

  /**
   * 检查账户是否健康
   * @param {string} accountId - 账户ID
   * @returns {boolean} - 是否健康
   */
  isHealthy(accountId) {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) {
      return true
    }

    // 检查是否已过恢复时间
    if (Date.now() > failure.retryAfter) {
      this.failedAccounts.delete(accountId)
      logger.info(`✅ [ACCOUNT_HEALTH] Account ${accountId} recovered from failure`, {
        accountId,
        wasFailedFor: Date.now() - failure.timestamp
      })
      return true
    }

    return false
  }

  /**
   * 获取账户健康分数（0-100）
   * @param {string} accountId - 账户ID
   * @returns {number} - 健康分数
   */
  getHealthScore(accountId) {
    if (!this.isHealthy(accountId)) {
      return 0
    }

    const failure = this.failedAccounts.get(accountId)
    if (!failure) {
      return 100
    }

    // 根据失败次数计算健康分数
    const score = Math.max(0, 100 - failure.failureCount * 10)
    return score
  }

  /**
   * 标记账户成功（用于重置失败状态）
   * @param {string} accountId - 账户ID
   */
  markSuccess(accountId) {
    if (this.failedAccounts.has(accountId)) {
      this.failedAccounts.delete(accountId)
      logger.info(
        `✅ [ACCOUNT_HEALTH] Account ${accountId} marked as successful, failure record cleared`,
        {
          accountId
        }
      )
    }
  }

  /**
   * 获取账户失败信息
   * @param {string} accountId - 账户ID
   * @returns {Object|null} - 失败信息或null
   */
  getFailureInfo(accountId) {
    return this.failedAccounts.get(accountId) || null
  }

  /**
   * 获取所有失败的账户
   * @returns {Array} - 失败账户列表
   */
  getFailedAccounts() {
    const result = []
    for (const [accountId, failureInfo] of this.failedAccounts.entries()) {
      result.push({
        accountId,
        ...failureInfo,
        isRecoverable: Date.now() > failureInfo.retryAfter
      })
    }
    return result
  }

  /**
   * 清理过期的故障记录
   */
  cleanupExpiredFailures() {
    const now = Date.now()
    let cleanedCount = 0

    for (const [accountId, failureInfo] of this.failedAccounts.entries()) {
      // 清理超过恢复时间很久的记录（避免内存泄漏）
      const maxRetentionTime = failureInfo.retryAfter + this.RECOVERY_TIME * 2
      if (now > maxRetentionTime) {
        this.failedAccounts.delete(accountId)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`🧹 [ACCOUNT_HEALTH] Cleaned up ${cleanedCount} expired failure records`)
    }
  }

  /**
   * 重置所有账户健康状态
   */
  resetAllHealth() {
    const count = this.failedAccounts.size
    this.failedAccounts.clear()
    logger.info(`🔄 [ACCOUNT_HEALTH] Reset health status for ${count} accounts`)
  }

  /**
   * 获取健康统计信息
   * @returns {Object} - 统计信息
   */
  getHealthStats() {
    const totalFailed = this.failedAccounts.size
    let recoverable = 0
    let permanent = 0
    const now = Date.now()

    for (const failureInfo of this.failedAccounts.values()) {
      if (now > failureInfo.retryAfter) {
        recoverable++
      } else {
        permanent++
      }
    }

    return {
      totalFailed,
      recoverable,
      permanent,
      healthy: 'unknown' // 这需要外部提供总账户数
    }
  }

  /**
   * 销毁健康管理器（清理定时器）
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

// 创建全局单例
const accountHealthManager = new AccountHealthManager()

module.exports = accountHealthManager
