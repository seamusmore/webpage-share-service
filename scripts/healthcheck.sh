#!/bin/bash
# 网页分享服务健康检查脚本
# 每 5 分钟执行一次，检测服务状态并自动恢复
#
# 环境变量：
#   SERVICE_DIR - 服务根目录，默认为脚本所在目录的父目录
#   HEALTH_URL  - 健康检查 URL，默认 http://localhost:9080/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="${SERVICE_DIR:-$SCRIPT_DIR/..}"
LOG_FILE="/tmp/webpage-health.log"
SERVICE_NAME="webpage-share"
HEALTH_URL="${HEALTH_URL:-http://localhost:9080/}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

# 检查服务是否响应
if curl -sf --connect-timeout 5 "$HEALTH_URL" > /dev/null 2>&1; then
    log "✅ 服务健康检查通过"
    exit 0
fi

# 服务异常，尝试重启
log "⚠️ 服务无响应，尝试重启..."

# 检查 PM2 进程状态
if pm2 describe "$SERVICE_NAME" | grep -q "online"; then
    log "📋 PM2 进程状态正常，尝试重启"
    pm2 restart "$SERVICE_NAME" >> "$LOG_FILE" 2>&1
else
    log "❌ PM2 进程异常，尝试启动"
    cd "$SERVICE_DIR" && pm2 start ecosystem.config.js >> "$LOG_FILE" 2>&1
fi

# 等待 5 秒后验证
sleep 5
if curl -sf --connect-timeout 5 "$HEALTH_URL" > /dev/null 2>&1; then
    log "✅ 服务重启成功"
else
    log "❌ 服务重启失败，需要人工介入"
fi
