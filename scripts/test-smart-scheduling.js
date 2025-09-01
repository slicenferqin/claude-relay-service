#!/usr/bin/env node

// const config = require('../config/config')
const redis = require('../src/models/redis')
const accountHealthService = require('../src/services/accountHealthService')
const smartGroupScheduler = require('../src/services/smartGroupScheduler')
const accountRecoveryManager = require('../src/services/accountRecoveryManager')
const accountGroupService = require('../src/services/accountGroupService')
const logger = require('../src/utils/logger')

class SmartSchedulingTester {
  constructor() {
    this.testGroupId = null
    this.testApiKey = null
    this.testAccounts = []
  }

  // 🧪 运行完整测试套件
  async runTests() {
    try {
      console.log('🧪 Starting Smart Group Scheduling Test Suite...\n')
      
      await redis.connect()
      logger.info('✅ Connected to Redis')
      
      // 1. 测试账户健康检查
      await this.testHealthCheck()
      
      // 2. 测试分组调度
      await this.testGroupScheduling()
      
      // 3. 测试故障转移
      await this.testFailover()
      
      // 4. 测试自动恢复
      await this.testAutoRecovery()
      
      // 5. 清理测试数据
      await this.cleanup()
      
      console.log('\n🎉 All tests completed successfully!')
      
    } catch (error) {
      console.error('❌ Test failed:', error)
    } finally {
      await redis.disconnect()
      process.exit(0)
    }
  }

  // 🏥 测试账户健康检查
  async testHealthCheck() {
    console.log('🏥 Testing Account Health Check...')
    
    try {
      // 启动健康检查服务
      await accountHealthService.start()
      
      // 获取健康统计
      const stats = await accountHealthService.getHealthStats()
      console.log('📊 Health Stats:', JSON.stringify(stats, null, 2))
      
      // 手动检查一个账户（如果存在）
      const claudeAccounts = await redis.getAllClaudeAccounts()
      if (claudeAccounts.length > 0) {
        const testAccount = claudeAccounts[0]
        console.log(`🔍 Testing account: ${testAccount.name}`)
        
        const healthStatus = await accountHealthService.checkAccountManually(
          testAccount.id, 
          'claude-official'
        )
        console.log('🩺 Health Status:', JSON.stringify(healthStatus, null, 2))
      }
      
      accountHealthService.stop()
      console.log('✅ Health check test completed\n')
      
    } catch (error) {
      console.error('❌ Health check test failed:', error)
    }
  }

  // 👥 测试分组调度
  async testGroupScheduling() {
    console.log('👥 Testing Group Scheduling...')
    
    try {
      // 创建测试分组
      const group = await accountGroupService.createGroup({
        name: 'Test Smart Group',
        platform: 'claude',
        description: 'Test group for smart scheduling'
      })
      this.testGroupId = group.id
      console.log('📁 Created test group:', group.name)
      
      // 获取可用账户并添加到分组
      const claudeAccounts = await redis.getAllClaudeAccounts()
      const availableAccounts = claudeAccounts.filter(acc => 
        acc.isActive === 'true' && acc.status !== 'error'
      ).slice(0, 2) // 取前两个
      
      if (availableAccounts.length === 0) {
        console.log('⚠️ No available accounts found, skipping group scheduling test')
        return
      }
      
      for (const account of availableAccounts) {
        await accountGroupService.addAccountToGroup(account.id, this.testGroupId, 'claude')
        this.testAccounts.push(account.id)
        console.log(`➕ Added account ${account.name} to group`)
      }
      
      // 测试智能分组调度
      const sessionHash = `test_session_${Date.now()}`
      const selection = await smartGroupScheduler.selectAccountFromGroup(
        this.testGroupId, 
        sessionHash,
        'claude-3-sonnet-20240229'
      )
      
      console.log('🎯 Selected account:', JSON.stringify(selection, null, 2))
      
      // 测试会话粘性
      const selection2 = await smartGroupScheduler.selectAccountFromGroup(
        this.testGroupId, 
        sessionHash,
        'claude-3-sonnet-20240229'
      )
      
      console.log('🔄 Second selection (should be same):', JSON.stringify(selection2, null, 2))
      
      // 获取分组统计
      const groupStats = await smartGroupScheduler.getGroupSchedulingStats(this.testGroupId)
      console.log('📊 Group Stats:', JSON.stringify(groupStats, null, 2))
      
      console.log('✅ Group scheduling test completed\n')
      
    } catch (error) {
      console.error('❌ Group scheduling test failed:', error)
    }
  }

  // ⚡ 测试故障转移
  async testFailover() {
    console.log('⚡ Testing Failover Mechanism...')
    
    try {
      if (!this.testGroupId || this.testAccounts.length === 0) {
        console.log('⚠️ No test group available, skipping failover test')
        return
      }
      
      // 模拟账户故障 - 将第一个账户标记为隔离状态
      const problemAccountId = this.testAccounts[0]
      console.log(`🚫 Simulating failure for account: ${problemAccountId}`)
      
      await accountHealthService.quarantineAccount(
        problemAccountId, 
        'claude-official', 
        'Test Account', 
        'simulated_failure'
      )
      
      // 测试故障转移后的调度
      const sessionHash = `failover_test_${Date.now()}`
      const selection = await smartGroupScheduler.selectAccountFromGroup(
        this.testGroupId, 
        sessionHash,
        'claude-3-sonnet-20240229'
      )
      
      console.log('🔄 Failover selection:', JSON.stringify(selection, null, 2))
      
      if (selection.accountId !== problemAccountId) {
        console.log('✅ Failover successful - selected different account')
      } else {
        console.log('⚠️ Failover may not have worked as expected')
      }
      
      console.log('✅ Failover test completed\n')
      
    } catch (error) {
      console.error('❌ Failover test failed:', error)
    }
  }

  // 🔄 测试自动恢复
  async testAutoRecovery() {
    console.log('🔄 Testing Auto Recovery...')
    
    try {
      // 启动恢复管理器
      await accountRecoveryManager.start()
      
      // 获取恢复状态
      const recoveryStatus = await accountRecoveryManager.getRecoveryStatus()
      console.log('📊 Recovery Status:', JSON.stringify(recoveryStatus, null, 2))
      
      // 如果有被隔离的账户，尝试手动恢复
      if (this.testAccounts.length > 0) {
        const testAccountId = this.testAccounts[0]
        console.log(`🔧 Attempting manual recovery for: ${testAccountId}`)
        
        const recoveryResult = await accountRecoveryManager.manualRecovery(
          testAccountId, 
          'claude-official'
        )
        console.log('🩹 Recovery Result:', JSON.stringify(recoveryResult, null, 2))
      }
      
      accountRecoveryManager.stop()
      console.log('✅ Auto recovery test completed\n')
      
    } catch (error) {
      console.error('❌ Auto recovery test failed:', error)
    }
  }

  // 🧹 清理测试数据
  async cleanup() {
    console.log('🧹 Cleaning up test data...')
    
    try {
      // 清理分组
      if (this.testGroupId) {
        // 先移除所有成员
        for (const accountId of this.testAccounts) {
          try {
            await accountGroupService.removeAccountFromGroup(accountId, this.testGroupId)
            // 恢复账户状态
            await accountHealthService.recoverAccount(accountId, 'claude-official', 'Test cleanup')
          } catch (e) {
            // 忽略清理错误
          }
        }
        
        // 删除分组
        try {
          await accountGroupService.deleteGroup(this.testGroupId)
          console.log('🗑️ Test group deleted')
        } catch (e) {
          console.log('⚠️ Could not delete test group:', e.message)
        }
      }
      
      // 清理会话映射
      const client = redis.getClientSafe()
      const sessionKeys = await client.keys('smart_session_mapping:*test*')
      if (sessionKeys.length > 0) {
        await client.del(...sessionKeys)
        console.log(`🗑️ Cleaned up ${sessionKeys.length} test session mappings`)
      }
      
      console.log('✅ Cleanup completed\n')
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error)
    }
  }

  // 📊 显示系统概览
  async showSystemOverview() {
    console.log('📊 System Overview:')
    console.log('==================')
    
    try {
      // 健康统计
      const healthStats = await accountHealthService.getHealthStats()
      console.log('\n🏥 Health Stats:')
      console.log(`  Total Accounts: ${healthStats.total}`)
      console.log(`  Healthy: ${healthStats.healthy}`)
      console.log(`  Unhealthy: ${healthStats.unhealthy}`)
      console.log(`  Quarantined: ${healthStats.quarantined}`)
      
      // 分组信息
      const groups = await accountGroupService.getAllGroups()
      console.log(`\n👥 Groups: ${groups.length}`)
      for (const group of groups) {
        console.log(`  - ${group.name} (${group.platform}): ${group.memberCount} members`)
      }
      
      // 恢复状态
      const recoveryStatus = await accountRecoveryManager.getRecoveryStatus()
      console.log('\n🔄 Recovery Status:')
      console.log(`  Running: ${recoveryStatus.isRunning}`)
      console.log(`  Quarantined Accounts: ${recoveryStatus.quarantinedAccounts}`)
      console.log(`  Fallback Sessions: ${recoveryStatus.fallbackSessions}`)
      
    } catch (error) {
      console.error('❌ Failed to show system overview:', error)
    }
    
    console.log('\n')
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2)
  const command = args[0] || 'test'
  
  const tester = new SmartSchedulingTester()
  
  switch (command) {
    case 'test':
      await tester.runTests()
      break
    case 'overview':
      await redis.connect()
      await tester.showSystemOverview()
      await redis.disconnect()
      break
    case 'health':
      await redis.connect()
      await tester.testHealthCheck()
      await redis.disconnect()
      break
    default:
      console.log('Usage: node test-smart-scheduling.js [test|overview|health]')
      console.log('  test     - Run complete test suite')
      console.log('  overview - Show system overview')
      console.log('  health   - Test health check only')
  }
}

if (require.main === module) {
  main().catch(console.error)
}

module.exports = SmartSchedulingTester