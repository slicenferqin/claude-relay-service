const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const bedrockAccountService = require('./bedrockAccountService')
const accountGroupService = require('./accountGroupService')
const smartGroupScheduler = require('./smartGroupScheduler')
const accountHealthService = require('./accountHealthService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class UnifiedClaudeScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'unified_claude_session_mapping:'
  }

  // 🔧 辅助方法：检查账户是否可调度（兼容字符串和布尔值）
  _isSchedulable(schedulable) {
    // 如果是 undefined 或 null，默认为可调度
    if (schedulable === undefined || schedulable === null) {
      return true
    }
    // 明确设置为 false（布尔值）或 'false'（字符串）时不可调度
    return schedulable !== false && schedulable !== 'false'
  }

  // 🎯 统一调度Claude账号（官方和Console）
  async selectAccountForApiKey(
    apiKeyData,
    sessionHash = null,
    requestedModel = null,
    options = {}
  ) {
    const { excludeAccounts = [] } = options
    // 记录debug日志避免未使用变量警告
    if (excludeAccounts.length > 0) {
      logger.debug(`Excluding accounts: ${excludeAccounts.join(', ')}`)
    }
    try {
      // 如果API Key绑定了专属账户或分组，优先使用
      if (apiKeyData.claudeAccountId) {
        // 检查是否是分组
        if (apiKeyData.claudeAccountId.startsWith('group:')) {
          const groupId = apiKeyData.claudeAccountId.replace('group:', '')
          logger.info(
            `🎯 API key ${apiKeyData.name} is bound to group ${groupId}, using smart group scheduling`
          )
          return await smartGroupScheduler.selectAccountFromGroup(
            groupId,
            sessionHash,
            requestedModel,
            {
              apiKeyName: apiKeyData.name,
              apiKeyId: apiKeyData.id
            }
          )
        }

        // 普通专属账户 - 先检查健康状态
        const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId)
        if (boundAccount && boundAccount.isActive === 'true' && boundAccount.status !== 'error') {
          // 检查账户健康状态
          const healthStatus = await accountHealthService.getAccountHealthStatus(
            apiKeyData.claudeAccountId
          )

          if (healthStatus.healthy && !healthStatus.quarantined) {
            logger.info(
              `🎯 Using bound dedicated Claude OAuth account: ${boundAccount.name} (${apiKeyData.claudeAccountId}) for API key ${apiKeyData.name}`
            )
            return {
              accountId: apiKeyData.claudeAccountId,
              accountType: 'claude-official'
            }
          } else {
            logger.warn(
              `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is unhealthy (${healthStatus.error || 'quarantined'}), falling back to pool`
            )
          }
        } else {
          logger.warn(
            `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not available, falling back to pool`
          )
        }
      }

      // 2. 检查Claude Console账户绑定
      if (apiKeyData.claudeConsoleAccountId) {
        const boundConsoleAccount = await claudeConsoleAccountService.getAccount(
          apiKeyData.claudeConsoleAccountId
        )
        if (
          boundConsoleAccount &&
          boundConsoleAccount.isActive === true &&
          boundConsoleAccount.status === 'active'
        ) {
          logger.info(
            `🎯 Using bound dedicated Claude Console account: ${boundConsoleAccount.name} (${apiKeyData.claudeConsoleAccountId}) for API key ${apiKeyData.name}`
          )
          return {
            accountId: apiKeyData.claudeConsoleAccountId,
            accountType: 'claude-console'
          }
        } else {
          logger.warn(
            `⚠️ Bound Claude Console account ${apiKeyData.claudeConsoleAccountId} is not available, falling back to pool`
          )
        }
      }

      // 3. 检查Bedrock账户绑定
      if (apiKeyData.bedrockAccountId) {
        const boundBedrockAccountResult = await bedrockAccountService.getAccount(
          apiKeyData.bedrockAccountId
        )
        if (boundBedrockAccountResult.success && boundBedrockAccountResult.data.isActive === true) {
          logger.info(
            `🎯 Using bound dedicated Bedrock account: ${boundBedrockAccountResult.data.name} (${apiKeyData.bedrockAccountId}) for API key ${apiKeyData.name}`
          )
          return {
            accountId: apiKeyData.bedrockAccountId,
            accountType: 'bedrock'
          }
        } else {
          logger.warn(
            `⚠️ Bound Bedrock account ${apiKeyData.bedrockAccountId} is not available, falling back to pool`
          )
        }
      }

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          // 验证映射的账户是否仍然可用
          const isAvailable = await this._isAccountAvailable(
            mappedAccount.accountId,
            mappedAccount.accountType
          )
          if (isAvailable) {
            logger.info(
              `🎯 Using sticky session account: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
            )
            return mappedAccount
          } else {
            logger.warn(
              `⚠️ Mapped account ${mappedAccount.accountId} is no longer available, selecting new account`
            )
            await this._deleteSessionMapping(sessionHash)
          }
        }
      }

      // 获取所有可用账户（传递请求的模型进行过滤）
      const availableAccounts = await this._getAllAvailableAccounts(
        apiKeyData,
        requestedModel,
        excludeAccounts
      )

      if (availableAccounts.length === 0) {
        // 提供更详细的错误信息
        if (requestedModel) {
          throw new Error(
            `No available Claude accounts support the requested model: ${requestedModel}`
          )
        } else {
          throw new Error('No available Claude accounts (neither official nor console)')
        }
      }

      // 按优先级和最后使用时间排序
      const sortedAccounts = this._sortAccountsByPriority(availableAccounts)

      // 选择第一个账户
      const selectedAccount = sortedAccounts[0]

      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 Created new sticky session mapping: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 Selected account: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) with priority ${selectedAccount.priority} for API key ${apiKeyData.name}`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('❌ Failed to select account for API key:', error)
      throw error
    }
  }

  // 📋 获取所有可用账户（合并官方和Console）
  async _getAllAvailableAccounts(apiKeyData, requestedModel = null, excludeAccounts = []) {
    const availableAccounts = []

    // 如果API Key绑定了专属账户，优先返回
    // 1. 检查Claude OAuth账户绑定
    if (apiKeyData.claudeAccountId) {
      const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId)
      if (
        boundAccount &&
        boundAccount.isActive === 'true' &&
        boundAccount.status !== 'error' &&
        boundAccount.status !== 'blocked'
      ) {
        const isRateLimited = await claudeAccountService.isAccountRateLimited(boundAccount.id)
        if (!isRateLimited) {
          logger.info(
            `🎯 Using bound dedicated Claude OAuth account: ${boundAccount.name} (${apiKeyData.claudeAccountId})`
          )
          return [
            {
              ...boundAccount,
              accountId: boundAccount.id,
              accountType: 'claude-official',
              priority: parseInt(boundAccount.priority) || 50,
              lastUsedAt: boundAccount.lastUsedAt || '0'
            }
          ]
        }
      } else {
        logger.warn(`⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not available`)
      }
    }

    // 2. 检查Claude Console账户绑定
    if (apiKeyData.claudeConsoleAccountId) {
      const boundConsoleAccount = await claudeConsoleAccountService.getAccount(
        apiKeyData.claudeConsoleAccountId
      )
      if (
        boundConsoleAccount &&
        boundConsoleAccount.isActive === true &&
        boundConsoleAccount.status === 'active'
      ) {
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(
          boundConsoleAccount.id
        )
        if (!isRateLimited) {
          logger.info(
            `🎯 Using bound dedicated Claude Console account: ${boundConsoleAccount.name} (${apiKeyData.claudeConsoleAccountId})`
          )
          return [
            {
              ...boundConsoleAccount,
              accountId: boundConsoleAccount.id,
              accountType: 'claude-console',
              priority: parseInt(boundConsoleAccount.priority) || 50,
              lastUsedAt: boundConsoleAccount.lastUsedAt || '0'
            }
          ]
        }
      } else {
        logger.warn(
          `⚠️ Bound Claude Console account ${apiKeyData.claudeConsoleAccountId} is not available`
        )
      }
    }

    // 3. 检查Bedrock账户绑定
    if (apiKeyData.bedrockAccountId) {
      const boundBedrockAccountResult = await bedrockAccountService.getAccount(
        apiKeyData.bedrockAccountId
      )
      if (boundBedrockAccountResult.success && boundBedrockAccountResult.data.isActive === true) {
        logger.info(
          `🎯 Using bound dedicated Bedrock account: ${boundBedrockAccountResult.data.name} (${apiKeyData.bedrockAccountId})`
        )
        return [
          {
            ...boundBedrockAccountResult.data,
            accountId: boundBedrockAccountResult.data.id,
            accountType: 'bedrock',
            priority: parseInt(boundBedrockAccountResult.data.priority) || 50,
            lastUsedAt: boundBedrockAccountResult.data.lastUsedAt || '0'
          }
        ]
      } else {
        logger.warn(`⚠️ Bound Bedrock account ${apiKeyData.bedrockAccountId} is not available`)
      }
    }

    // 获取官方Claude账户（共享池）
    const claudeAccounts = await redis.getAllClaudeAccounts()
    for (const account of claudeAccounts) {
      // 排除已尝试的账户和临时不可用的账户
      if (excludeAccounts.includes(account.id)) {
        continue
      }

      if (await this.isAccountTemporarilyUnavailable(account.id, 'claude-official')) {
        continue
      }

      if (
        account.isActive === 'true' &&
        account.status !== 'error' &&
        account.status !== 'blocked' &&
        (account.accountType === 'shared' || !account.accountType) && // 兼容旧数据
        this._isSchedulable(account.schedulable)
      ) {
        // 检查是否可调度

        // 检查模型支持（如果请求的是 Opus 模型）
        if (requestedModel && requestedModel.toLowerCase().includes('opus')) {
          // 检查账号的订阅信息
          if (account.subscriptionInfo) {
            try {
              const info =
                typeof account.subscriptionInfo === 'string'
                  ? JSON.parse(account.subscriptionInfo)
                  : account.subscriptionInfo

              // Pro 和 Free 账号不支持 Opus
              if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
                logger.info(`🚫 Claude account ${account.name} (Pro) does not support Opus model`)
                continue // Claude Pro 不支持 Opus
              }
              if (info.accountType === 'claude_pro' || info.accountType === 'claude_free') {
                logger.info(
                  `🚫 Claude account ${account.name} (${info.accountType}) does not support Opus model`
                )
                continue // 明确标记为 Pro 或 Free 的账号不支持
              }
            } catch (e) {
              // 解析失败，假设为旧数据，默认支持（兼容旧数据为 Max）
              logger.debug(`Account ${account.name} has invalid subscriptionInfo, assuming Max`)
            }
          }
          // 没有订阅信息的账号，默认当作支持（兼容旧数据）
        }

        // 检查是否被限流
        const isRateLimited = await claudeAccountService.isAccountRateLimited(account.id)
        if (!isRateLimited) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-official',
            priority: parseInt(account.priority) || 50, // 默认优先级50
            lastUsedAt: account.lastUsedAt || '0'
          })
        }
      }
    }

    // 获取Claude Console账户
    const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
    logger.info(`📋 Found ${consoleAccounts.length} total Claude Console accounts`)

    for (const account of consoleAccounts) {
      // 排除已尝试的账户和临时不可用的账户
      if (excludeAccounts.includes(account.id)) {
        continue
      }

      if (await this.isAccountTemporarilyUnavailable(account.id, 'claude-console')) {
        continue
      }

      logger.info(
        `🔍 Checking Claude Console account: ${account.name} - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
      )

      // 注意：getAllAccounts返回的isActive是布尔值
      if (
        account.isActive === true &&
        account.status === 'active' &&
        account.accountType === 'shared' &&
        this._isSchedulable(account.schedulable)
      ) {
        // 检查是否可调度

        // 检查模型支持（如果有请求的模型）
        if (requestedModel && account.supportedModels) {
          // 兼容旧格式（数组）和新格式（对象）
          if (Array.isArray(account.supportedModels)) {
            // 旧格式：数组
            if (
              account.supportedModels.length > 0 &&
              !account.supportedModels.includes(requestedModel)
            ) {
              logger.info(
                `🚫 Claude Console account ${account.name} does not support model ${requestedModel}`
              )
              continue
            }
          } else if (typeof account.supportedModels === 'object') {
            // 新格式：映射表
            if (
              Object.keys(account.supportedModels).length > 0 &&
              !claudeConsoleAccountService.isModelSupported(account.supportedModels, requestedModel)
            ) {
              logger.info(
                `🚫 Claude Console account ${account.name} does not support model ${requestedModel}`
              )
              continue
            }
          }
        }

        // 检查是否被限流
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(account.id)
        if (!isRateLimited) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-console',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(
            `✅ Added Claude Console account to available pool: ${account.name} (priority: ${account.priority})`
          )
        } else {
          logger.warn(`⚠️ Claude Console account ${account.name} is rate limited`)
        }
      } else {
        logger.info(
          `❌ Claude Console account ${account.name} not eligible - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )
      }
    }

    // 获取Bedrock账户（共享池）
    const bedrockAccountsResult = await bedrockAccountService.getAllAccounts()
    if (bedrockAccountsResult.success) {
      const bedrockAccounts = bedrockAccountsResult.data
      logger.info(`📋 Found ${bedrockAccounts.length} total Bedrock accounts`)

      for (const account of bedrockAccounts) {
        logger.info(
          `🔍 Checking Bedrock account: ${account.name} - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === true &&
          account.accountType === 'shared' &&
          this._isSchedulable(account.schedulable)
        ) {
          // 检查是否可调度

          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'bedrock',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(
            `✅ Added Bedrock account to available pool: ${account.name} (priority: ${account.priority})`
          )
        } else {
          logger.info(
            `❌ Bedrock account ${account.name} not eligible - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
          )
        }
      }
    }

    logger.info(
      `📊 Total available accounts: ${availableAccounts.length} (Claude: ${availableAccounts.filter((a) => a.accountType === 'claude-official').length}, Console: ${availableAccounts.filter((a) => a.accountType === 'claude-console').length}, Bedrock: ${availableAccounts.filter((a) => a.accountType === 'bedrock').length})`
    )
    return availableAccounts
  }

  // 🔢 按优先级和最后使用时间排序账户
  _sortAccountsByPriority(accounts) {
    return accounts.sort((a, b) => {
      // 首先按优先级排序（数字越小优先级越高）
      if (a.priority !== b.priority) {
        return a.priority - b.priority
      }

      // 优先级相同时，按最后使用时间排序（最久未使用的优先）
      const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
      const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
      return aLastUsed - bLastUsed
    })
  }

  // 🔍 检查账户是否可用
  async _isAccountAvailable(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        const account = await redis.getClaudeAccount(accountId)
        if (!account || account.isActive !== 'true' || account.status === 'error') {
          return false
        }
        // 检查是否可调度
        if (!this._isSchedulable(account.schedulable)) {
          logger.info(`🚫 Account ${accountId} is not schedulable`)
          return false
        }
        return !(await claudeAccountService.isAccountRateLimited(accountId))
      } else if (accountType === 'claude-console') {
        const account = await claudeConsoleAccountService.getAccount(accountId)
        if (!account || !account.isActive || account.status !== 'active') {
          return false
        }
        // 检查是否可调度
        if (!this._isSchedulable(account.schedulable)) {
          logger.info(`🚫 Claude Console account ${accountId} is not schedulable`)
          return false
        }
        return !(await claudeConsoleAccountService.isAccountRateLimited(accountId))
      } else if (accountType === 'bedrock') {
        const accountResult = await bedrockAccountService.getAccount(accountId)
        if (!accountResult.success || !accountResult.data.isActive) {
          return false
        }
        // 检查是否可调度
        if (!this._isSchedulable(accountResult.data.schedulable)) {
          logger.info(`🚫 Bedrock account ${accountId} is not schedulable`)
          return false
        }
        // Bedrock账户暂不需要限流检查，因为AWS管理限流
        return true
      }
      return false
    } catch (error) {
      logger.warn(`⚠️ Failed to check account availability: ${accountId}`, error)
      return false
    }
  }

  // 🔗 获取会话映射
  async _getSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    const mappingData = await client.get(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (mappingData) {
      try {
        return JSON.parse(mappingData)
      } catch (error) {
        logger.warn('⚠️ Failed to parse session mapping:', error)
        return null
      }
    }

    return null
  }

  // 💾 设置会话映射
  async _setSessionMapping(sessionHash, accountId, accountType) {
    const client = redis.getClientSafe()
    const mappingData = JSON.stringify({ accountId, accountType })

    // 设置1小时过期
    await client.setex(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`, 3600, mappingData)
  }

  // 🗑️ 删除会话映射
  async _deleteSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    await client.del(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
  }

  // 🚫 标记账户为限流状态
  async markAccountRateLimited(
    accountId,
    accountType,
    sessionHash = null,
    rateLimitResetTimestamp = null
  ) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountRateLimited(
          accountId,
          sessionHash,
          rateLimitResetTimestamp
        )
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.markAccountRateLimited(accountId)
      }

      // 删除会话映射
      if (sessionHash) {
        await this._deleteSessionMapping(sessionHash)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as rate limited: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // ✅ 移除账户的限流状态
  async removeAccountRateLimit(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.removeAccountRateLimit(accountId)
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.removeAccountRateLimit(accountId)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to remove rate limit for account: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // 🔍 检查账户是否处于限流状态
  async isAccountRateLimited(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        return await claudeAccountService.isAccountRateLimited(accountId)
      } else if (accountType === 'claude-console') {
        return await claudeConsoleAccountService.isAccountRateLimited(accountId)
      }
      return false
    } catch (error) {
      logger.error(`❌ Failed to check rate limit status: ${accountId} (${accountType})`, error)
      return false
    }
  }

  // 🚫 标记账户为未授权状态（401错误）
  async markAccountUnauthorized(accountId, accountType, sessionHash = null) {
    try {
      // 只处理claude-official类型的账户，不处理claude-console和gemini
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountUnauthorized(accountId, sessionHash)

        // 删除会话映射
        if (sessionHash) {
          await this._deleteSessionMapping(sessionHash)
        }

        logger.warn(`🚫 Account ${accountId} marked as unauthorized due to consecutive 401 errors`)
      } else {
        logger.info(
          `ℹ️ Skipping unauthorized marking for non-Claude OAuth account: ${accountId} (${accountType})`
        )
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as unauthorized: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // 🚫 标记Claude Console账户为封锁状态（模型不支持）
  async blockConsoleAccount(accountId, reason) {
    try {
      await claudeConsoleAccountService.blockAccount(accountId, reason)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to block console account: ${accountId}`, error)
      throw error
    }
  }

  // 👥 从分组中选择账户
  async selectAccountFromGroup(groupId, sessionHash = null, requestedModel = null) {
    try {
      // 获取分组信息
      const group = await accountGroupService.getGroup(groupId)
      if (!group) {
        throw new Error(`Group ${groupId} not found`)
      }

      logger.info(`👥 Selecting account from group: ${group.name} (${group.platform})`)

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          // 验证映射的账户是否属于这个分组
          const memberIds = await accountGroupService.getGroupMembers(groupId)
          if (memberIds.includes(mappedAccount.accountId)) {
            const isAvailable = await this._isAccountAvailable(
              mappedAccount.accountId,
              mappedAccount.accountType
            )
            if (isAvailable) {
              logger.info(
                `🎯 Using sticky session account from group: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
              )
              return mappedAccount
            }
          }
          // 如果映射的账户不可用或不在分组中，删除映射
          await this._deleteSessionMapping(sessionHash)
        }
      }

      // 获取分组内的所有账户
      const memberIds = await accountGroupService.getGroupMembers(groupId)
      if (memberIds.length === 0) {
        throw new Error(`Group ${group.name} has no members`)
      }

      const availableAccounts = []

      // 获取所有成员账户的详细信息
      for (const memberId of memberIds) {
        let account = null
        let accountType = null

        // 根据平台类型获取账户
        if (group.platform === 'claude') {
          // 先尝试官方账户
          account = await redis.getClaudeAccount(memberId)
          if (account?.id) {
            accountType = 'claude-official'
          } else {
            // 尝试Console账户
            account = await claudeConsoleAccountService.getAccount(memberId)
            if (account) {
              accountType = 'claude-console'
            }
          }
        } else if (group.platform === 'gemini') {
          // Gemini暂时不支持，预留接口
          logger.warn('⚠️ Gemini group scheduling not yet implemented')
          continue
        }

        if (!account) {
          logger.warn(`⚠️ Account ${memberId} not found in group ${group.name}`)
          continue
        }

        // 检查账户是否可用
        const isActive =
          accountType === 'claude-official'
            ? account.isActive === 'true'
            : account.isActive === true

        const status =
          accountType === 'claude-official'
            ? account.status !== 'error' && account.status !== 'blocked'
            : account.status === 'active'

        if (isActive && status && this._isSchedulable(account.schedulable)) {
          // 检查模型支持（Console账户）
          if (
            accountType === 'claude-console' &&
            requestedModel &&
            account.supportedModels &&
            account.supportedModels.length > 0
          ) {
            if (!account.supportedModels.includes(requestedModel)) {
              logger.info(
                `🚫 Account ${account.name} in group does not support model ${requestedModel}`
              )
              continue
            }
          }

          // 检查是否被限流
          const isRateLimited = await this.isAccountRateLimited(account.id, accountType)
          if (!isRateLimited) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType,
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
          }
        }
      }

      if (availableAccounts.length === 0) {
        throw new Error(`No available accounts in group ${group.name}`)
      }

      // 使用现有的优先级排序逻辑
      const sortedAccounts = this._sortAccountsByPriority(availableAccounts)

      // 选择第一个账户
      const selectedAccount = sortedAccounts[0]

      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 Created new sticky session mapping in group: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 Selected account from group ${group.name}: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) with priority ${selectedAccount.priority}`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error(`❌ Failed to select account from group ${groupId}:`, error)
      throw error
    }
  }

  // 🚫 标记账户为临时不可用
  async markAccountTemporarilyUnavailable(accountId, accountType, duration = null) {
    const config = require('../../config/config')
    const defaultDuration = config.failover?.tempUnavailableDuration || 300
    try {
      const key = `temp_unavailable:${accountType}:${accountId}`
      const client = redis.getClientSafe()

      const actualDuration = duration || defaultDuration
      await client.set(key, Date.now().toString(), 'EX', actualDuration)

      logger.warn(
        `🚫 Marked account ${accountId} (${accountType}) as temporarily unavailable for ${actualDuration}s`
      )
    } catch (error) {
      logger.error(`❌ Failed to mark account ${accountId} as unavailable:`, error)
    }
  }

  // ✅ 检查账户是否临时不可用
  async isAccountTemporarilyUnavailable(accountId, accountType) {
    try {
      const key = `temp_unavailable:${accountType}:${accountId}`
      const client = redis.getClientSafe()

      const result = await client.get(key)
      return !!result
    } catch (error) {
      logger.error(`❌ Failed to check account ${accountId} availability:`, error)
      return false
    }
  }

  // 🧹 清除账户临时不可用状态
  async clearTemporaryUnavailable(accountId, accountType) {
    try {
      const key = `temp_unavailable:${accountType}:${accountId}`
      const client = redis.getClientSafe()

      await client.del(key)
      logger.info(
        `✅ Cleared temporary unavailable status for account ${accountId} (${accountType})`
      )
    } catch (error) {
      logger.error(`❌ Failed to clear unavailable status for account ${accountId}:`, error)
    }
  }
}

module.exports = new UnifiedClaudeScheduler()
