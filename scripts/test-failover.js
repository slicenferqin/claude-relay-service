#!/usr/bin/env node

/**
 * 账号切流测试脚本
 * 用于测试Claude Relay Service的账号故障转移和智能调度功能
 */

const axios = require('axios')
const redis = require('redis')
const { promisify } = require('util')
const _colors = require('colors')

// 配置
const config = {
  serviceUrl: process.env.SERVICE_URL || 'http://localhost:3000',
  apiKey: process.env.TEST_API_KEY || 'cr_test_key',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: process.env.REDIS_PORT || 6379,
  redisPassword: process.env.REDIS_PASSWORD || ''
}

// Redis客户端
let redisClient

// 测试统计
const stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  accountSwitches: 0,
  fallbackUsed: 0,
  averageResponseTime: 0,
  responseTimes: []
}

// 初始化Redis连接
async function initRedis() {
  redisClient = redis.createClient({
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword || undefined
  })

  redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err)
  })

  const getAsync = promisify(redisClient.get).bind(redisClient)
  const setAsync = promisify(redisClient.set).bind(redisClient)
  const delAsync = promisify(redisClient.del).bind(redisClient)
  const keysAsync = promisify(redisClient.keys).bind(redisClient)

  return { getAsync, setAsync, delAsync, keysAsync }
}

// 创建测试请求
function createTestRequest(scenario = 'normal') {
  const baseRequest = {
    model: 'claude-3-sonnet-20241129',
    messages: [
      {
        role: 'user',
        content: `Test scenario: ${scenario} - ${new Date().toISOString()}`
      }
    ],
    max_tokens: 100,
    stream: false
  }

  // 根据场景调整请求
  switch (scenario) {
    case 'opus':
      baseRequest.model = 'claude-3-opus-20240229'
      break
    case 'long':
      baseRequest.max_tokens = 4000
      break
    case 'stream':
      baseRequest.stream = true
      break
  }

  return baseRequest
}

// 发送测试请求
async function sendRequest(requestBody, headers = {}) {
  const startTime = Date.now()

  try {
    const response = await axios.post(`${config.serviceUrl}/api/v1/messages`, requestBody, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...headers
      },
      timeout: 30000
    })

    const responseTime = Date.now() - startTime
    stats.responseTimes.push(responseTime)
    stats.successfulRequests++

    return {
      success: true,
      responseTime,
      accountId: response.headers['x-account-id'] || 'unknown',
      data: response.data
    }
  } catch (error) {
    const responseTime = Date.now() - startTime
    stats.failedRequests++

    return {
      success: false,
      responseTime,
      error: error.response?.data || error.message,
      status: error.response?.status
    }
  } finally {
    stats.totalRequests++
  }
}

// 模拟账户故障
async function simulateAccountFailure(accountId, failureType = '429') {
  const { setAsync } = await initRedis()

  switch (failureType) {
    case '429':
      // 模拟限流
      await setAsync(`rate_limit:claude-official:${accountId}`, Date.now() + 60000, 'EX', 60)
      console.log(`🔴 Simulated rate limit for account ${accountId}`.red)
      break
    case '401':
      // 模拟认证失败
      await setAsync(`unauthorized:${accountId}`, '3', 'EX', 300)
      console.log(`🔴 Simulated unauthorized for account ${accountId}`.red)
      break
    case 'unhealthy': {
      // 模拟不健康状态
      const healthKey = `account_health:${accountId}`
      await setAsync(
        healthKey,
        JSON.stringify({
          healthy: false,
          lastCheck: new Date().toISOString(),
          error: 'Simulated failure',
          quarantined: true
        }),
        'EX',
        1800
      )
      console.log(`🔴 Simulated unhealthy status for account ${accountId}`.red)
      break
    }
  }
}

// 清除账户故障
async function clearAccountFailure(accountId) {
  const { delAsync } = await initRedis()

  await delAsync(`rate_limit:claude-official:${accountId}`)
  await delAsync(`unauthorized:${accountId}`)
  await delAsync(`account_health:${accountId}`)
  await delAsync(`temp_unavailable:claude-official:${accountId}`)

  console.log(`✅ Cleared all failures for account ${accountId}`.green)
}

// 测试场景1：正常请求
async function testNormalRequests() {
  console.log('\n📋 Testing Scenario 1: Normal Requests'.cyan)
  console.log('='.repeat(50))

  const results = []
  for (let i = 0; i < 5; i++) {
    const result = await sendRequest(createTestRequest('normal'))
    results.push(result)

    if (result.success) {
      console.log(
        `✅ Request ${i + 1}: Success (${result.responseTime}ms) - Account: ${result.accountId}`
          .green
      )
    } else {
      console.log(`❌ Request ${i + 1}: Failed - ${result.error}`.red)
    }
  }

  // 分析结果
  const accountsUsed = new Set(results.filter((r) => r.success).map((r) => r.accountId))
  console.log(`\n📊 Summary: ${accountsUsed.size} different accounts used`)

  return results
}

// 测试场景2：账户限流切换
async function testRateLimitFailover() {
  console.log('\n📋 Testing Scenario 2: Rate Limit Failover'.cyan)
  console.log('='.repeat(50))

  // 获取当前使用的账户
  const initialResult = await sendRequest(createTestRequest('normal'))
  const initialAccount = initialResult.accountId
  console.log(`Initial account: ${initialAccount}`)

  // 模拟该账户限流
  await simulateAccountFailure(initialAccount, '429')

  // 发送新请求，应该切换到其他账户
  const results = []
  for (let i = 0; i < 3; i++) {
    const result = await sendRequest(createTestRequest('normal'))
    results.push(result)

    if (result.success) {
      const switched = result.accountId !== initialAccount
      console.log(
        `✅ Request ${i + 1}: ${switched ? 'SWITCHED' : 'SAME'} - Account: ${result.accountId}`
          .green
      )
      if (switched) {
        stats.accountSwitches++
      }
    } else {
      console.log(`❌ Request ${i + 1}: Failed - ${result.error}`.red)
    }
  }

  // 清理
  await clearAccountFailure(initialAccount)

  return results
}

// 测试场景3：分组全部失败
async function _testGroupFailureWithFallback() {
  console.log('\n📋 Testing Scenario 3: Group Failure with Fallback'.cyan)
  console.log('='.repeat(50))

  // 这个需要预先配置一个测试分组，并将所有成员设为不可用
  console.log('⚠️  This test requires a pre-configured test group with API key binding')

  // 模拟分组内所有账户故障
  // 需要知道分组成员的ID列表
  const groupMembers = ['account1', 'account2', 'account3'] // 需要实际的账户ID

  for (const memberId of groupMembers) {
    await simulateAccountFailure(memberId, 'unhealthy')
  }

  // 发送请求，应该使用后备账户
  const result = await sendRequest(createTestRequest('normal'))

  if (result.success) {
    console.log(`✅ Request succeeded with fallback account: ${result.accountId}`.green)
    stats.fallbackUsed++
  } else {
    console.log(`❌ Request failed even with fallback: ${result.error}`.red)
  }

  // 清理
  for (const memberId of groupMembers) {
    await clearAccountFailure(memberId)
  }

  return result
}

// 测试场景4：并发压力测试
async function testConcurrentRequests() {
  console.log('\n📋 Testing Scenario 4: Concurrent Requests'.cyan)
  console.log('='.repeat(50))

  const concurrency = 20
  const promises = []

  console.log(`Sending ${concurrency} concurrent requests...`)

  for (let i = 0; i < concurrency; i++) {
    promises.push(sendRequest(createTestRequest('normal')))
  }

  const results = await Promise.all(promises)

  // 分析结果
  const successful = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length
  const accountsUsed = new Set(results.filter((r) => r.success).map((r) => r.accountId))
  const avgResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length

  console.log(`\n📊 Concurrent Test Results:`)
  console.log(`   Success Rate: ${((successful / concurrency) * 100).toFixed(1)}%`.green)
  console.log(`   Failed: ${failed}`.red)
  console.log(`   Accounts Used: ${accountsUsed.size}`)
  console.log(`   Avg Response Time: ${avgResponseTime.toFixed(0)}ms`)

  return results
}

// 测试场景5：会话粘性测试
async function testSessionStickiness() {
  console.log('\n📋 Testing Scenario 5: Session Stickiness'.cyan)
  console.log('='.repeat(50))

  const sessionId = `test-session-${Date.now()}`
  const results = []

  // 发送多个带相同session的请求
  for (let i = 0; i < 5; i++) {
    const result = await sendRequest(createTestRequest('normal'), {
      'X-Session-Id': sessionId
    })
    results.push(result)

    if (result.success) {
      console.log(`✅ Request ${i + 1}: Account ${result.accountId}`.green)
    }
  }

  // 检查是否使用了相同账户
  const accountsUsed = new Set(results.filter((r) => r.success).map((r) => r.accountId))

  if (accountsUsed.size === 1) {
    console.log(`\n✅ Session stickiness working: All requests used same account`.green)
  } else {
    console.log(
      `\n⚠️  Session stickiness issue: ${accountsUsed.size} different accounts used`.yellow
    )
  }

  return results
}

// 打印最终统计
function printFinalStats() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('📊 FINAL TEST STATISTICS'.cyan.bold)
  console.log('='.repeat(60))

  const successRate = ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1)
  stats.averageResponseTime =
    stats.responseTimes.length > 0
      ? (stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length).toFixed(0)
      : 0

  console.log(`Total Requests: ${stats.totalRequests}`)
  console.log(`Successful: ${stats.successfulRequests}`.green)
  console.log(`Failed: ${stats.failedRequests}`.red)
  console.log(`Success Rate: ${successRate}%`.bold)
  console.log(`Account Switches: ${stats.accountSwitches}`)
  console.log(`Fallback Used: ${stats.fallbackUsed}`)
  console.log(`Avg Response Time: ${stats.averageResponseTime}ms`)

  if (parseFloat(successRate) >= 80) {
    console.log('\n✅ TEST PASSED: Success rate >= 80%'.green.bold)
  } else {
    console.log('\n❌ TEST FAILED: Success rate < 80%'.red.bold)
  }
}

// 主测试流程
async function runTests() {
  console.log('🚀 Starting Claude Relay Service Failover Tests'.bold)
  console.log('Service URL:', config.serviceUrl)
  console.log('API Key:', config.apiKey)
  console.log('')

  try {
    // 初始化Redis
    await initRedis()

    // 运行各个测试场景
    await testNormalRequests()
    await new Promise((resolve) => setTimeout(resolve, 2000))

    await testRateLimitFailover()
    await new Promise((resolve) => setTimeout(resolve, 2000))

    await testSessionStickiness()
    await new Promise((resolve) => setTimeout(resolve, 2000))

    await testConcurrentRequests()
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // 注意：testGroupFailureWithFallback 需要预配置
    // await testGroupFailureWithFallback()

    // 打印统计
    printFinalStats()
  } catch (error) {
    console.error('❌ Test execution failed:', error)
  } finally {
    if (redisClient) {
      redisClient.quit()
    }
    process.exit(stats.failedRequests > stats.totalRequests * 0.2 ? 1 : 0)
  }
}

// 处理命令行参数
if (process.argv.includes('--help')) {
  console.log(`
Usage: node test-failover.js [options]

Environment Variables:
  SERVICE_URL     - Claude Relay Service URL (default: http://localhost:3000)
  TEST_API_KEY    - API key for testing (default: cr_test_key)
  REDIS_HOST      - Redis host (default: localhost)
  REDIS_PORT      - Redis port (default: 6379)
  REDIS_PASSWORD  - Redis password (optional)

Example:
  SERVICE_URL=http://localhost:3000 TEST_API_KEY=cr_xxx node test-failover.js
  `)
  process.exit(0)
}

// 运行测试
runTests().catch(console.error)
