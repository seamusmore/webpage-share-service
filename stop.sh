#!/bin/bash
# 网页分享服务停止脚本（systemd 方式）
SERVICE=webpage-share
if systemctl is-active --quiet "$SERVICE"; then
    systemctl stop "$SERVICE"
    sleep 1
    if systemctl is-active --quiet "$SERVICE"; then
        echo "[stop.sh] $SERVICE 停止失败" >&2
        exit 1
    else
        echo "[stop.sh] $SERVICE 已停止"
    fi
else
    echo "[stop.sh] $SERVICE 未在运行"
fi
