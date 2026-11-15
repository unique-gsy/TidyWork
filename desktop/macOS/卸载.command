#!/bin/sh
# 双击运行：从 DeepSeek Harness 桌面版卸载 TidyWork 插件
cd -- "$(dirname -- "$0")" || exit 1
sh ./uninstall.sh
printf '\n按回车键关闭这个窗口…'
read -r _
