#!/bin/sh
# 双击运行：卸载 TidyWork 插件到 DeepSeek Harness 桌面版
cd -- "$(dirname -- "$0")" || exit 1
sh ./uninstall-mac.sh
printf '\n按回车键关闭这个窗口…'
read -r _
