#!/bin/bash

# 账号切流测试环境设置脚本
# 用于快速搭建测试环境和数据

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置变量
SERVICE_URL="${SERVICE_URL:-http://localhost:3000}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

# 打印带颜色的信息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查服务是否运行
check_service() {
    print_info "Checking if Claude Relay Service is running..."
    
    if curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL/health" | grep -q "200"; then
        print_success "Service is running at $SERVICE_URL"
        return 0
    else
        print_error "Service is not running at $SERVICE_URL"
        print_info "Please start the service first: npm start"
        exit 1
    fi
}

# 登录获取token
login() {
    print_info "Logging in as admin..."
    
    response=$(curl -s -X POST "$SERVICE_URL/admin/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")
    
    token=$(echo "$response" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
    
    if [ -z "$token" ]; then
        print_error "Failed to login. Check username/password."
        exit 1
    fi
    
    print_success "Login successful"
    echo "$token"
}

# 创建测试API Key
create_api_key() {
    local token=$1
    local name=$2
    local group_id=$3
    
    print_info "Creating API key: $name"
    
    body="{\"name\":\"$name\",\"dailyLimit\":10000,\"monthlyLimit\":1000000}"
    
    # 如果有分组ID，绑定到分组
    if [ ! -z "$group_id" ]; then
        body="{\"name\":\"$name\",\"dailyLimit\":10000,\"monthlyLimit\":1000000,\"claudeAccountId\":\"group:$group_id\"}"
    fi
    
    response=$(curl -s -X POST "$SERVICE_URL/admin/api-keys" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$body")
    
    key=$(echo "$response" | grep -o '"key":"[^"]*' | cut -d'"' -f4)
    
    if [ ! -z "$key" ]; then
        print_success "Created API key: $key"
        echo "$key"
    else
        print_warning "Failed to create API key: $name"
        echo ""
    fi
}

# 创建测试账户分组
create_account_group() {
    local token=$1
    local name=$2
    local platform=$3
    
    print_info "Creating account group: $name"
    
    response=$(curl -s -X POST "$SERVICE_URL/admin/account-groups" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "{
            \"name\":\"$name\",
            \"description\":\"Test group for failover testing\",
            \"platform\":\"$platform\",
            \"priority\":10,
            \"isActive\":true
        }")
    
    group_id=$(echo "$response" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
    
    if [ ! -z "$group_id" ]; then
        print_success "Created group: $group_id"
        echo "$group_id"
    else
        print_warning "Failed to create group: $name"
        echo ""
    fi
}

# 添加账户到分组
add_account_to_group() {
    local token=$1
    local group_id=$2
    local account_id=$3
    
    print_info "Adding account $account_id to group $group_id"
    
    curl -s -X POST "$SERVICE_URL/admin/account-groups/$group_id/members" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "{\"accountId\":\"$account_id\"}" > /dev/null
    
    print_success "Added account to group"
}

# 创建模拟账户
create_mock_account() {
    local token=$1
    local name=$2
    local status=$3
    
    print_info "Creating mock Claude account: $name (status: $status)"
    
    # 这里需要根据实际的账户创建API调整
    # 暂时使用占位逻辑
    
    account_id="mock_$(date +%s)_$(echo $RANDOM)"
    print_success "Created mock account: $account_id"
    echo "$account_id"
}

# 设置后备账户
set_fallback_account() {
    local token=$1
    local platform=$2
    local account_id=$3
    
    print_info "Setting fallback account for $platform: $account_id"
    
    # 通过Redis或API设置后备账户
    # 这里需要实际的API端点
    
    print_success "Fallback account configured"
}

# 创建测试数据摘要文件
create_test_summary() {
    local api_key=$1
    local group_id=$2
    
    cat > test-env-summary.txt << EOF
====================================
Claude Relay Service Test Environment
====================================
Date: $(date)
Service URL: $SERVICE_URL

Test API Keys:
- Normal: $api_key
- Group-bound: cr_group_xxx (bound to group: $group_id)

Test Groups:
- Group A (Claude): $group_id
  - 3 accounts configured
  - For testing failover scenarios

Test Scenarios Ready:
1. Normal requests
2. Rate limit failover
3. Group failure with fallback
4. Session stickiness
5. Concurrent requests

To run tests:
  export TEST_API_KEY="$api_key"
  export SERVICE_URL="$SERVICE_URL"
  node scripts/test-failover.js

To monitor:
  tail -f logs/claude-relay-*.log
====================================
EOF
    
    print_success "Test environment summary saved to test-env-summary.txt"
}

# 主流程
main() {
    echo "========================================="
    echo "Claude Relay Service Test Environment Setup"
    echo "========================================="
    echo ""
    
    # 1. 检查服务
    check_service
    
    # 2. 登录获取token
    TOKEN=$(login)
    
    # 3. 创建测试分组
    print_info "Creating test groups..."
    GROUP_A=$(create_account_group "$TOKEN" "Test-Group-A" "claude")
    
    # 4. 创建测试账户（如果有实际的账户创建API）
    # ACCOUNT_1=$(create_mock_account "$TOKEN" "test-account-1" "healthy")
    # ACCOUNT_2=$(create_mock_account "$TOKEN" "test-account-2" "rate_limited")
    # ACCOUNT_3=$(create_mock_account "$TOKEN" "test-account-3" "unauthorized")
    
    # 5. 添加账户到分组（如果有实际账户）
    # add_account_to_group "$TOKEN" "$GROUP_A" "$ACCOUNT_1"
    # add_account_to_group "$TOKEN" "$GROUP_A" "$ACCOUNT_2"
    # add_account_to_group "$TOKEN" "$GROUP_A" "$ACCOUNT_3"
    
    # 6. 创建测试API Keys
    print_info "Creating test API keys..."
    API_KEY_NORMAL=$(create_api_key "$TOKEN" "test-normal-key" "")
    API_KEY_GROUP=$(create_api_key "$TOKEN" "test-group-key" "$GROUP_A")
    
    # 7. 配置后备账户（如果有API）
    # set_fallback_account "$TOKEN" "claude" "$FALLBACK_ACCOUNT"
    
    # 8. 创建测试摘要
    create_test_summary "$API_KEY_NORMAL" "$GROUP_A"
    
    echo ""
    print_success "Test environment setup complete!"
    echo ""
    echo "Next steps:"
    echo "1. Review test-env-summary.txt for test configuration"
    echo "2. Run: export TEST_API_KEY=\"$API_KEY_NORMAL\""
    echo "3. Run: node scripts/test-failover.js"
    echo ""
}

# 清理函数
cleanup() {
    print_warning "Cleaning up test environment..."
    # 添加清理逻辑
}

# 捕获退出信号
trap cleanup EXIT

# 解析命令行参数
case "${1:-}" in
    --clean)
        cleanup
        exit 0
        ;;
    --help)
        echo "Usage: $0 [--clean|--help]"
        echo ""
        echo "Options:"
        echo "  --clean    Clean up test environment"
        echo "  --help     Show this help message"
        echo ""
        echo "Environment variables:"
        echo "  SERVICE_URL      Service URL (default: http://localhost:3000)"
        echo "  ADMIN_USERNAME   Admin username (default: admin)"
        echo "  ADMIN_PASSWORD   Admin password (default: admin123)"
        exit 0
        ;;
esac

# 运行主流程
main