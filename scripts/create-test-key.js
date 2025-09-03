#!/usr/bin/env node

const apiKeyService = require('../src/services/apiKeyService')
const _logger = require('../src/utils/logger')
const redis = require('../src/models/redis')

async function createTestKey() {
  try {
    console.log('Creating test API key...')

    // 先连接Redis
    await redis.connect()
    console.log('Connected to Redis')

    // 创建测试用的API Key
    const result = await apiKeyService.generateApiKey({
      name: 'Test Failover Key',
      description: 'Test key for failover functionality',
      tokenLimit: 10000,
      permissions: 'all',
      isActive: true
    })

    console.log('\n✅ Test API Key created successfully!')
    console.log(`API Key: ${result.apiKey}`)
    console.log(`Key ID: ${result.id}`)
    console.log('\nYou can now use this key for testing:')
    console.log(`curl -X POST http://localhost:3000/api/v1/messages \\`)
    console.log(`  -H "Authorization: Bearer ${result.apiKey}" \\`)
    console.log(`  -H "Content-Type: application/json" \\`)
    console.log(
      `  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "Hello!"}], "max_tokens": 50}'`
    )
  } catch (error) {
    console.error('❌ Failed to create test key:', error)
    process.exit(1)
  } finally {
    // 关闭Redis连接
    if (redis.client) {
      redis.client.disconnect()
    }
    process.exit(0)
  }
}

createTestKey()
