#!/bin/bash

# 调试脚本 - 测试管理脚本的关键函数

INSTANCES_CONFIG_FILE="$HOME/.crs-instances"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m'

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

# 获取所有实例名称
get_all_instances() {
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -v '^$' "$INSTANCES_CONFIG_FILE" | cut -d'=' -f1 | sort
    fi
}

# 获取实例数量
get_instances_count() {
    get_all_instances | wc -l | tr -d ' '
}

# 检查实例是否存在
instance_exists() {
    local name=$1
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -q "^$name=" "$INSTANCES_CONFIG_FILE"
    else
        return 1
    fi
}

# 删除实例配置
remove_instance_config() {
    local name=$1
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        grep -v "^$name=" "$INSTANCES_CONFIG_FILE" > "$INSTANCES_CONFIG_FILE.tmp" || true
        mv "$INSTANCES_CONFIG_FILE.tmp" "$INSTANCES_CONFIG_FILE"
    fi
}

# 简化的选择实例函数
simple_select_instance() {
    local action=$1
    local total_instances=$(get_instances_count)
    
    print_info "调试信息："
    print_info "配置文件: $INSTANCES_CONFIG_FILE"
    print_info "实例数量: '$total_instances'"
    print_info "配置文件内容:"
    if [ -f "$INSTANCES_CONFIG_FILE" ]; then
        cat "$INSTANCES_CONFIG_FILE" | while read line; do
            echo "  $line"
        done
    else
        echo "  配置文件不存在"
    fi
    
    if [ "$total_instances" -eq 0 ]; then
        print_error "没有可用的实例进行${action}操作"
        return 1
    fi
    
    echo
    print_info "请选择要${action}的实例："
    echo
    local i=1
    for instance_name in $(get_all_instances); do
        echo "  $i. $instance_name"
        i=$((i + 1))
    done
    
    echo
    echo -n "请选择实例 (输入数字): "
    read choice
    
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$total_instances" ]; then
        print_error "无效选择: $choice"
        return 1
    fi
    
    # 获取选中的实例名
    local selected_instance=$(get_all_instances | sed -n "${choice}p")
    echo "$selected_instance"
}

# 简化的删除实例函数
simple_remove_instance() {
    print_info "开始删除实例流程..."
    
    local name=$(simple_select_instance "删除")
    if [ -z "$name" ]; then
        print_error "未选择实例"
        return 1
    fi
    
    print_info "选中实例: $name"
    
    echo
    print_error "即将删除实例 '$name'"
    echo
    echo -n "确认删除？请输入 'DELETE' 确认: "
    read confirm
    
    if [ "$confirm" != "DELETE" ]; then
        print_info "删除取消"
        return 0
    fi
    
    print_info "删除实例配置..."
    remove_instance_config "$name"
    
    print_success "实例 '$name' 已删除"
    
    # 显示删除后的状态
    local remaining=$(get_instances_count)
    print_info "剩余实例数量: $remaining"
}

# 主函数
main() {
    echo "=================================="
    echo "调试脚本 - 测试删除实例功能"
    echo "=================================="
    echo
    
    case "${1:-test}" in
        "count")
            print_info "测试实例计数功能"
            echo "实例数量: $(get_instances_count)"
            echo "所有实例:"
            get_all_instances | while read name; do
                echo "  - $name"
            done
            ;;
        "remove")
            print_info "测试删除实例功能"
            simple_remove_instance
            ;;
        "test")
            print_info "创建测试实例"
            cat > "$INSTANCES_CONFIG_FILE" << EOF
test1=/path/to/test1:3001:localhost:6379
test2=/path/to/test2:3002:localhost:6379
test3=/path/to/test3:3003:localhost:6379
EOF
            print_success "测试实例已创建"
            
            echo
            print_info "现在可以运行以下命令测试："
            echo "$0 count   # 测试计数功能"
            echo "$0 remove  # 测试删除功能"
            ;;
        *)
            echo "用法: $0 [test|count|remove]"
            ;;
    esac
}

main "$@"