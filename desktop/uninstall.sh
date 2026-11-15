#!/bin/sh
# TidyWork 插件卸载脚本（DSH 桌面版 · macOS）
set -u

say() { printf '%s\n' "$*"; }
fail() { printf '\n[失败] %s\n' "$*"; exit 1; }

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
PROFILE="${TW_PROFILE:-$HOME/.dsh/profiles/desktop}"
STORE="${TW_STORE:-$HOME/.dsh/plugins/tidywork-plugin}"
NM="${PROFILE}/node_modules/@tidywork/dsh-plugin"

APP="/Applications/DeepSeek Harness.app"
[ -d "${APP}" ] || APP="$HOME/Applications/DeepSeek Harness.app"
NODE_BIN="${APP}/Contents/MacOS/DeepSeek Harness"

say "TidyWork 插件卸载"
say "--------------------------------------"
[ -f "${PROFILE}/package.json" ] || fail "没找到 ${PROFILE}/package.json"

BAK="${PROFILE}/package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp "${PROFILE}/package.json" "${BAK}" || fail "备份 package.json 失败"

if [ -x "${NODE_BIN}" ]; then
  J=$(mktemp "${TMPDIR:-/tmp}/twunpatch.XXXXXX.js") || fail "无法创建临时文件"
  cat > "${J}" <<'JS'
const fs = require('fs')
const [pkgPath] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
if (j.dependencies) delete j.dependencies['@tidywork/dsh-plugin']
const b = j.dsh && j.dsh.profile && j.dsh.profile.bundles
if (Array.isArray(b)) j.dsh.profile.bundles = b.filter((x) => x !== '@tidywork/dsh-plugin')
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n')
console.log('OK')
JS
  OUT=$(ELECTRON_RUN_AS_NODE=1 "${NODE_BIN}" "${J}" "${PROFILE}/package.json" 2>/dev/null)
  rm -f "${J}"
  [ "${OUT}" = "OK" ] || fail "改写 profile 配置失败。原配置已备份在：${BAK}"
else
  say "找不到应用内置运行时，跳过配置改写；请手动从 ${PROFILE}/package.json 里移除 @tidywork/dsh-plugin。"
fi
say "已从 profile 中移除插件登记（备份：${BAK}）"

if [ -d "${NM}" ]; then
  rm -rf "${NM}" && say "已删除 ${NM}"
fi
if [ -d "${STORE}" ]; then
  rm -rf "${STORE}" && say "已删除 ${STORE}"
fi

if [ "${TW_NO_RESTART:-0}" != "1" ]; then
  say ""
  say "正在重启 DSH 桌面版…"
  osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true
sleep 3
[ -d "${APP}" ] && open -a "${APP}" >/dev/null 2>&1 || say "请手动重新打开 DeepSeek Harness。"
fi
say ""
say "完成。你的待办/会议/笔记数据仍在 ~/.dsh/profiles/desktop/tidywork 里，重新安装后会接上。"
