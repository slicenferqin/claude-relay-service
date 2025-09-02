#!/bin/bash

# 快速测试脚本 - 用于Ubuntu服务器调试

echo "==============================================="
echo "Ubuntu环境修复测试 - Claude Relay Service"
echo "==============================================="
echo

INSTANCES_CONFIG_FILE="$HOME/.crs-instances"

# 创建测试实例
echo "1. 创建测试实例配置..."
cat > "$INSTANCES_CONFIG_FILE" << EOF
test1=/path/to/test1:3001:localhost:6379
test2=/path/to/test2:3002:localhost:6379
test3=/path/to/test3:3003:localhost:6379
EOF

echo "   配置文件已创建: $INSTANCES_CONFIG_FILE"
echo "   实例数量: $(cat "$INSTANCES_CONFIG_FILE" | wc -l)"
echo

# 测试基本功能
echo "2. 测试基本功能..."
echo "   - 列出所有实例:"
cat "$INSTANCES_CONFIG_FILE" | while read line; do
    echo "     $line"
done
echo

# 测试删除功能的关键部分
echo "3. 测试删除功能关键组件..."

# 模拟选择实例
echo "   - 模拟选择第一个实例进行删除..."
selected_instance=$(head -1 "$INSTANCES_CONFIG_FILE" | cut -d'=' -f1)
echo "     选中实例: $selected_instance"

# 模拟删除确认
echo "   - 模拟删除确认..."
echo "DELETE" | (
    read confirm
    if [ "$confirm" = "DELETE" ]; then
        echo "     确认接收成功"
        # 删除选中的实例
        grep -v "^$selected_instance=" "$INSTANCES_CONFIG_FILE" > "$INSTANCES_CONFIG_FILE.tmp"
        mv "$INSTANCES_CONFIG_FILE.tmp" "$INSTANCES_CONFIG_FILE"
        echo "     实例 $selected_instance 已从配置中删除"
    else
        echo "     确认失败"
    fi
)

echo
echo "4. 删除后状态检查..."
echo "   剩余实例数量: $(cat "$INSTANCES_CONFIG_FILE" | wc -l)"
echo "   剩余实例:"
cat "$INSTANCES_CONFIG_FILE" | while read line; do
    echo "     $line"
done

echo
echo "5. 环境变量测试..."
echo "   SKIP_STATUS_CHECK 测试模式:"
export SKIP_STATUS_CHECK=1
echo "   已设置 SKIP_STATUS_CHECK=1 来跳过状态检查"
echo "   这应该加快脚本运行速度"

echo
echo "==============================================="
echo "测试完成！现在请运行主脚本进行实际测试："
echo
echo "  # 快速模式（跳过状态检查）"
echo "  SKIP_STATUS_CHECK=1 ./scripts/manage-multi-enhanced.sh menu"
echo
echo "  # 或者直接运行"
echo "  ./scripts/manage-multi-enhanced.sh menu"
echo
echo "  # 清理测试数据"
echo "  rm $INSTANCES_CONFIG_FILE"
echo "==============================================="