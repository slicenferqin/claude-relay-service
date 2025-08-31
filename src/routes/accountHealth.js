const express = require('express')
const router = express.Router()
const accountHealthService = require('../services/accountHealthService')
const accountRecoveryManager = require('../services/accountRecoveryManager')
const smartGroupScheduler = require('../services/smartGroupScheduler')
const { authenticateAdmin } = require('../middleware/auth')
const logger = require('../utils/logger')

// 🏥 获取账号健康统计
router.get('/health/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await accountHealthService.getHealthStats()
    return res.json({ success: true, data: stats })
  } catch (error) {
    logger.error('❌ Failed to get health stats:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🔍 获取特定账号健康状态
router.get('/health/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const healthStatus = await accountHealthService.getAccountHealthStatus(accountId)
    return res.json({ success: true, data: healthStatus })
  } catch (error) {
    logger.error('❌ Failed to get account health status:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🧪 手动检查账号健康状态
router.post('/health/:accountId/check', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const { accountType } = req.body
    
    if (!accountType) {
      return res.status(400).json({ error: 'Account type is required' })
    }
    
    const result = await accountHealthService.checkAccountManually(accountId, accountType)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to manually check account health:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🔄 获取恢复管理器状态
router.get('/recovery/status', authenticateAdmin, async (req, res) => {
  try {
    const status = await accountRecoveryManager.getRecoveryStatus()
    return res.json({ success: true, data: status })
  } catch (error) {
    logger.error('❌ Failed to get recovery status:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🚀 启动恢复管理器
router.post('/recovery/start', authenticateAdmin, async (req, res) => {
  try {
    await accountRecoveryManager.start()
    return res.json({ success: true, message: 'Recovery manager started successfully' })
  } catch (error) {
    logger.error('❌ Failed to start recovery manager:', error)
    return res.status(500).json({ error: error.message })
  }
})

// ⏹️ 停止恢复管理器
router.post('/recovery/stop', authenticateAdmin, async (req, res) => {
  try {
    accountRecoveryManager.stop()
    return res.json({ success: true, message: 'Recovery manager stopped successfully' })
  } catch (error) {
    logger.error('❌ Failed to stop recovery manager:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🔧 手动恢复账号
router.post('/recovery/:accountId/manual', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const { accountType } = req.body
    
    if (!accountType) {
      return res.status(400).json({ error: 'Account type is required' })
    }
    
    const result = await accountRecoveryManager.manualRecovery(accountId, accountType)
    return res.json({ success: result.success, data: result })
  } catch (error) {
    logger.error('❌ Manual recovery failed:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🎯 手动迁移会话
router.post('/sessions/:sessionHash/migrate', authenticateAdmin, async (req, res) => {
  try {
    const { sessionHash } = req.params
    const result = await accountRecoveryManager.manualSessionMigration(sessionHash)
    return res.json({ success: result.success, data: result })
  } catch (error) {
    logger.error('❌ Manual session migration failed:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 👥 获取分组调度统计
router.get('/groups/:groupId/stats', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.params
    const stats = await smartGroupScheduler.getGroupSchedulingStats(groupId)
    return res.json({ success: true, data: stats })
  } catch (error) {
    logger.error('❌ Failed to get group scheduling stats:', error)
    return res.status(500).json({ error: error.message })
  }
})

// ⚙️ 设置后备账号
router.post('/fallback/:platform', authenticateAdmin, async (req, res) => {
  try {
    const { platform } = req.params
    const { accountId } = req.body
    
    if (!accountId) {
      return res.status(400).json({ error: 'Account ID is required' })
    }
    
    // 验证平台类型
    if (!['claude', 'gemini', 'openai'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Must be claude, gemini, or openai' })
    }
    
    await smartGroupScheduler.setFallbackAccount(platform, accountId)
    return res.json({ success: true, message: `Fallback account set for ${platform}` })
  } catch (error) {
    logger.error('❌ Failed to set fallback account:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 📊 获取系统整体健康状态
router.get('/system/health', authenticateAdmin, async (req, res) => {
  try {
    const [healthStats, recoveryStatus] = await Promise.all([
      accountHealthService.getHealthStats(),
      accountRecoveryManager.getRecoveryStatus()
    ])
    
    const systemHealth = {
      overall: {
        healthy: healthStats.healthy,
        total: healthStats.total,
        healthPercentage: healthStats.total > 0 ? Math.round((healthStats.healthy / healthStats.total) * 100) : 100
      },
      accounts: healthStats,
      recovery: recoveryStatus,
      timestamp: new Date().toISOString()
    }
    
    return res.json({ success: true, data: systemHealth })
  } catch (error) {
    logger.error('❌ Failed to get system health:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🔄 触发完整健康检查
router.post('/health/check-all', authenticateAdmin, async (req, res) => {
  try {
    // 异步执行健康检查，不阻塞响应
    accountHealthService.performHealthCheck().catch(error => {
      logger.error('❌ Background health check failed:', error)
    })
    
    return res.json({ 
      success: true, 
      message: 'Full health check started in background' 
    })
  } catch (error) {
    logger.error('❌ Failed to start health check:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🔄 触发恢复检查
router.post('/recovery/check', authenticateAdmin, async (req, res) => {
  try {
    // 异步执行恢复检查
    accountRecoveryManager.performRecoveryCheck().catch(error => {
      logger.error('❌ Background recovery check failed:', error)
    })
    
    return res.json({ 
      success: true, 
      message: 'Recovery check started in background' 
    })
  } catch (error) {
    logger.error('❌ Failed to start recovery check:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 📋 获取账号健康历史
router.get('/health/:accountId/history', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const { limit = 50 } = req.query
    
    const redis = require('../models/redis')
    const client = redis.getClientSafe()
    const historyKey = `account_health_history:${accountId}`
    
    const history = await client.lrange(historyKey, 0, parseInt(limit) - 1)
    const parsedHistory = history.map(record => {
      try {
        return JSON.parse(record)
      } catch (e) {
        return null
      }
    }).filter(Boolean)
    
    return res.json({ success: true, data: parsedHistory })
  } catch (error) {
    logger.error('❌ Failed to get account health history:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🗑️ 清除账号的所有会话映射
router.delete('/sessions/account/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const { accountType } = req.body
    
    if (!accountType) {
      return res.status(400).json({ error: 'Account type is required' })
    }
    
    await accountHealthService.clearAccountSessionMappings(accountId, accountType)
    return res.json({ success: true, message: 'Session mappings cleared' })
  } catch (error) {
    logger.error('❌ Failed to clear session mappings:', error)
    return res.status(500).json({ error: error.message })
  }
})

module.exports = router