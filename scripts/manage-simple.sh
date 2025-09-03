#!/bin/bash

# Claude Relay Service 极简管理脚本
# 保证在Ubuntu上100%可靠工作

# 配置文件
CONFIG_FILE="$HOME/.crs-instances"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 初始化配置文件
[ ! -f "$CONFIG_FILE" ] && touch "$CONFIG_FILE"

# 函数：列出实例
list_instances() {
    echo "========== 实例列表 =========="
    if [ ! -s "$CONFIG_FILE" ]; then
        echo "没有实例"
    else
        echo "名称          端口    目录"
        echo "----          ----    ----"
        while IFS='|' read -r name dir port redis_host redis_port; do
            [ -z "$name" ] && continue
            echo "$name          $port    $dir"
        done < "$CONFIG_FILE"
    fi
    echo "=============================="
}

# 函数：添加实例
add_instance() {
    echo "========== 添加实例 =========="
    
    echo -n "实例名称: "
    read name
    [ -z "$name" ] && { echo -e "${RED}名称不能为空${NC}"; return 1; }
    
    # 检查是否已存在
    if grep -q "^$name|" "$CONFIG_FILE" 2>/dev/null; then
        echo -e "${RED}实例已存在${NC}"
        return 1
    fi
    
    echo -n "安装目录 (默认: $HOME/crs-$name): "
    read dir
    dir=${dir:-"$HOME/crs-$name"}
    
    echo -n "服务端口 (默认: 3000): "
    read port
    port=${port:-3000}
    
    echo -n "Redis主机 (默认: localhost): "
    read redis_host
    redis_host=${redis_host:-localhost}
    
    echo -n "Redis端口 (默认: 6379): "
    read redis_port
    redis_port=${redis_port:-6379}
    
    # 保存配置
    echo "$name|$dir|$port|$redis_host|$redis_port" >> "$CONFIG_FILE"
    
    echo -e "${GREEN}实例 $name 已添加${NC}"
    echo "=============================="
}

# 函数：删除实例
delete_instance() {
    echo "========== 删除实例 =========="
    
    if [ ! -s "$CONFIG_FILE" ]; then
        echo "没有实例可删除"
        return 1
    fi
    
    # 显示实例列表
    echo "可删除的实例："
    local i=1
    while IFS='|' read -r name dir port redis_host redis_port; do
        [ -z "$name" ] && continue
        echo "  $i. $name (端口: $port)"
        i=$((i+1))
    done < "$CONFIG_FILE"
    
    echo -n "选择要删除的实例编号: "
    read choice
    
    # 验证输入
    if ! [[ "$choice" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}无效的选择${NC}"
        return 1
    fi
    
    # 获取要删除的实例信息
    local instance_info=$(sed -n "${choice}p" "$CONFIG_FILE")
    if [ -z "$instance_info" ]; then
        echo -e "${RED}无效的选择${NC}"
        return 1
    fi
    
    IFS='|' read -r target_name dir port redis_host redis_port <<< "$instance_info"
    
    echo -e "${YELLOW}警告：删除实例将会：${NC}"
    echo "1. 停止正在运行的服务"
    echo "2. 删除实例配置"
    echo "3. 不会删除安装目录和数据"
    echo
    echo -n "确认删除 $target_name? (输入 DELETE 确认): "
    read confirm
    
    if [ "$confirm" = "DELETE" ]; then
        # 先停止实例
        echo "正在停止实例 $target_name..."
        stop_instance_by_name "$target_name" "$port"
        
        # 删除配置
        grep -v "^$target_name|" "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
        echo -e "${GREEN}实例 $target_name 已删除${NC}"
    else
        echo "取消删除"
    fi
    
    echo "=============================="
}

# 函数：启动实例（简单版）
start_instance() {
    echo "========== 启动实例 =========="
    
    if [ ! -s "$CONFIG_FILE" ]; then
        echo "没有实例可启动"
        return 1
    fi
    
    # 显示实例列表
    echo "可启动的实例："
    local i=1
    while IFS='|' read -r name dir port redis_host redis_port; do
        [ -z "$name" ] && continue
        echo "  $i. $name (端口:$port)"
        i=$((i+1))
    done < "$CONFIG_FILE"
    
    echo -n "选择要启动的实例编号: "
    read choice
    
    # 获取实例信息
    local instance_info=$(sed -n "${choice}p" "$CONFIG_FILE")
    if [ -z "$instance_info" ]; then
        echo -e "${RED}无效的选择${NC}"
        return 1
    fi
    
    IFS='|' read -r name dir port redis_host redis_port <<< "$instance_info"
    
    echo "启动实例: $name"
    echo "目录: $dir"
    echo "端口: $port"
    
    if [ ! -d "$dir" ]; then
        echo -e "${RED}目录不存在: $dir${NC}"
        echo "请先正确安装实例"
        return 1
    fi
    
    cd "$dir" || { echo -e "${RED}无法进入目录${NC}"; return 1; }
    
    # 检查前端是否已构建
    if [ ! -d "web/admin-spa/dist" ]; then
        echo -e "${YELLOW}检测到前端未构建，正在构建...${NC}"
        if [ -d "web/admin-spa" ]; then
            cd web/admin-spa
            npm install
            npm run build
            cd ../..
            echo -e "${GREEN}前端构建完成${NC}"
        fi
    fi
    
    # 启动命令（获取真实的Node.js PID）
    echo "正在启动..."
    
    # 先启动服务
    nohup npm start > /tmp/crs-$name.log 2>&1 &
    local npm_pid=$!
    
    # 等待Node.js进程启动并获取真实PID
    sleep 3
    local node_pid=""
    
    # 尝试通过端口找到Node.js进程
    for i in {1..5}; do
        node_pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d'/' -f1 | head -1)
        if [ -n "$node_pid" ] && [ "$node_pid" != "-" ]; then
            break
        fi
        sleep 1
    done
    
    # 如果通过端口找不到，尝试通过进程树查找
    if [ -z "$node_pid" ] || [ "$node_pid" = "-" ]; then
        node_pid=$(pgrep -P $npm_pid node 2>/dev/null | head -1)
    fi
    
    # 保存真实的Node.js PID或npm PID
    if [ -n "$node_pid" ] && [ "$node_pid" != "-" ]; then
        echo $node_pid > /tmp/crs-$name.pid
        echo -e "${GREEN}实例 $name 已启动 (Node.js PID: $node_pid, npm PID: $npm_pid)${NC}"
    else
        echo $npm_pid > /tmp/crs-$name.pid
        echo -e "${YELLOW}实例 $name 已启动 (npm PID: $npm_pid, 无法获取Node.js PID)${NC}"
    fi
    
    # 验证服务是否正常运行
    if netstat -tln 2>/dev/null | grep -q ":$port "; then
        echo -e "${GREEN}✓ 服务正在监听端口 $port${NC}"
        echo "访问地址: http://localhost:$port/admin-next/"
        echo "API地址: http://localhost:$port/api"
    else
        echo -e "${RED}✗ 服务未能监听端口 $port${NC}"
        echo "请检查日志: tail -f /tmp/crs-$name.log"
    fi
    
    echo "日志文件: /tmp/crs-$name.log"
    
    echo "=============================="
}

# 函数：通过名称和端口停止实例（内部使用）
stop_instance_by_name() {
    local name="$1"
    local port="$2"
    local force_kill="${3:-false}"
    
    local stopped=false
    
    # 方法1: 通过PID文件停止
    if [ -f "/tmp/crs-$name.pid" ]; then
        local pid=$(cat /tmp/crs-$name.pid)
        if kill -0 $pid 2>/dev/null; then
            if [ "$force_kill" = "true" ]; then
                kill -9 $pid 2>/dev/null
            else
                kill $pid 2>/dev/null
            fi
            sleep 2
            if ! kill -0 $pid 2>/dev/null; then
                echo "  ✓ 已通过PID ($pid) 停止进程"
                rm -f /tmp/crs-$name.pid
                stopped=true
            fi
        else
            rm -f /tmp/crs-$name.pid
        fi
    fi
    
    # 方法2: 通过端口查找进程（使用netstat，更通用）
    if [ "$stopped" = "false" ]; then
        echo "  尝试通过端口 $port 查找进程..."
        local pids=$(netstat -tlnp 2>/dev/null | grep ":$port " | awk '{print $7}' | cut -d'/' -f1 | grep -v '^-$' | sort -u)
        if [ -n "$pids" ]; then
            for pid in $pids; do
                if [ -n "$pid" ] && kill -0 $pid 2>/dev/null; then
                    # 检查是否是node进程
                    if ps -p $pid -o comm= 2>/dev/null | grep -q "node"; then
                        if [ "$force_kill" = "true" ]; then
                            kill -9 $pid 2>/dev/null
                        else
                            kill $pid 2>/dev/null
                        fi
                        echo "  ✓ 已停止端口 $port 上的node进程 (PID: $pid)"
                        stopped=true
                    fi
                fi
            done
        fi
    fi
    
    # 方法3: 如果有lsof命令，使用lsof（备用方案）
    if [ "$stopped" = "false" ] && command -v lsof >/dev/null 2>&1; then
        local pids=$(lsof -t -i:$port 2>/dev/null)
        if [ -n "$pids" ]; then
            for pid in $pids; do
                if [ -n "$pid" ] && kill -0 $pid 2>/dev/null; then
                    if [ "$force_kill" = "true" ]; then
                        kill -9 $pid 2>/dev/null
                    else
                        kill $pid 2>/dev/null
                    fi
                    echo "  ✓ 已停止端口 $port 上的进程 (PID: $pid)"
                    stopped=true
                fi
            done
        fi
    fi
    
    # 等待确认停止
    if [ "$stopped" = "true" ]; then
        sleep 1
        # 再次检查端口是否真的被释放
        if netstat -tln 2>/dev/null | grep -q ":$port "; then
            echo "  ⚠ 端口 $port 仍被占用"
            return 1
        else
            echo "  ✓ 端口 $port 已释放"
            return 0
        fi
    else
        echo "  ✗ 没有找到运行在端口 $port 的进程"
        return 1
    fi
}

# 函数：停止实例
stop_instance() {
    echo "========== 停止实例 =========="
    
    if [ ! -s "$CONFIG_FILE" ]; then
        echo "没有实例"
        return 1
    fi
    
    # 显示实例列表
    echo "可停止的实例："
    local i=1
    while IFS='|' read -r name dir port redis_host redis_port; do
        [ -z "$name" ] && continue
        echo "  $i. $name (端口: $port)"
        i=$((i+1))
    done < "$CONFIG_FILE"
    
    echo -n "选择要停止的实例编号: "
    read choice
    
    # 获取实例信息
    local instance_info=$(sed -n "${choice}p" "$CONFIG_FILE")
    if [ -z "$instance_info" ]; then
        echo -e "${RED}无效的选择${NC}"
        return 1
    fi
    
    IFS='|' read -r name dir port redis_host redis_port <<< "$instance_info"
    
    echo "停止实例: $name (端口: $port)"
    
    # 尝试正常停止
    if stop_instance_by_name "$name" "$port"; then
        echo -e "${GREEN}实例 $name 已成功停止${NC}"
    else
        echo -e "${YELLOW}正常停止失败，是否强制停止？ (y/N): ${NC}"
        read force_confirm
        if [ "$force_confirm" = "y" ] || [ "$force_confirm" = "Y" ]; then
            echo "强制停止实例..."
            if stop_instance_by_name "$name" "$port" "true"; then
                echo -e "${GREEN}实例 $name 已强制停止${NC}"
            else
                echo -e "${RED}强制停止失败，请检查系统状态${NC}"
            fi
        else
            echo -e "${RED}停止操作已取消${NC}"
        fi
    fi
    
    echo "=============================="
}

# 函数：安装实际的项目
install_project() {
    echo "========== 安装项目 =========="
    
    if [ ! -s "$CONFIG_FILE" ]; then
        echo "请先添加实例配置"
        return 1
    fi
    
    # 显示实例列表
    echo "为哪个实例安装项目："
    local i=1
    while IFS='|' read -r name dir port redis_host redis_port; do
        [ -z "$name" ] && continue
        echo "  $i. $name -> $dir"
        i=$((i+1))
    done < "$CONFIG_FILE"
    
    echo -n "选择实例编号: "
    read choice
    
    # 获取实例信息
    local instance_info=$(sed -n "${choice}p" "$CONFIG_FILE")
    if [ -z "$instance_info" ]; then
        echo -e "${RED}无效的选择${NC}"
        return 1
    fi
    
    IFS='|' read -r name dir port redis_host redis_port <<< "$instance_info"
    
    echo "开始安装到: $dir"
    
    # 创建目录
    mkdir -p "$dir"
    
    # 克隆项目
    echo "克隆项目..."
    if git clone https://github.com/slicenferqin/claude-relay-service.git "$dir" --branch feature/smart-account-scheduling --depth 1; then
        echo -e "${GREEN}克隆成功${NC}"
    else
        echo -e "${RED}克隆失败${NC}"
        return 1
    fi
    
    cd "$dir" || return 1
    
    # 安装依赖
    echo "安装依赖..."
    npm install
    
    # 创建.env文件
    echo "创建配置文件..."
    cat > .env <<EOF
PORT=$port
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 16)
REDIS_HOST=$redis_host
REDIS_PORT=$redis_port
LOG_LEVEL=info
EOF
    
    # 复制配置
    [ -f "config/config.example.js" ] && cp config/config.example.js config/config.js
    
    # 初始化
    echo "初始化..."
    npm run setup
    
    # 构建前端
    echo "构建管理后台界面..."
    if [ -d "web/admin-spa" ]; then
        cd web/admin-spa
        echo "  安装前端依赖..."
        npm install
        echo "  构建前端文件..."
        npm run build
        cd ../..
        echo -e "${GREEN}前端构建完成${NC}"
    else
        echo -e "${YELLOW}警告: 前端目录不存在${NC}"
    fi
    
    echo -e "${GREEN}安装完成！${NC}"
    echo "启动命令: cd $dir && npm start"
    echo "访问地址: http://localhost:$port/admin-next/"
    echo "=============================="
}

# 主菜单
show_menu() {
    echo "=============================="
    echo "  Claude Relay 极简管理"
    echo "=============================="
    echo "1. 列出实例"
    echo "2. 添加实例配置"
    echo "3. 删除实例配置"
    echo "4. 安装项目到实例"
    echo "5. 启动实例"
    echo "6. 停止实例"
    echo "0. 退出"
    echo "=============================="
    echo -n "选择操作: "
}

# 主循环
while true; do
    show_menu
    read choice
    
    case $choice in
        1) list_instances ;;
        2) add_instance ;;
        3) delete_instance ;;
        4) install_project ;;
        5) start_instance ;;
        6) stop_instance ;;
        0) echo "退出"; exit 0 ;;
        *) echo -e "${RED}无效选择${NC}" ;;
    esac
    
    echo
    echo -n "按回车继续..."
    read
    clear
done