#!/bin/bash

# Claude Relay Service 增强版多实例管理脚本
# 支持在同一服务器上部署多个服务实例
# 新增 Redis 安装和交互式菜单功能

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# 默认配置
DEFAULT_BASE_DIR="$HOME/claude-relay-instances"
DEFAULT_REDIS_HOST="localhost"
DEFAULT_REDIS_PORT="6379"
DEFAULT_REDIS_PASSWORD=""
DEFAULT_BASE_PORT="3000"
INSTANCES_CONFIG_FILE="$HOME/.crs-instances"
REDIS_CONFIG_FILE="$HOME/.crs-redis-instances"

# 全局变量
BASE_DIR=""
INSTANCE_NAME=""
INSTANCE_DIR=""
APP_PORT=""
REDIS_HOST=""
REDIS_PORT=""
REDIS_PASSWORD=""

# 实例配置数组
declare -A INSTANCES

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_header() {
    clear
    echo -e "${BOLD}${MAGENTA}==========================================${NC}"
    echo -e "${BOLD}${MAGENTA} Claude Relay Service 增强版多实例管理${NC}"
    echo -e "${BOLD}${MAGENTA}==========================================${NC}"
}

print_menu() {
    echo
    echo -e "${BOLD}${BLUE}请选择操作：${NC}"
    echo "  1. 📦 安装新实例"
    echo "  2. 📋 列出所有实例"
    echo "  3. 🚀 启动实例"
    echo "  4. ⏹️  停止实例"
    echo "  5. 🔄 重启实例"
    echo "  6. 📊 查看实例状态"
    echo "  7. 🗑️  删除实例"
    echo "  8. 🔧 安装/配置 Redis"
    echo "  9. 💾 另外新启服务（基于现有实例）"
    echo "  0. ❌ 退出"
    echo
}

# 检测操作系统
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ -f /etc/debian_version ]; then
            OS="debian"
            PACKAGE_MANAGER="apt"
        elif [ -f /etc/redhat-release ]; then
            OS="redhat"
            PACKAGE_MANAGER="yum"
        elif [ -f /etc/arch-release ]; then
            OS="arch"
            PACKAGE_MANAGER="pacman"
        else
            OS="unknown"
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        PACKAGE_MANAGER="brew"
    else
        OS="unknown"
    fi
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 检查是否以root权限运行
check_root() {
    if [ "$EUID" -eq 0 ]; then
        return 0
    else
        return 1
    fi
}

# 检查端口是否被占用
check_port() {
    local port=$1
    if command_exists lsof; then
        lsof -i ":$port" >/dev/null 2>&1
    elif command_exists netstat; then
        netstat -tuln | grep ":$port " >/dev/null 2>&1
    elif command_exists ss; then
        ss -tuln | grep ":$port " >/dev/null 2>&1
    else
        return 1
    fi
}

# 生成随机字符串
generate_random_string() {
    local length=$1
    if command_exists openssl; then
        openssl rand -hex $((length/2))
    else
        cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w $length | head -n 1
    fi
}

# 获取下一个可用端口
get_next_available_port() {
    local start_port=${1:-3000}
    local port=$start_port
    
    while check_port $port; do
        ((port++))
        if [ $port -gt 65535 ]; then
            print_error "无法找到可用端口"
            return 1
        fi
    done
    
    echo $port
}

# 加载实例配置
load_instances_config() {
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        while IFS='=' read -r key value; do
            if [[ $key && $value ]]; then
                INSTANCES[$key]=$value
            fi
        done < "$INSTANCES_CONFIG_FILE"
    fi
}

# 保存实例配置
save_instances_config() {
    > "$INSTANCES_CONFIG_FILE"
    for instance_name in "${!INSTANCES[@]}"; do
        echo "$instance_name=${INSTANCES[$instance_name]}" >> "$INSTANCES_CONFIG_FILE"
    done
}

# 验证实例名称
validate_instance_name() {
    local name=$1
    if [[ ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
        print_error "实例名称只能包含字母、数字、下划线和连字符，且不能以连字符开头"
        return 1
    fi
    return 0
}

# 检查实例是否存在
instance_exists() {
    local name=$1
    [ -n "${INSTANCES[$name]}" ]
}

# 获取实例信息
get_instance_info() {
    local name=$1
    local config="${INSTANCES[$name]}"
    
    if [ -z "$config" ]; then
        return 1
    fi
    
    # 解析配置：dir:port:redis_host:redis_port
    IFS=':' read -r instance_dir instance_port instance_redis_host instance_redis_port <<< "$config"
    
    echo "DIR:$instance_dir"
    echo "PORT:$instance_port"
    echo "REDIS_HOST:$instance_redis_host"
    echo "REDIS_PORT:$instance_redis_port"
}

# 检查实例是否在运行
is_instance_running() {
    local name=$1
    local info=$(get_instance_info "$name")
    
    if [ -z "$info" ]; then
        return 1
    fi
    
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    check_port "$port"
}

# 安装 Redis
install_redis() {
    print_header
    echo
    print_info "开始安装和配置 Redis..."
    
    # 检查是否已安装 Redis
    if ! command_exists redis-server; then
        print_info "Redis 未安装，开始安装..."
        
        case $OS in
            "debian")
                sudo apt update
                sudo apt install redis-server -y
                ;;
            "redhat")
                sudo yum install redis -y || sudo dnf install redis -y
                ;;
            "arch")
                sudo pacman -S redis --noconfirm
                ;;
            "macos")
                brew install redis
                ;;
            *)
                print_error "不支持的操作系统，请手动安装 Redis"
                return 1
                ;;
        esac
        
        if ! command_exists redis-server; then
            print_error "Redis 安装失败"
            return 1
        fi
        
        print_success "Redis 安装成功"
    else
        print_info "Redis 已安装"
    fi
    
    # 配置 Redis 实例
    echo
    echo -n "Redis 端口 (默认: 6379): "
    read redis_port
    redis_port=${redis_port:-6379}
    
    # 验证端口
    if ! [[ "$redis_port" =~ ^[0-9]+$ ]] || [ "$redis_port" -lt 1024 ] || [ "$redis_port" -gt 65535 ]; then
        print_error "端口必须是 1024-65535 之间的数字"
        return 1
    fi
    
    # 检查端口是否被占用
    if check_port $redis_port && [ "$redis_port" != "6379" ]; then
        print_warning "端口 $redis_port 已被占用"
        echo -n "是否继续？(y/N): "
        read -n 1 continue_install
        echo
        if [[ ! "$continue_install" =~ ^[Yy]$ ]]; then
            return 1
        fi
    fi
    
    # 如果是默认端口，直接启动默认服务
    if [ "$redis_port" == "6379" ]; then
        print_info "启动默认 Redis 服务..."
        if [[ "$OS" == "debian" || "$OS" == "redhat" ]]; then
            sudo systemctl enable redis-server || sudo systemctl enable redis
            sudo systemctl start redis-server || sudo systemctl start redis
        elif [[ "$OS" == "macos" ]]; then
            brew services start redis
        fi
        print_success "默认 Redis 服务已启动 (端口: 6379)"
        return 0
    fi
    
    # 配置自定义端口的 Redis 实例
    print_info "配置 Redis 实例 (端口: $redis_port)..."
    
    if [[ "$OS" == "debian" || "$OS" == "redhat" ]]; then
        # 创建配置目录
        sudo mkdir -p /etc/redis-$redis_port
        sudo mkdir -p /var/lib/redis-$redis_port
        sudo mkdir -p /var/log/redis
        
        # 复制并修改配置文件
        sudo cp /etc/redis/redis.conf /etc/redis-$redis_port/redis.conf 2>/dev/null || \
        sudo cp /etc/redis.conf /etc/redis-$redis_port/redis.conf 2>/dev/null || {
            # 创建基本配置文件
            sudo tee /etc/redis-$redis_port/redis.conf > /dev/null <<EOF
port $redis_port
bind 127.0.0.1
protected-mode yes
save 900 1
save 300 10
save 60 10000
dir /var/lib/redis-$redis_port
logfile /var/log/redis/redis-server-$redis_port.log
pidfile /var/run/redis/redis-server-$redis_port.pid
databases 16
maxmemory-policy allkeys-lru
EOF
        }
        
        # 修改配置
        sudo sed -i "s/^port .*/port $redis_port/" /etc/redis-$redis_port/redis.conf
        sudo sed -i "s|^dir .*|dir /var/lib/redis-$redis_port|" /etc/redis-$redis_port/redis.conf
        sudo sed -i "s|^pidfile .*|pidfile /var/run/redis/redis-server-$redis_port.pid|" /etc/redis-$redis_port/redis.conf
        sudo sed -i "s|^logfile .*|logfile /var/log/redis/redis-server-$redis_port.log|" /etc/redis-$redis_port/redis.conf
        
        # 设置权限
        sudo chown redis:redis /var/lib/redis-$redis_port 2>/dev/null || sudo chown redis:redis /var/lib/redis-$redis_port
        
        # 创建 systemd 服务
        sudo tee /etc/systemd/system/redis-$redis_port.service > /dev/null <<EOF
[Unit]
Description=Redis In-Memory Data Store (Port $redis_port)
After=network.target

[Service]
User=redis
Group=redis
ExecStart=/usr/bin/redis-server /etc/redis-$redis_port/redis.conf
ExecStop=/usr/bin/redis-cli -p $redis_port shutdown
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
        
        # 启动服务
        sudo systemctl daemon-reload
        sudo systemctl enable redis-$redis_port
        sudo systemctl start redis-$redis_port
        
        # 检查状态
        if sudo systemctl is-active redis-$redis_port >/dev/null; then
            print_success "Redis 实例已启动 (端口: $redis_port)"
        else
            print_error "Redis 实例启动失败"
            return 1
        fi
        
    elif [[ "$OS" == "macos" ]]; then
        # macOS 配置
        local config_dir="$HOME/.redis"
        mkdir -p "$config_dir"
        
        cat > "$config_dir/redis-$redis_port.conf" <<EOF
port $redis_port
bind 127.0.0.1
protected-mode yes
save 900 1
save 300 10
save 60 10000
dir $config_dir/data-$redis_port
logfile $config_dir/redis-$redis_port.log
pidfile $config_dir/redis-$redis_port.pid
databases 16
maxmemory-policy allkeys-lru
EOF
        
        mkdir -p "$config_dir/data-$redis_port"
        
        # 启动 Redis 实例
        redis-server "$config_dir/redis-$redis_port.conf" --daemonize yes
        
        if redis-cli -p $redis_port ping >/dev/null 2>&1; then
            print_success "Redis 实例已启动 (端口: $redis_port)"
        else
            print_error "Redis 实例启动失败"
            return 1
        fi
    fi
    
    # 保存 Redis 实例信息
    echo "redis_$redis_port=localhost:$redis_port" >> "$REDIS_CONFIG_FILE"
    
    # 测试连接
    if redis-cli -p $redis_port ping >/dev/null 2>&1; then
        print_success "Redis 连接测试成功"
    else
        print_warning "Redis 连接测试失败，但服务可能仍在启动中"
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 列出所有实例
list_instances() {
    print_header
    echo
    
    if [ ${#INSTANCES[@]} -eq 0 ]; then
        print_info "未找到已安装的实例"
        echo
        print_info "使用菜单选项 1 安装新实例"
        echo
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    printf "%-20s %-8s %-15s %-10s %s\n" "实例名称" "端口" "目录" "状态" "Redis"
    printf "%-20s %-8s %-15s %-10s %s\n" "--------" "----" "----" "----" "-----"
    
    for instance_name in $(printf '%s\n' "${!INSTANCES[@]}" | sort); do
        local info=$(get_instance_info "$instance_name")
        local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
        local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
        local redis_host=$(echo "$info" | grep "REDIS_HOST:" | cut -d: -f2)
        local redis_port=$(echo "$info" | grep "REDIS_PORT:" | cut -d: -f2)
        
        # 检查运行状态
        local status=""
        if is_instance_running "$instance_name"; then
            status="${GREEN}运行中${NC}"
        else
            status="${RED}已停止${NC}"
        fi
        
        # 简化目录显示
        local short_dir=$(basename "$dir")
        
        printf "%-20s %-8s %-15s %-18s %s:%s\n" \
            "$instance_name" "$port" "$short_dir" "$status" "$redis_host" "$redis_port"
    done
    
    echo
    echo -n "按回车键继续..."
    read
}

# 选择实例
select_instance() {
    local action=$1
    
    if [ ${#INSTANCES[@]} -eq 0 ]; then
        print_error "没有可用的实例"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    echo
    echo -e "${BOLD}可用实例：${NC}"
    local i=1
    local instance_list=()
    for instance_name in $(printf '%s\n' "${!INSTANCES[@]}" | sort); do
        echo "  $i. $instance_name"
        instance_list+=("$instance_name")
        ((i++))
    done
    
    echo
    echo -n "请选择实例 (输入数字): "
    read choice
    
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#instance_list[@]} ]; then
        print_error "无效选择"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    local selected_instance="${instance_list[$((choice-1))]}"
    echo "$selected_instance"
}

# 安装新实例
install_instance() {
    print_header
    echo
    print_info "开始安装新的 Claude Relay Service 实例..."
    
    # 获取实例名称
    while true; do
        echo -n "实例名称 (例如: main, backup, test): "
        read INSTANCE_NAME
        
        if [ -z "$INSTANCE_NAME" ]; then
            print_error "实例名称不能为空"
            continue
        fi
        
        if ! validate_instance_name "$INSTANCE_NAME"; then
            continue
        fi
        
        if instance_exists "$INSTANCE_NAME"; then
            print_error "实例 '$INSTANCE_NAME' 已存在"
            continue
        fi
        
        break
    done
    
    # 获取基础目录
    echo -n "实例基础目录 (默认: $DEFAULT_BASE_DIR): "
    read input
    BASE_DIR=${input:-$DEFAULT_BASE_DIR}
    
    INSTANCE_DIR="$BASE_DIR/$INSTANCE_NAME"
    
    # 检查目录是否已存在
    if [ -d "$INSTANCE_DIR" ]; then
        print_warning "目录 $INSTANCE_DIR 已存在"
        echo -n "是否删除并重新创建？(y/N): "
        read -n 1 confirm
        echo
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            rm -rf "$INSTANCE_DIR"
        else
            print_error "安装取消"
            echo -n "按回车键继续..."
            read
            return 1
        fi
    fi
    
    # 获取端口
    local suggested_port=$(get_next_available_port $DEFAULT_BASE_PORT)
    echo -n "服务端口 (建议: $suggested_port): "
    read input
    APP_PORT=${input:-$suggested_port}
    
    # 验证端口
    if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || [ "$APP_PORT" -lt 1024 ] || [ "$APP_PORT" -gt 65535 ]; then
        print_error "端口必须是 1024-65535 之间的数字"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    if check_port $APP_PORT; then
        print_warning "端口 $APP_PORT 已被占用"
        echo -n "是否继续？(y/N): "
        read -n 1 continue_install
        echo
        if [[ ! "$continue_install" =~ ^[Yy]$ ]]; then
            echo -n "按回车键继续..."
            read
            return 1
        fi
    fi
    
    # Redis 配置
    echo -n "Redis 主机 (默认: $DEFAULT_REDIS_HOST): "
    read input
    REDIS_HOST=${input:-$DEFAULT_REDIS_HOST}
    
    echo -n "Redis 端口 (默认: $DEFAULT_REDIS_PORT): "
    read input
    REDIS_PORT=${input:-$DEFAULT_REDIS_PORT}
    
    echo -n "Redis 密码 (可选，直接回车跳过): "
    read REDIS_PASSWORD
    
    # 确认安装信息
    echo
    print_info "安装配置确认："
    echo "  实例名称: $INSTANCE_NAME"
    echo "  安装目录: $INSTANCE_DIR"
    echo "  服务端口: $APP_PORT"
    echo "  Redis: $REDIS_HOST:$REDIS_PORT"
    echo
    echo -n "确认安装？(y/N): "
    read -n 1 confirm
    echo
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_info "安装取消"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    # 开始安装
    print_info "创建实例目录..."
    mkdir -p "$INSTANCE_DIR"
    
    print_info "克隆项目代码..."
    if ! git clone https://github.com/slicenferqin/claude-relay-service.git "$INSTANCE_DIR" --branch feature/smart-account-scheduling --depth 1; then
        print_error "克隆项目失败"
        rm -rf "$INSTANCE_DIR"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    # 进入项目目录
    cd "$INSTANCE_DIR" || return 1
    
    # 安装依赖
    print_info "安装 Node.js 依赖..."
    if ! npm install; then
        print_error "安装依赖失败"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    # 创建配置文件
    print_info "生成配置文件..."
    
    # 生成密钥
    JWT_SECRET=$(generate_random_string 64)
    ENCRYPTION_KEY=$(generate_random_string 32)
    
    # 创建 .env 文件
    cat > .env << EOF
# 服务配置
PORT=$APP_PORT
NODE_ENV=production

# JWT密钥
JWT_SECRET=$JWT_SECRET

# 数据加密密钥 (32字符固定长度)
ENCRYPTION_KEY=$ENCRYPTION_KEY

# Redis配置
REDIS_HOST=$REDIS_HOST
REDIS_PORT=$REDIS_PORT
$([ -n "$REDIS_PASSWORD" ] && echo "REDIS_PASSWORD=$REDIS_PASSWORD")

# 日志级别
LOG_LEVEL=info

# 默认代理超时时间(毫秒)
DEFAULT_PROXY_TIMEOUT=30000

# 故障转移配置
FAILOVER_ENABLED=true
FAILOVER_MAX_RETRIES=3
TEMP_UNAVAILABLE_DURATION=300

# Webhook通知URL(可选)
# WEBHOOK_URLS=https://your-webhook-url.com/notify
EOF
    
    # 复制配置示例文件
    if [ -f "config/config.example.js" ]; then
        cp config/config.example.js config/config.js
    fi
    
    # 运行初始化
    print_info "运行初始化设置..."
    if ! npm run setup; then
        print_error "初始化失败"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    # 保存实例配置
    INSTANCES[$INSTANCE_NAME]="$INSTANCE_DIR:$APP_PORT:$REDIS_HOST:$REDIS_PORT"
    save_instances_config
    
    print_success "实例 '$INSTANCE_NAME' 安装完成！"
    echo
    print_info "实例信息："
    echo "  访问地址: http://localhost:$APP_PORT"
    echo "  管理界面: http://localhost:$APP_PORT/admin"
    echo "  健康检查: http://localhost:$APP_PORT/health"
    echo
    echo -n "按回车键继续..."
    read
}

# 启动实例
start_instance() {
    local name=$(select_instance "启动")
    if [ -z "$name" ]; then
        return 1
    fi
    
    if is_instance_running "$name"; then
        local info=$(get_instance_info "$name")
        local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
        print_warning "实例 '$name' 已在运行 (端口: $port)"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    
    print_info "启动实例 '$name'..."
    
    cd "$dir" || return 1
    
    # 使用 PM2 启动 (如果安装了) 或者后台启动
    if command_exists pm2; then
        pm2 start npm --name "crs-$name" -- start
        print_success "实例 '$name' 已通过 PM2 启动 (端口: $port)"
    else
        # 后台启动
        mkdir -p logs
        nohup npm start > "logs/crs-$name.log" 2>&1 &
        echo $! > "crs-$name.pid"
        print_success "实例 '$name' 已后台启动 (端口: $port)"
        print_info "日志文件: $dir/logs/crs-$name.log"
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 停止实例
stop_instance() {
    local name=$(select_instance "停止")
    if [ -z "$name" ]; then
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    
    print_info "停止实例 '$name'..."
    
    # 尝试使用 PM2 停止
    if command_exists pm2 && pm2 list | grep -q "crs-$name"; then
        pm2 stop "crs-$name"
        pm2 delete "crs-$name"
        print_success "实例 '$name' 已通过 PM2 停止"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    # 尝试通过 PID 文件停止
    if [ -f "$dir/crs-$name.pid" ]; then
        local pid=$(cat "$dir/crs-$name.pid")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
            rm -f "$dir/crs-$name.pid"
            print_success "实例 '$name' 已停止"
            echo -n "按回车键继续..."
            read
            return 0
        else
            rm -f "$dir/crs-$name.pid"
        fi
    fi
    
    # 通过端口查找并停止进程
    if command_exists lsof; then
        local pid=$(lsof -ti :$port)
        if [ -n "$pid" ]; then
            kill $pid
            print_success "实例 '$name' 已停止 (端口: $port)"
            echo -n "按回车键继续..."
            read
            return 0
        fi
    fi
    
    print_warning "实例 '$name' 似乎未在运行"
    echo -n "按回车键继续..."
    read
}

# 重启实例
restart_instance() {
    local name=$(select_instance "重启")
    if [ -z "$name" ]; then
        return 1
    fi
    
    print_info "重启实例 '$name'..."
    
    # 模拟停止（不显示菜单）
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    
    # 停止
    if command_exists pm2 && pm2 list | grep -q "crs-$name"; then
        pm2 stop "crs-$name" >/dev/null 2>&1
        pm2 delete "crs-$name" >/dev/null 2>&1
    fi
    
    if [ -f "$dir/crs-$name.pid" ]; then
        local pid=$(cat "$dir/crs-$name.pid")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
        fi
        rm -f "$dir/crs-$name.pid"
    fi
    
    if command_exists lsof; then
        local pid=$(lsof -ti :$port)
        if [ -n "$pid" ]; then
            kill $pid
        fi
    fi
    
    sleep 2
    
    # 启动
    cd "$dir" || return 1
    
    if command_exists pm2; then
        pm2 start npm --name "crs-$name" -- start
        print_success "实例 '$name' 已重启 (端口: $port)"
    else
        mkdir -p logs
        nohup npm start > "logs/crs-$name.log" 2>&1 &
        echo $! > "crs-$name.pid"
        print_success "实例 '$name' 已重启 (端口: $port)"
    fi
    
    echo -n "按回车键继续..."
    read
}

# 查看实例状态
status_instance() {
    local name=$(select_instance "查看状态")
    if [ -z "$name" ]; then
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    local redis_host=$(echo "$info" | grep "REDIS_HOST:" | cut -d: -f2)
    local redis_port=$(echo "$info" | grep "REDIS_PORT:" | cut -d: -f2)
    
    print_header
    echo
    echo -e "${BOLD}实例详细状态${NC}"
    echo "实例名称: $name"
    echo "安装目录: $dir"
    echo "服务端口: $port"
    echo "Redis: $redis_host:$redis_port"
    
    if is_instance_running "$name"; then
        echo -e "运行状态: ${GREEN}运行中${NC}"
        echo "访问地址: http://localhost:$port"
        echo "管理界面: http://localhost:$port/admin"
        echo "健康检查: http://localhost:$port/health"
        
        # 显示进程信息
        if command_exists lsof; then
            local pid=$(lsof -ti :$port)
            if [ -n "$pid" ]; then
                echo "进程ID: $pid"
                if command_exists ps; then
                    echo "内存使用: $(ps -p $pid -o rss= | xargs)KB"
                fi
            fi
        fi
        
        # 测试健康检查
        if command_exists curl; then
            echo -n "健康检查: "
            if curl -s "http://localhost:$port/health" >/dev/null; then
                echo -e "${GREEN}正常${NC}"
            else
                echo -e "${RED}异常${NC}"
            fi
        fi
    else
        echo -e "运行状态: ${RED}已停止${NC}"
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 删除实例
remove_instance() {
    local name=$(select_instance "删除")
    if [ -z "$name" ]; then
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    
    print_header
    echo
    print_warning "即将删除实例 '$name'"
    echo "安装目录: $dir"
    echo
    echo -e "${RED}${BOLD}警告：这将删除所有数据，包括配置文件和日志！${NC}"
    echo
    echo -n "确认删除？请输入 'DELETE' 确认: "
    read confirm
    
    if [ "$confirm" != "DELETE" ]; then
        print_info "删除取消"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    # 停止实例
    print_info "停止实例..."
    if command_exists pm2 && pm2 list | grep -q "crs-$name"; then
        pm2 stop "crs-$name" >/dev/null 2>&1
        pm2 delete "crs-$name" >/dev/null 2>&1
    fi
    
    if [ -f "$dir/crs-$name.pid" ]; then
        local pid=$(cat "$dir/crs-$name.pid")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
        fi
    fi
    
    # 删除目录
    print_info "删除文件..."
    rm -rf "$dir"
    
    # 从配置中移除
    unset INSTANCES[$name]
    save_instances_config
    
    print_success "实例 '$name' 已删除"
    echo -n "按回车键继续..."
    read
}

# 另外新启服务（基于现有实例）
clone_instance() {
    if [ ${#INSTANCES[@]} -eq 0 ]; then
        print_error "没有可用的实例作为模板"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    print_header
    echo
    print_info "基于现有实例创建新服务..."
    
    # 选择模板实例
    echo -e "${BOLD}选择模板实例：${NC}"
    local template_name=$(select_instance "作为模板")
    if [ -z "$template_name" ]; then
        return 1
    fi
    
    local template_info=$(get_instance_info "$template_name")
    local template_dir=$(echo "$template_info" | grep "DIR:" | cut -d: -f2)
    
    # 获取新实例名称
    while true; do
        echo -n "新实例名称: "
        read new_name
        
        if [ -z "$new_name" ]; then
            print_error "实例名称不能为空"
            continue
        fi
        
        if ! validate_instance_name "$new_name"; then
            continue
        fi
        
        if instance_exists "$new_name"; then
            print_error "实例 '$new_name' 已存在"
            continue
        fi
        
        break
    done
    
    # 获取新端口
    local suggested_port=$(get_next_available_port $DEFAULT_BASE_PORT)
    echo -n "新服务端口 (建议: $suggested_port): "
    read new_port
    new_port=${new_port:-$suggested_port}
    
    # 验证端口
    if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [ "$new_port" -lt 1024 ] || [ "$new_port" -gt 65535 ]; then
        print_error "端口必须是 1024-65535 之间的数字"
        echo -n "按回车键继续..."
        read
        return 1
    fi
    
    if check_port $new_port; then
        print_warning "端口 $new_port 已被占用"
        echo -n "是否继续？(y/N): "
        read -n 1 continue_clone
        echo
        if [[ ! "$continue_clone" =~ ^[Yy]$ ]]; then
            echo -n "按回车键继续..."
            read
            return 1
        fi
    fi
    
    # Redis 配置
    echo -n "Redis 主机 (默认: $DEFAULT_REDIS_HOST): "
    read redis_host
    redis_host=${redis_host:-$DEFAULT_REDIS_HOST}
    
    echo -n "Redis 端口 (默认: $DEFAULT_REDIS_PORT): "
    read redis_port
    redis_port=${redis_port:-$DEFAULT_REDIS_PORT}
    
    echo -n "Redis 密码 (可选，直接回车跳过): "
    read redis_password
    
    # 设置新实例目录
    local base_dir=$(dirname "$template_dir")
    local new_dir="$base_dir/$new_name"
    
    # 确认信息
    echo
    print_info "克隆配置确认："
    echo "  模板实例: $template_name"
    echo "  新实例名: $new_name"
    echo "  新端口: $new_port"
    echo "  新目录: $new_dir"
    echo "  Redis: $redis_host:$redis_port"
    echo
    echo -n "确认创建？(y/N): "
    read -n 1 confirm
    echo
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_info "创建取消"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    # 开始克隆
    print_info "复制实例文件..."
    cp -r "$template_dir" "$new_dir"
    
    cd "$new_dir" || {
        print_error "无法进入新实例目录"
        echo -n "按回车键继续..."
        read
        return 1
    }
    
    # 生成新的密钥
    local new_jwt_secret=$(generate_random_string 64)
    local new_encryption_key=$(generate_random_string 32)
    
    # 更新配置文件
    print_info "更新配置文件..."
    
    # 更新 .env 文件
    sed -i.bak "s/^PORT=.*/PORT=$new_port/" .env
    sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$new_jwt_secret/" .env
    sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$new_encryption_key/" .env
    sed -i "s/^REDIS_HOST=.*/REDIS_HOST=$redis_host/" .env
    sed -i "s/^REDIS_PORT=.*/REDIS_PORT=$redis_port/" .env
    
    if [ -n "$redis_password" ]; then
        if grep -q "^REDIS_PASSWORD=" .env; then
            sed -i "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$redis_password/" .env
        else
            echo "REDIS_PASSWORD=$redis_password" >> .env
        fi
    else
        sed -i "/^REDIS_PASSWORD=/d" .env
    fi
    
    # 删除备份文件
    rm -f .env.bak
    
    # 清理旧的运行文件
    rm -f crs-*.pid
    rm -rf logs/*
    
    # 重新运行初始化（生成新的管理员账户等）
    print_info "初始化新实例..."
    npm run setup
    
    # 保存实例配置
    INSTANCES[$new_name]="$new_dir:$new_port:$redis_host:$redis_port"
    save_instances_config
    
    print_success "新实例 '$new_name' 创建完成！"
    echo
    print_info "实例信息："
    echo "  访问地址: http://localhost:$new_port"
    echo "  管理界面: http://localhost:$new_port/admin"
    echo
    echo -n "是否立即启动新实例？(y/N): "
    read -n 1 start_now
    echo
    
    if [[ "$start_now" =~ ^[Yy]$ ]]; then
        print_info "启动新实例..."
        if command_exists pm2; then
            pm2 start npm --name "crs-$new_name" -- start
        else
            mkdir -p logs
            nohup npm start > "logs/crs-$new_name.log" 2>&1 &
            echo $! > "crs-$new_name.pid"
        fi
        print_success "新实例已启动！"
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 主菜单循环
main_menu() {
    while true; do
        print_header
        print_menu
        
        echo -n "请输入选项 (0-9): "
        read choice
        
        case $choice in
            1)
                install_instance
                ;;
            2)
                list_instances
                ;;
            3)
                start_instance
                ;;
            4)
                stop_instance
                ;;
            5)
                restart_instance
                ;;
            6)
                status_instance
                ;;
            7)
                remove_instance
                ;;
            8)
                install_redis
                ;;
            9)
                clone_instance
                ;;
            0)
                print_info "再见！"
                exit 0
                ;;
            *)
                print_error "无效选项，请重新选择"
                sleep 1
                ;;
        esac
    done
}

# 主函数
main() {
    # 检测操作系统
    detect_os
    
    # 加载实例配置
    load_instances_config
    
    # 如果有命令行参数，执行对应命令
    if [ $# -gt 0 ]; then
        case "$1" in
            install)
                install_instance
                ;;
            list)
                list_instances
                ;;
            start)
                if [ -n "$2" ]; then
                    # 直接启动指定实例
                    if instance_exists "$2"; then
                        # 模拟选择过程
                        INSTANCES_TEMP=("$2")
                        start_instance
                    else
                        print_error "实例 '$2' 不存在"
                    fi
                else
                    start_instance
                fi
                ;;
            stop)
                if [ -n "$2" ]; then
                    if instance_exists "$2"; then
                        INSTANCES_TEMP=("$2")
                        stop_instance
                    else
                        print_error "实例 '$2' 不存在"
                    fi
                else
                    stop_instance
                fi
                ;;
            restart)
                if [ -n "$2" ]; then
                    if instance_exists "$2"; then
                        INSTANCES_TEMP=("$2")
                        restart_instance
                    else
                        print_error "实例 '$2' 不存在"
                    fi
                else
                    restart_instance
                fi
                ;;
            status)
                if [ -n "$2" ]; then
                    if instance_exists "$2"; then
                        INSTANCES_TEMP=("$2")
                        status_instance
                    else
                        print_error "实例 '$2' 不存在"
                    fi
                else
                    status_instance
                fi
                ;;
            remove)
                if [ -n "$2" ]; then
                    if instance_exists "$2"; then
                        INSTANCES_TEMP=("$2")
                        remove_instance
                    else
                        print_error "实例 '$2' 不存在"
                    fi
                else
                    remove_instance
                fi
                ;;
            redis)
                install_redis
                ;;
            clone)
                clone_instance
                ;;
            menu|--menu|-m)
                main_menu
                ;;
            help|--help|-h)
                print_header
                echo
                echo "用法: $0 [命令] [参数]"
                echo
                echo "命令:"
                echo "  install              安装新实例"
                echo "  list                 列出所有实例"
                echo "  start [实例名]       启动实例"
                echo "  stop [实例名]        停止实例"
                echo "  restart [实例名]     重启实例"
                echo "  status [实例名]      查看实例状态"
                echo "  remove [实例名]      删除实例"
                echo "  redis               安装/配置 Redis"
                echo "  clone               基于现有实例创建新服务"
                echo "  menu                进入交互式菜单"
                echo "  help                显示此帮助信息"
                echo
                echo "示例:"
                echo "  $0 menu                    # 进入交互式菜单（推荐）"
                echo "  $0 install                 # 安装新实例"
                echo "  $0 start main              # 启动名为 'main' 的实例"
                echo "  $0 list                    # 列出所有实例"
                echo
                ;;
            *)
                print_error "未知命令: $1"
                echo "使用 '$0 help' 查看帮助信息"
                echo "或使用 '$0 menu' 进入交互式菜单"
                exit 1
                ;;
        esac
    else
        # 无参数时进入交互式菜单
        main_menu
    fi
}

# 运行主函数
main "$@"