#!/bin/sh
# 双击运行：安装 TidyWork 插件到 DeepSeek Harness 桌面版
cd -- "$(dirname -- "$0")" || exit 1
sh ./install-mac.sh
printf '\n按回车键关闭这个窗口…'
read -r _
