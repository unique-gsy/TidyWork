#!/bin/sh
# TidyWork 插件卸载脚本（DSH 桌面版 · macOS / Linux 共用）
# 用法：macOS 双击「卸载-mac.command」，或在终端里执行 sh uninstall-mac.sh
set -u

say() { printf '%s\n' "$*"; }
fail() { printf '\n[失败] %s\n' "$*"; exit 1; }

OS=$(uname -s)
PROFILE="${TW_PROFILE:-$HOME/.dsh/profiles/desktop}"
STORE="${TW_STORE:-$HOME/.dsh/plugins/tidywork-plugin}"
NM="${PROFILE}/node_modules/@tidywork/dsh-plugin"

APP=""
if [ -n "${TW_APP:-}" ]; then
  APP="${TW_APP}"
elif [ "${OS}" = "Darwin" ]; then
  for c in "/Applications/DeepSeek Harness.app" "${HOME}/Applications/DeepSeek Harness.app"; do
    [ -d "${c}" ] && { APP="${c}"; break; }
  done
else
  for c in "${HOME}/Applications/DeepSeek Harness.AppImage" \
           "${HOME}/Applications/DeepSeekHarness.AppImage" \
           "/opt/DeepSeek Harness/deepseek-harness" \
           "${HOME}/.local/bin/deepseek-harness"; do
    [ -x "${c}" ] && { APP="${c}"; break; }
  done
  if [ -z "${APP}" ]; then
    APP=$(ls -1 "${HOME}"/Applications/*[Hh]arness*.AppImage 2>/dev/null | head -1)
  fi
fi
if [ "${OS}" = "Darwin" ] && [ -n "${APP}" ]; then
  NODE_BIN="${APP}/Contents/MacOS/DeepSeek Harness"
else
  NODE_BIN="${APP}"
fi

say "TidyWork 插件卸载（DSH 桌面版 · ${OS}）"
say "--------------------------------------"
[ -f "${PROFILE}/package.json" ] || fail "没找到 ${PROFILE}/package.json"

BAK="${PROFILE}/package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp "${PROFILE}/package.json" "${BAK}" || fail "备份 package.json 失败"

if [ -n "${APP}" ] && [ -x "${NODE_BIN}" ]; then
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
  say "已从 profile 中移除插件登记（备份：${BAK}）"
else
  say "找不到应用，跳过配置改写；请手动从 profile 的 package.json 里移除 @tidywork/dsh-plugin。"
fi

[ -d "${NM}" ] && { rm -rf "${NM}"; say "已删除 ${NM}"; }
[ -d "${STORE}" ] && { rm -rf "${STORE}"; say "已删除 ${STORE}"; }

if [ "${TW_NO_RESTART:-0}" != "1" ] && [ -n "${APP}" ] && [ -x "${NODE_BIN}" ]; then
  say ""
  say "正在重启 DSH 桌面版…"
  if [ "${OS}" = "Darwin" ]; then
    osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true
    sleep 3
    open -a "${APP}" >/dev/null 2>&1 || true
  else
    pkill -f "DeepSeek Harness" >/dev/null 2>&1 || true
    sleep 3
    nohup "${NODE_BIN}" >/dev/null 2>&1 &
  fi
fi

say ""
say "完成。你的待办/会议/笔记数据仍在 ${PROFILE}/tidywork 里，重新安装后会接上。"
