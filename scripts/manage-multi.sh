#!/bin/bash

# Claude Relay Service 多实例管理脚本
# 支持在同一服务器上部署多个服务实例
# 使用不同端口和实例名称进行区分

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
    echo -e "${BOLD}${MAGENTA}========================================${NC}"
    echo -e "${BOLD}${MAGENTA}  Claude Relay Service 多实例管理${NC}"
    echo -e "${BOLD}${MAGENTA}========================================${NC}"
}

# 检测操作系统
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ -f /etc/debian_version ]; then
            OS="debian"
            PACKAGE_MANAGER="apt-get"
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

# 列出所有实例
list_instances() {
    print_header
    echo
    
    if [ ${#INSTANCES[@]} -eq 0 ]; then
        print_info "未找到已安装的实例"
        echo
        print_info "使用 'manage-multi.sh install' 安装新实例"
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
        return 1
    fi
    
    if check_port $APP_PORT; then
        print_warning "端口 $APP_PORT 已被占用"
        echo -n "是否继续？(y/N): "
        read -n 1 continue_install
        echo
        if [[ ! "$continue_install" =~ ^[Yy]$ ]]; then
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
        return 0
    fi
    
    # 开始安装
    print_info "创建实例目录..."
    mkdir -p "$INSTANCE_DIR"
    
    print_info "克隆项目代码..."
    if ! git clone https://github.com/hging/claude-relay-service.git "$INSTANCE_DIR" --depth 1; then
        print_error "克隆项目失败"
        rm -rf "$INSTANCE_DIR"
        return 1
    fi
    
    # 进入项目目录
    cd "$INSTANCE_DIR" || return 1
    
    # 安装依赖
    print_info "安装 Node.js 依赖..."
    if ! npm install; then
        print_error "安装依赖失败"
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
        return 1
    fi
    
    # 保存实例配置
    INSTANCES[$INSTANCE_NAME]="$INSTANCE_DIR:$APP_PORT:$REDIS_HOST:$REDIS_PORT"
    save_instances_config
    
    print_success "实例 '$INSTANCE_NAME' 安装完成！"
    echo
    print_info "使用以下命令管理实例："
    echo "  启动: manage-multi.sh start $INSTANCE_NAME"
    echo "  停止: manage-multi.sh stop $INSTANCE_NAME"
    echo "  状态: manage-multi.sh status $INSTANCE_NAME"
    echo "  访问: http://localhost:$APP_PORT"
    echo
}

# 启动实例
start_instance() {
    local name=$1
    
    if [ -z "$name" ]; then
        print_error "请指定实例名称"
        echo "用法: manage-multi.sh start <实例名称>"
        return 1
    fi
    
    if ! instance_exists "$name"; then
        print_error "实例 '$name' 不存在"
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    
    if is_instance_running "$name"; then
        print_warning "实例 '$name' 已在运行 (端口: $port)"
        return 0
    fi
    
    print_info "启动实例 '$name'..."
    
    cd "$dir" || return 1
    
    # 使用 PM2 启动 (如果安装了) 或者后台启动
    if command_exists pm2; then
        pm2 start npm --name "crs-$name" -- start
        print_success "实例 '$name' 已通过 PM2 启动 (端口: $port)"
    else
        # 后台启动
        nohup npm start > "logs/crs-$name.log" 2>&1 &
        echo $! > "crs-$name.pid"
        print_success "实例 '$name' 已后台启动 (端口: $port)"
        print_info "日志文件: $dir/logs/crs-$name.log"
    fi
}

# 停止实例
stop_instance() {
    local name=$1
    
    if [ -z "$name" ]; then
        print_error "请指定实例名称"
        echo "用法: manage-multi.sh stop <实例名称>"
        return 1
    fi
    
    if ! instance_exists "$name"; then
        print_error "实例 '$name' 不存在"
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
        return 0
    fi
    
    # 尝试通过 PID 文件停止
    if [ -f "$dir/crs-$name.pid" ]; then
        local pid=$(cat "$dir/crs-$name.pid")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
            rm -f "$dir/crs-$name.pid"
            print_success "实例 '$name' 已停止"
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
            return 0
        fi
    fi
    
    print_warning "实例 '$name' 似乎未在运行"
}

# 重启实例
restart_instance() {
    local name=$1
    
    if [ -z "$name" ]; then
        print_error "请指定实例名称"
        echo "用法: manage-multi.sh restart <实例名称>"
        return 1
    fi
    
    stop_instance "$name"
    sleep 2
    start_instance "$name"
}

# 查看实例状态
status_instance() {
    local name=$1
    
    if [ -z "$name" ]; then
        # 显示所有实例状态
        list_instances
        return 0
    fi
    
    if ! instance_exists "$name"; then
        print_error "实例 '$name' 不存在"
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    local port=$(echo "$info" | grep "PORT:" | cut -d: -f2)
    local redis_host=$(echo "$info" | grep "REDIS_HOST:" | cut -d: -f2)
    local redis_port=$(echo "$info" | grep "REDIS_PORT:" | cut -d: -f2)
    
    print_header
    echo
    echo "实例名称: $name"
    echo "安装目录: $dir"
    echo "服务端口: $port"
    echo "Redis: $redis_host:$redis_port"
    
    if is_instance_running "$name"; then
        echo -e "运行状态: ${GREEN}运行中${NC}"
        echo "访问地址: http://localhost:$port"
        
        # 显示进程信息
        if command_exists lsof; then
            local pid=$(lsof -ti :$port)
            if [ -n "$pid" ]; then
                echo "进程ID: $pid"
            fi
        fi
    else
        echo -e "运行状态: ${RED}已停止${NC}"
    fi
    
    echo
}

# 删除实例
remove_instance() {
    local name=$1
    
    if [ -z "$name" ]; then
        print_error "请指定实例名称"
        echo "用法: manage-multi.sh remove <实例名称>"
        return 1
    fi
    
    if ! instance_exists "$name"; then
        print_error "实例 '$name' 不存在"
        return 1
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | grep "DIR:" | cut -d: -f2)
    
    print_warning "即将删除实例 '$name'"
    echo "安装目录: $dir"
    echo
    echo -n "确认删除？这将删除所有数据！(y/N): "
    read -n 1 confirm
    echo
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_info "删除取消"
        return 0
    fi
    
    # 停止实例
    print_info "停止实例..."
    stop_instance "$name"
    
    # 删除目录
    print_info "删除文件..."
    rm -rf "$dir"
    
    # 从配置中移除
    unset INSTANCES[$name]
    save_instances_config
    
    print_success "实例 '$name' 已删除"
}

# 显示帮助信息
show_help() {
    print_header
    echo
    echo "用法: manage-multi.sh <命令> [参数]"
    echo
    echo "命令:"
    echo "  install              安装新实例"
    echo "  list                 列出所有实例"
    echo "  start <实例名>       启动实例"
    echo "  stop <实例名>        停止实例"
    echo "  restart <实例名>     重启实例"
    echo "  status [实例名]      查看实例状态"
    echo "  remove <实例名>      删除实例"
    echo "  help                 显示此帮助信息"
    echo
    echo "示例:"
    echo "  manage-multi.sh install          # 安装新实例"
    echo "  manage-multi.sh list             # 列出所有实例"
    echo "  manage-multi.sh start main       # 启动名为 'main' 的实例"
    echo "  manage-multi.sh status           # 查看所有实例状态"
    echo
}

# 主函数
main() {
    # 检测操作系统
    detect_os
    
    # 加载实例配置
    load_instances_config
    
    # 处理命令
    case "$1" in
        install)
            install_instance
            ;;
        list)
            list_instances
            ;;
        start)
            start_instance "$2"
            ;;
        stop)
            stop_instance "$2"
            ;;
        restart)
            restart_instance "$2"
            ;;
        status)
            status_instance "$2"
            ;;
        remove)
            remove_instance "$2"
            ;;
        help|--help|-h|"")
            show_help
            ;;
        *)
            print_error "未知命令: $1"
            echo
            show_help
            exit 1
            ;;
    esac
}

# 运行主函数
main "$@"