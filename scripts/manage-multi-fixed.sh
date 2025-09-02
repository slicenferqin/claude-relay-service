#!/bin/bash

# Claude Relay Service 多实例管理脚本 - 修复版
# 解决了原脚本在Linux系统上的兼容性问题

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
MAGENTA='\033[0;35m'
GRAY='\033[0;37m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# 默认配置
DEFAULT_BASE_DIR="$HOME/claude-relay-instances"
DEFAULT_REDIS_HOST="localhost"
DEFAULT_REDIS_PORT="6379"
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

# 检测操作系统
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ -f /etc/debian_version ]; then
            OS="debian"
            PACKAGE_MANAGER="apt"
        elif [ -f /etc/redhat-release ]; then
            OS="redhat"
            PACKAGE_MANAGER="yum"
        else
            OS="linux"
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        PACKAGE_MANAGER="brew"
    else
        OS="unknown"
    fi
}

# 打印函数
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
    echo -e "${BOLD}${MAGENTA} Claude Relay Service 多实例管理${NC}"
    echo -e "${BOLD}${MAGENTA}==========================================${NC}"
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 检查端口是否被占用（简化版）
check_port() {
    local port=$1
    # 使用nc命令快速检查端口
    if command_exists nc; then
        nc -z localhost "$port" 2>/dev/null
        return $?
    fi
    # 备选方案
    if command_exists lsof; then
        lsof -i ":$port" >/dev/null 2>&1
        return $?
    fi
    return 1
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
        port=$((port + 1))
        if [ $port -gt 65535 ]; then
            print_error "无法找到可用端口"
            return 1
        fi
    done
    
    echo $port
}

# 加载实例配置
load_instances_config() {
    if [ ! -f "$INSTANCES_CONFIG_FILE" ]; then
        touch "$INSTANCES_CONFIG_FILE"
    fi
}

# 获取所有实例
get_all_instances() {
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        cat "$INSTANCES_CONFIG_FILE" | grep -v '^$' | grep -v '^#'
    fi
}

# 获取实例数量
get_instances_count() {
    get_all_instances | wc -l | tr -d ' '
}

# 添加实例配置
add_instance_config() {
    local name=$1
    local dir=$2
    local port=$3
    local redis_host=$4
    local redis_port=$5
    
    # 删除旧配置（如果存在）
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -v "^$name|" "$INSTANCES_CONFIG_FILE" > "$INSTANCES_CONFIG_FILE.tmp" || true
        mv "$INSTANCES_CONFIG_FILE.tmp" "$INSTANCES_CONFIG_FILE"
    fi
    
    # 添加新配置
    echo "$name|$dir|$port|$redis_host|$redis_port" >> "$INSTANCES_CONFIG_FILE"
}

# 删除实例配置
remove_instance_config() {
    local name=$1
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -v "^$name|" "$INSTANCES_CONFIG_FILE" > "$INSTANCES_CONFIG_FILE.tmp" || true
        mv "$INSTANCES_CONFIG_FILE.tmp" "$INSTANCES_CONFIG_FILE"
    fi
}

# 获取实例信息
get_instance_info() {
    local name=$1
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep "^$name|" "$INSTANCES_CONFIG_FILE" | head -1
    fi
}

# 检查实例是否存在
instance_exists() {
    local name=$1
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -q "^$name|" "$INSTANCES_CONFIG_FILE"
        return $?
    fi
    return 1
}

# 检查实例是否在运行（简化版）
is_instance_running() {
    local name=$1
    local info=$(get_instance_info "$name")
    
    if [ -z "$info" ]; then
        return 1
    fi
    
    local port=$(echo "$info" | cut -d'|' -f3)
    if [ -z "$port" ]; then
        return 1
    fi
    
    check_port "$port"
}

# 列出所有实例
list_instances() {
    print_header
    echo
    
    local count=$(get_instances_count)
    if [ "$count" -eq 0 ]; then
        print_info "未找到已安装的实例"
        echo
        print_info "使用选项 1 安装新实例"
    else
        printf "%-20s %-8s %-30s %-10s %s\n" "实例名称" "端口" "目录" "状态" "Redis"
        printf "%-20s %-8s %-30s %-10s %s\n" "--------" "----" "----" "----" "-----"
        
        get_all_instances | while IFS='|' read -r name dir port redis_host redis_port; do
            local status="已停止"
            if is_instance_running "$name"; then
                status="运行中"
            fi
            
            local short_dir=$(basename "$dir")
            printf "%-20s %-8s %-30s %-10s %s:%s\n" \
                "$name" "$port" "$short_dir" "$status" "$redis_host" "$redis_port"
        done
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 选择实例（简化版）
select_instance() {
    local action=$1
    local count=$(get_instances_count)
    
    if [ "$count" -eq 0 ]; then
        print_warning "没有可用的实例"
        return 1
    fi
    
    clear
    print_header
    echo
    echo -e "${BOLD}请选择要${action}的实例：${NC}"
    echo
    
    local i=1
    local instance_names=""
    
    get_all_instances | while IFS='|' read -r name dir port redis_host redis_port; do
        echo "  $i. $name (端口:$port)"
        if [ $i -eq 1 ]; then
            instance_names="$name"
        else
            instance_names="$instance_names|$name"
        fi
        i=$((i + 1))
    done > /tmp/instance_list.tmp
    
    cat /tmp/instance_list.tmp
    rm -f /tmp/instance_list.tmp
    
    echo
    echo -n "请选择实例 (输入数字，按0取消): "
    read choice
    
    if [ "$choice" = "0" ]; then
        return 1
    fi
    
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
        print_error "无效选择"
        sleep 2
        return 1
    fi
    
    # 获取选中的实例名
    local selected=$(get_all_instances | sed -n "${choice}p" | cut -d'|' -f1)
    echo "$selected"
}

# 安装新实例
install_instance() {
    print_header
    echo
    print_info "开始安装新的 Claude Relay Service 实例..."
    
    # 获取实例名称
    while true; do
        echo -n "实例名称 (例如: main, test): "
        read INSTANCE_NAME
        
        if [ -z "$INSTANCE_NAME" ]; then
            print_error "实例名称不能为空"
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
    
    # Redis 配置
    echo -n "Redis 主机 (默认: $DEFAULT_REDIS_HOST): "
    read input
    REDIS_HOST=${input:-$DEFAULT_REDIS_HOST}
    
    echo -n "Redis 端口 (默认: $DEFAULT_REDIS_PORT): "
    read input
    REDIS_PORT=${input:-$DEFAULT_REDIS_PORT}
    
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

# 日志级别
LOG_LEVEL=info
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
    add_instance_config "$INSTANCE_NAME" "$INSTANCE_DIR" "$APP_PORT" "$REDIS_HOST" "$REDIS_PORT"
    
    print_success "实例 '$INSTANCE_NAME' 安装完成！"
    echo
    print_info "实例信息："
    echo "  访问地址: http://localhost:$APP_PORT"
    echo "  管理界面: http://localhost:$APP_PORT/admin"
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
        print_warning "实例 '$name' 已在运行"
        echo -n "按回车键继续..."
        read
        return 0
    fi
    
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | cut -d'|' -f2)
    local port=$(echo "$info" | cut -d'|' -f3)
    
    print_info "启动实例 '$name'..."
    
    cd "$dir" || return 1
    
    # 使用 nohup 后台启动
    mkdir -p logs
    nohup npm start > "logs/crs-$name.log" 2>&1 &
    local pid=$!
    echo $pid > "crs-$name.pid"
    
    sleep 3
    
    if is_instance_running "$name"; then
        print_success "实例 '$name' 已启动 (端口: $port, PID: $pid)"
    else
        print_error "实例启动失败，请查看日志: $dir/logs/crs-$name.log"
    fi
    
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
    local dir=$(echo "$info" | cut -d'|' -f2)
    local port=$(echo "$info" | cut -d'|' -f3)
    
    print_info "停止实例 '$name'..."
    
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
            print_success "实例 '$name' 已停止"
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
    
    # 先停止
    local info=$(get_instance_info "$name")
    local dir=$(echo "$info" | cut -d'|' -f2)
    local port=$(echo "$info" | cut -d'|' -f3)
    
    if [ -f "$dir/crs-$name.pid" ]; then
        local pid=$(cat "$dir/crs-$name.pid")
        if kill -0 $pid 2>/dev/null; then
            kill $pid
        fi
        rm -f "$dir/crs-$name.pid"
    fi
    
    sleep 2
    
    # 再启动
    cd "$dir" || return 1
    mkdir -p logs
    nohup npm start > "logs/crs-$name.log" 2>&1 &
    local pid=$!
    echo $pid > "crs-$name.pid"
    
    sleep 3
    
    if is_instance_running "$name"; then
        print_success "实例 '$name' 已重启 (端口: $port, PID: $pid)"
    else
        print_error "实例重启失败"
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
    local dir=$(echo "$info" | cut -d'|' -f2)
    local port=$(echo "$info" | cut -d'|' -f3)
    local redis_host=$(echo "$info" | cut -d'|' -f4)
    local redis_port=$(echo "$info" | cut -d'|' -f5)
    
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
        
        # 显示进程信息
        if [ -f "$dir/crs-$name.pid" ]; then
            local pid=$(cat "$dir/crs-$name.pid")
            if kill -0 $pid 2>/dev/null; then
                echo "进程ID: $pid"
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
    local dir=$(echo "$info" | cut -d'|' -f2)
    
    print_header
    echo
    print_warning "即将删除实例 '$name'"
    echo "安装目录: $dir"
    echo
    echo -e "${RED}${BOLD}警告：这将删除所有数据！${NC}"
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
    remove_instance_config "$name"
    
    print_success "实例 '$name' 已删除"
    echo -n "按回车键继续..."
    read
}

# 安装Redis（简化版）
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
                sudo yum install redis -y
                ;;
            "macos")
                brew install redis
                ;;
            *)
                print_error "请手动安装 Redis"
                echo -n "按回车键继续..."
                read
                return 1
                ;;
        esac
        
        if ! command_exists redis-server; then
            print_error "Redis 安装失败"
            echo -n "按回车键继续..."
            read
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
    
    if [ "$redis_port" = "6379" ]; then
        # 使用默认配置
        print_info "启动默认 Redis 服务..."
        
        if [[ "$OS" == "debian" ]]; then
            sudo systemctl enable redis-server
            sudo systemctl start redis-server
        elif [[ "$OS" == "redhat" ]]; then
            sudo systemctl enable redis
            sudo systemctl start redis
        elif [[ "$OS" == "macos" ]]; then
            brew services start redis
        fi
        
        sleep 2
        
        if redis-cli ping >/dev/null 2>&1; then
            print_success "Redis 服务已启动 (端口: 6379)"
        else
            print_error "Redis 启动失败"
        fi
    else
        # 自定义端口配置
        print_info "配置自定义 Redis 端口..."
        
        local config_dir="/etc/redis-$redis_port"
        local data_dir="/var/lib/redis-$redis_port"
        
        sudo mkdir -p "$config_dir" "$data_dir"
        
        # 创建配置文件
        sudo tee "$config_dir/redis.conf" > /dev/null <<EOF
port $redis_port
bind 127.0.0.1
protected-mode yes
dir $data_dir
pidfile /var/run/redis-$redis_port.pid
logfile /var/log/redis-$redis_port.log
EOF
        
        # 启动 Redis
        sudo redis-server "$config_dir/redis.conf" --daemonize yes
        
        sleep 2
        
        if redis-cli -p $redis_port ping >/dev/null 2>&1; then
            print_success "Redis 实例已启动 (端口: $redis_port)"
        else
            print_error "Redis 实例启动失败"
        fi
    fi
    
    echo
    echo -n "按回车键继续..."
    read
}

# 打印菜单
print_menu() {
    echo
    local total_instances=$(get_instances_count)
    
    echo -e "${BOLD}${BLUE}请选择操作：${NC} (已安装实例: $total_instances)"
    echo "  1. 📦 安装新实例"
    echo "  2. 📋 列出所有实例"
    echo "  3. 🚀 启动实例"
    echo "  4. ⏹️  停止实例"
    echo "  5. 🔄 重启实例"
    echo "  6. 📊 查看实例状态"
    echo "  7. 🗑️  删除实例"
    echo "  8. 🔧 安装/配置 Redis"
    echo "  0. ❌ 退出"
    echo
}

# 主菜单循环
main_menu() {
    while true; do
        print_header
        print_menu
        
        echo -n "请输入选项 (0-8): "
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
    
    # 进入交互式菜单
    main_menu
}

# 运行主函数
main "$@"