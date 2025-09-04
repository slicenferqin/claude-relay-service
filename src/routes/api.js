const express = require('express')
const claudeRelayService = require('../services/claudeRelayService')
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService')
// const bedrockRelayService = require('../services/bedrockRelayService')  // 未使用，注释掉
// const bedrockAccountService = require('../services/bedrockAccountService')  // 未使用，注释掉
const unifiedClaudeScheduler = require('../services/unifiedClaudeScheduler')
const apiKeyService = require('../services/apiKeyService')
const pricingService = require('../services/pricingService')
const { authenticateApiKey } = require('../middleware/auth')
const logger = require('../utils/logger')
const redis = require('../models/redis')
const sessionHelper = require('../utils/sessionHelper')

const router = express.Router()

// 🔧 共享的消息处理函数
// 完整的 handleMessagesRequest 函数
async function handleMessagesRequest(req, res) {
  try {
    const startTime = Date.now()

    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      })
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      })
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      })
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true

    logger.api(
      `🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`
    )

    if (isStream) {
      // 流式响应处理
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('X-Accel-Buffering', 'no')

      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true)
      }

      let usageDataCaptured = false

      // 选择账户
      const sessionHash = sessionHelper.generateSessionHash(req.body)
      const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        req.body.model
      )

      if (!accountSelection || !accountSelection.accountId) {
        return res.status(503).json({
          error: {
            type: 'service_unavailable',
            message: 'No Claude accounts are currently available'
          }
        })
      }

      const { accountType } = accountSelection
      logger.info(`🎯 Selected account type: ${accountType} for streaming request`)

      // 使用现有的流式处理方法
      await claudeRelayService.relayStreamRequestWithRetry(
        req.body,
        req.apiKey,
        res,
        req.headers,
        (usageData) => {
          if (
            usageData &&
            usageData.input_tokens !== undefined &&
            usageData.output_tokens !== undefined
          ) {
            const inputTokens = usageData.input_tokens || 0
            const outputTokens = usageData.output_tokens || 0
            let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
            let ephemeral5mTokens = 0
            let ephemeral1hTokens = 0

            if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
              ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
              ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
              cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
            }

            const cacheReadTokens = usageData.cache_read_input_tokens || 0
            const model = usageData.model || 'unknown'
            const { accountId: usageAccountId } = usageData

            apiKeyService.recordUsage(
              req.apiKey.id,
              inputTokens,
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens,
              model,
              usageAccountId
            )

            if (req.rateLimitInfo) {
              const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
              redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens)

              if (req.rateLimitInfo.costCountKey) {
                const usageObject = {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  cache_creation_input_tokens: cacheCreateTokens,
                  cache_read_input_tokens: cacheReadTokens
                }
                const costInfo = pricingService.calculateCost(usageObject, model)
                if (costInfo.totalCost > 0) {
                  redis.getClient().incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
                }
              }
            }

            usageDataCaptured = true
            logger.api(
              `📊 Stream usage recorded - Model: ${model}, Tokens: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens}`
            )
          }
        }
      )

      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn('⚠️ No usage data captured from stream')
        }
      }, 1000)
    } else {
      // 非流式响应处理
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      })

      // 选择账户
      const sessionHash = sessionHelper.generateSessionHash(req.body)
      const accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        req.body.model
      )

      if (!accountSelection || !accountSelection.accountId) {
        return res.status(503).json({
          error: {
            type: 'service_unavailable',
            message: 'No Claude accounts are currently available'
          }
        })
      }

      const { accountType } = accountSelection
      logger.info(`🎯 Selected account type: ${accountType} for non-streaming request`)

      let response
      // 使用故障转移方法处理非流式请求
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
      } else {
        throw new Error(`Unsupported account type: ${accountType}`)
      }

      res.status(response.statusCode)

      // 设置响应头
      const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
      Object.keys(response.headers).forEach((key) => {
        if (!skipHeaders.includes(key.toLowerCase())) {
          res.setHeader(key, response.headers[key])
        }
      })

      let usageRecorded = false

      // 解析并处理响应
      try {
        const jsonData = JSON.parse(response.body)

        if (
          jsonData.usage &&
          jsonData.usage.input_tokens !== undefined &&
          jsonData.usage.output_tokens !== undefined
        ) {
          const inputTokens = jsonData.usage.input_tokens || 0
          const outputTokens = jsonData.usage.output_tokens || 0
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0
          const model = jsonData.model || req.body.model || 'unknown'

          const { accountId: responseAccountId } = response
          await apiKeyService.recordUsage(
            req.apiKey.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            responseAccountId
          )

          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
            await redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens)

            if (req.rateLimitInfo.costCountKey) {
              const costInfo = pricingService.calculateCost(jsonData.usage, model)
              if (costInfo.totalCost > 0) {
                await redis
                  .getClient()
                  .incrbyfloat(req.rateLimitInfo.costCountKey, costInfo.totalCost)
              }
            }
          }

          usageRecorded = true
          const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
          logger.api(`📊 Non-stream usage recorded - Model: ${model}, Tokens: ${totalTokens}`)
        }

        res.json(jsonData)
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse response as JSON:', parseError.message)
        res.send(response.body)
      }

      if (!usageRecorded) {
        logger.warn('⚠️ No usage data recorded for non-stream request')
      }
    }

    const duration = Date.now() - startTime
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`)
    return undefined
  } catch (error) {
    logger.error('❌ Claude relay error:', error.message, {
      code: error.code,
      stack: error.stack
    })

    if (!res.headersSent) {
      let statusCode = 500
      let errorType = 'Relay service error'

      if (error.message.includes('Connection reset') || error.message.includes('socket hang up')) {
        statusCode = 502
        errorType = 'Upstream connection error'
      } else if (error.message.includes('Connection refused')) {
        statusCode = 502
        errorType = 'Upstream service unavailable'
      } else if (error.message.includes('timeout')) {
        statusCode = 504
        errorType = 'Upstream timeout'
      } else if (error.message.includes('resolve') || error.message.includes('ENOTFOUND')) {
        statusCode = 502
        errorType = 'Upstream hostname resolution failed'
      }

      return res.status(statusCode).json({
        error: errorType,
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      })
    } else {
      if (!res.destroyed && !res.finished) {
        res.end()
      }
      return undefined
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest)

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest)

// 📋 模型列表端点 - Claude Code 客户端需要
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    // 返回支持的模型列表
    const models = [
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      }
    ]

    res.json({
      object: 'list',
      data: models
    })
  } catch (error) {
    logger.error('❌ Models list error:', error)
    res.status(500).json({
      error: 'Failed to get models list',
      message: error.message
    })
  }
})

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck()

    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    })
  } catch (error) {
    logger.error('❌ Health check error:', error)
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Key info error:', error)
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    })
  }
})

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Usage stats error:', error)
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    })
  }
})

// 👤 用户信息端点 - Claude Code 客户端需要
router.get('/v1/me', authenticateApiKey, async (req, res) => {
  try {
    // 返回基础用户信息
    res.json({
      id: `user_${req.apiKey.id}`,
      type: 'user',
      display_name: req.apiKey.name || 'API User',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ User info error:', error)
    res.status(500).json({
      error: 'Failed to get user info',
      message: error.message
    })
  }
})

// 💰 余额/限制端点 - Claude Code 客户端需要
router.get('/v1/organizations/:org_id/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      object: 'usage',
      data: [
        {
          type: 'credit_balance',
          credit_balance: req.apiKey.tokenLimit - (usage.totalTokens || 0)
        }
      ]
    })
  } catch (error) {
    logger.error('❌ Organization usage error:', error)
    res.status(500).json({
      error: 'Failed to get usage info',
      message: error.message
    })
  }
})

// 🔢 Token计数端点 - count_tokens beta API
router.post('/v1/messages/count_tokens', authenticateApiKey, async (req, res) => {
  try {
    // 检查权限
    if (
      req.apiKey.permissions &&
      req.apiKey.permissions !== 'all' &&
      req.apiKey.permissions !== 'claude'
    ) {
      return res.status(403).json({
        error: {
          type: 'permission_error',
          message: 'This API key does not have permission to access Claude'
        }
      })
    }

    logger.info(`🔢 Processing token count request for key: ${req.apiKey.name}`)

    // 生成会话哈希用于sticky会话
    const sessionHash = sessionHelper.generateSessionHash(req.body)

    // 选择可用的Claude账户
    const requestedModel = req.body.model
    const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
      req.apiKey,
      sessionHash,
      requestedModel
    )

    let response
    if (accountType === 'claude-official') {
      // 使用官方Claude账号转发count_tokens请求（带故障转移）
      response = await claudeRelayService.relayRequestWithFailover(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else if (accountType === 'claude-console') {
      // 使用Console Claude账号转发count_tokens请求
      response = await claudeConsoleRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        accountId,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else {
      // Bedrock不支持count_tokens
      return res.status(501).json({
        error: {
          type: 'not_supported',
          message: 'Token counting is not supported for Bedrock accounts'
        }
      })
    }

    // 直接返回响应，不记录token使用量
    res.status(response.statusCode)

    // 设置响应头
    const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
    Object.keys(response.headers).forEach((key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, response.headers[key])
      }
    })

    // 尝试解析并返回JSON响应
    try {
      const jsonData = JSON.parse(response.body)
      res.json(jsonData)
    } catch (parseError) {
      res.send(response.body)
    }

    logger.info(`✅ Token count request completed for key: ${req.apiKey.name}`)
  } catch (error) {
    logger.error('❌ Token count error:', error)
    res.status(500).json({
      error: {
        type: 'server_error',
        message: 'Failed to count tokens'
      }
    })
  }
})

module.exports = router
