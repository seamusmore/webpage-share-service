#!/bin/bash
# 网页分享服务启动脚本（systemd 方式）
SERVICE=webpage-share
if systemctl is-active --quiet "$SERVICE"; then
    echo "[start.sh] $SERVICE 已在运行，无需重复启动"
else
    systemctl daemon-reload
    systemctl start "$SERVICE"
    sleep 2
    if systemctl is-active --quiet "$SERVICE"; then
        echo "[start.sh] $SERVICE 启动成功"
    else
        echo "[start.sh] $SERVICE 启动失败，请查看: journalctl -u $SERVICE -n 50" >&2
        exit 1
    fi
fi
systemctl status "$SERVICE" --no-pager -l | head -12
