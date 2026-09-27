#!/bin/bash
# LanSync Mac 启动脚本（双击运行或终端执行 ./start.command）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装: brew install node 或 https://nodejs.org"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖..."
  npm install --registry=https://registry.npmmirror.com
fi
echo "正在启动 LanSync..."
( sleep 2; open http://localhost:7788 ) &
node server.js
