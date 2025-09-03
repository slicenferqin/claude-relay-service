const logger = require('../utils/logger')

/**
 * 请求重试服务
 * 负责处理请求失败后的重试逻辑、账户切换和故障转移
 */
class RequestRetryService {
  constructor() {
    this.MAX_RETRY_ATTEMPTS = 3
    this.BASE_DELAY_MS = 100 // 基础延迟100ms
    this.RETRY_DELAY_MULTIPLIER = 2 // 指数退避倍数
    this.MAX_DELAY_MS = 2000 // 最大延迟2秒

    // 性能优化：缓存错误分析结果
    this.errorAnalysisCache = new Map()
    this.cacheMaxSize = 1000
    this.cacheCleanupInterval = 5 * 60 * 1000 // 5分钟清理一次

    // 定期清理缓存
    setInterval(() => {
      if (this.errorAnalysisCache.size > this.cacheMaxSize) {
        const keysToDelete = Array.from(this.errorAnalysisCache.keys()).slice(0, 100)
        keysToDelete.forEach((key) => this.errorAnalysisCache.delete(key))
        logger.debug(`🧹 Cleaned up ${keysToDelete.length} error analysis cache entries`)
      }
    }, this.cacheCleanupInterval)
  }

  /**
   * 判断是否需要重试的错误类型
   * @param {Error|Object} error - 错误对象
   * @param {number} statusCode - HTTP状态码
   * @returns {boolean} 是否需要重试
   */
  shouldRetry(error, statusCode) {
    // HTTP状态码判断
    if (statusCode) {
      // 需要重试的状态码
      const retryableStatusCodes = [
        429, // 限流
        500, // 服务器内部错误
        502, // 网关错误
        503, // 服务不可用
        504, // 网关超时
        401 // 未授权 (token过期)
      ]

      if (retryableStatusCodes.includes(statusCode)) {
        logger.info(`🔄 Status code ${statusCode} is retryable`)
        return true
      }
    }

    // 网络错误判断
    if (error && error.code) {
      const retryableErrors = [
        'ECONNRESET', // 连接重置
        'ENOTFOUND', // 域名解析失败
        'ECONNREFUSED', // 连接被拒绝
        'ETIMEDOUT', // 连接超时
        'ECONNABORTED', // 连接中断
        'EHOSTUNREACH', // 主机不可达
        'ENETUNREACH' // 网络不可达
      ]

      if (retryableErrors.includes(error.code)) {
        logger.info(`🔄 Network error ${error.code} is retryable`)
        return true
      }
    }

    // 特定错误消息判断
    if (error && error.message) {
      const retryableMessages = [
        'timeout',
        'network error',
        'connection reset',
        'socket hang up',
        'request timeout'
      ]

      const errorMessage = error.message.toLowerCase()
      for (const msg of retryableMessages) {
        if (errorMessage.includes(msg)) {
          logger.info(`🔄 Error message containing '${msg}' is retryable`)
          return true
        }
      }
    }

    // Claude特定错误判断
    if (error && error.type) {
      const retryableTypes = [
        'overloaded_error', // Claude服务过载
        'rate_limit_error', // 官方限流
        'api_error' // API错误（某些情况下可重试）
      ]

      if (retryableTypes.includes(error.type)) {
        logger.info(`🔄 Claude error type '${error.type}' is retryable`)
        return true
      }
    }

    logger.debug(
      `❌ Error is not retryable: ${error?.message || 'unknown error'}, status: ${statusCode}`
    )
    return false
  }

  /**
   * 提取错误信息用于分析
   * @param {Error|Object} error - 错误对象
   * @param {number} statusCode - HTTP状态码
   * @returns {Object} 错误分析结果
   */
  analyzeError(error, statusCode) {
    // 性能优化：缓存错误分析结果
    const cacheKey = `${statusCode || 'null'}_${error?.code || 'null'}_${error?.message?.slice(0, 50) || 'null'}`
    if (this.errorAnalysisCache.has(cacheKey)) {
      return this.errorAnalysisCache.get(cacheKey)
    }
    const analysis = {
      isRetryable: this.shouldRetry(error, statusCode),
      errorType: 'unknown',
      errorCode: null,
      errorMessage: null,
      shouldSwitchAccount: false,
      shouldMarkAccountUnavailable: false
    }

    // 状态码分析
    if (statusCode) {
      analysis.errorCode = statusCode

      switch (statusCode) {
        case 429:
          analysis.errorType = 'rate_limit'
          analysis.shouldSwitchAccount = true
          analysis.shouldMarkAccountUnavailable = true
          break
        case 401:
          analysis.errorType = 'unauthorized'
          analysis.shouldSwitchAccount = true
          analysis.shouldMarkAccountUnavailable = true
          break
        case 500:
        case 502:
        case 503:
        case 504:
          analysis.errorType = 'server_error'
          analysis.shouldSwitchAccount = true
          break
        default:
          analysis.errorType = 'http_error'
      }
    }

    // 网络错误分析
    if (error && error.code) {
      analysis.errorCode = error.code
      analysis.errorType = 'network_error'
      analysis.shouldSwitchAccount = true
    }

    // 提取错误消息
    if (error) {
      analysis.errorMessage = error.message || error.error?.message || 'Unknown error'
    }

    // 缓存分析结果（只缓存稳定的错误类型）
    if (statusCode || (error && error.code)) {
      this.errorAnalysisCache.set(cacheKey, analysis)
    }

    return analysis
  }

  /**
   * 计算重试延迟时间（指数退避）
   * @param {number} attemptNumber - 重试次数（从1开始）
   * @returns {number} 延迟时间（毫秒）
   */
  calculateRetryDelay(attemptNumber) {
    const delay = this.BASE_DELAY_MS * Math.pow(this.RETRY_DELAY_MULTIPLIER, attemptNumber - 1)
    return Math.min(delay, this.MAX_DELAY_MS)
  }

  /**
   * 异步等待指定时间
   * @param {number} milliseconds - 等待时间（毫秒）
   * @returns {Promise}
   */
  async delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  /**
   * 创建重试上下文对象
   * @param {Object} originalRequest - 原始请求信息
   * @param {Object} apiKeyData - API Key数据
   * @param {string} sessionHash - 会话哈希
   * @returns {Object} 重试上下文
   */
  createRetryContext(originalRequest, apiKeyData, sessionHash = null) {
    return {
      // 原始请求信息（优化：只保存必要字段，减少内存占用）
      originalRequest: {
        model: originalRequest.body?.model,
        isStream: originalRequest.body?.stream === true,
        messageCount: originalRequest.body?.messages?.length || 0 // 只记录消息数量而不是完整内容
      },

      // 请求元数据（优化：只保存必要字段）
      apiKeyInfo: {
        id: apiKeyData.id,
        name: apiKeyData.name
      },
      sessionHash,

      // 重试状态
      attemptNumber: 0,
      maxAttempts: this.MAX_RETRY_ATTEMPTS,
      excludedAccounts: [], // 已经尝试失败的账户ID列表
      lastError: null,
      startTime: Date.now(),

      // 账户选择历史
      accountHistory: [],

      // 是否已使用后备账户
      usedFallback: false
    }
  }

  /**
   * 更新重试上下文
   * @param {Object} context - 重试上下文
   * @param {string} accountId - 使用的账户ID
   * @param {string} accountType - 账户类型
   * @param {Object} error - 错误信息
   */
  updateRetryContext(context, accountId, accountType, error = null) {
    context.attemptNumber++
    context.lastError = error

    // 记录账户使用历史
    context.accountHistory.push({
      accountId,
      accountType,
      attemptNumber: context.attemptNumber,
      timestamp: Date.now(),
      success: !error
    })

    // 如果失败，将账户添加到排除列表
    if (error && accountId && !context.excludedAccounts.includes(accountId)) {
      context.excludedAccounts.push(accountId)
      logger.info(
        `➕ Added account ${accountId} to excluded list (total: ${context.excludedAccounts.length})`
      )
    }
  }

  /**
   * 检查是否还有重试机会
   * @param {Object} context - 重试上下文
   * @returns {boolean} 是否可以继续重试
   */
  canRetry(context) {
    return context.attemptNumber < context.maxAttempts
  }

  /**
   * 获取重试统计信息
   * @param {Object} context - 重试上下文
   * @returns {Object} 统计信息
   */
  getRetryStats(context) {
    const totalTime = Date.now() - context.startTime
    const successfulAttempt = context.accountHistory.find((h) => h.success)

    return {
      totalAttempts: context.attemptNumber,
      excludedAccounts: context.excludedAccounts.length,
      totalTime,
      success: !!successfulAttempt,
      finalAccount: successfulAttempt?.accountId || null,
      usedFallback: context.usedFallback,
      accountSwitches: context.accountHistory.length - 1 // 减1因为第一次不算切换
    }
  }

  /**
   * 记录重试完成的统计日志
   * @param {Object} context - 重试上下文
   * @param {boolean} finalSuccess - 最终是否成功
   */
  logRetryCompletion(context, finalSuccess) {
    const stats = this.getRetryStats(context)

    if (finalSuccess) {
      logger.success(
        `✅ Request retry completed successfully: ${stats.totalAttempts} attempts, ` +
          `${stats.accountSwitches} switches, ${stats.totalTime}ms total, ` +
          `final account: ${stats.finalAccount}`
      )
    } else {
      logger.error(
        `❌ Request retry failed after ${stats.totalAttempts} attempts, ` +
          `${stats.accountSwitches} switches, ${stats.totalTime}ms total, ` +
          `excluded ${stats.excludedAccounts} accounts`
      )
    }

    // 记录账户使用历史
    if (context.accountHistory.length > 1) {
      logger.info('📋 Account usage history:')
      context.accountHistory.forEach((entry, index) => {
        const status = entry.success ? '✅' : '❌'
        logger.info(`   ${index + 1}. ${status} ${entry.accountId} (${entry.accountType})`)
      })
    }
  }

  /**
   * 判断错误是否表示账户应该被临时标记为不可用
   * @param {Object} errorAnalysis - 错误分析结果
   * @returns {boolean} 是否应该标记账户不可用
   */
  shouldMarkAccountTemporarilyUnavailable(errorAnalysis) {
    return errorAnalysis.shouldMarkAccountUnavailable
  }

  /**
   * 获取账户不可用的持续时间（秒）
   * @param {Object} errorAnalysis - 错误分析结果
   * @returns {number} 不可用持续时间（秒）
   */
  getAccountUnavailableDuration(errorAnalysis) {
    switch (errorAnalysis.errorType) {
      case 'rate_limit':
        return 300 // 限流：5分钟
      case 'unauthorized':
        return 600 // 未授权：10分钟
      case 'server_error':
        return 60 // 服务器错误：1分钟
      case 'network_error':
        return 30 // 网络错误：30秒
      default:
        return 60 // 默认：1分钟
    }
  }
}

module.exports = new RequestRetryService()
