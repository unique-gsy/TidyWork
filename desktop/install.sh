#!/bin/sh
# TidyWork 插件安装脚本（DSH 桌面版 · macOS）
# 用法：双击「安装.command」，或在终端里执行 sh install.sh
set -u

say() { printf '%s\n' "$*"; }
fail() { printf '\n[失败] %s\n' "$*"; exit 1; }

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
# 压缩包里插件在 plugin/；放进仓库 desktop/ 时插件在上级 plugin/，两种都认
SRC="${HERE}/plugin"
[ -f "${SRC}/package.json" ] || SRC="${HERE}/../plugin"
PROFILE="${TW_PROFILE:-$HOME/.dsh/profiles/desktop}"
STORE="${TW_STORE:-$HOME/.dsh/plugins/tidywork-plugin}"

say "TidyWork 插件安装（DSH 桌面版）"
say "--------------------------------------"

# 1) 找应用
APP="/Applications/DeepSeek Harness.app"
[ -d "${APP}" ] || APP="$HOME/Applications/DeepSeek Harness.app"
[ -d "${APP}" ] || fail "没找到 DeepSeek Harness.app。请先装好 DSH 桌面版再运行本脚本。"
NODE_BIN="${APP}/Contents/MacOS/DeepSeek Harness"
[ -x "${NODE_BIN}" ] || fail "应用目录不完整：找不到内置运行时。"
say "应用：${APP}"

# 2) 检查 profile（DSH 桌面版必须被打开过一次才会生成）
[ -d "${PROFILE}" ] || fail "没找到 DSH 桌面版配置目录：${PROFILE}
   请先打开一次 DeepSeek Harness（停在任意界面即可），退出后再运行本脚本。"
[ -f "${PROFILE}/package.json" ] || fail "配置目录缺少 package.json：${PROFILE}"

# 3) 检查插件源
[ -f "${SRC}/package.json" ] || fail "压缩包不完整：缺少 plugin/ 目录。"
[ -f "${SRC}/lib/index.js" ] || fail "压缩包不完整：缺少 plugin/lib/index.js。"

# 4) 插件放到固定位置（不留在下载目录，避免被清理后失效）
mkdir -p "$HOME/.dsh/plugins" || fail "无法创建 $HOME/.dsh/plugins"
mkdir -p "${STORE}" || fail "无法创建 ${STORE}"
cp -R "${SRC}/." "${STORE}/" || fail "复制插件到 ${STORE} 失败"
say "插件文件：${STORE}"

# 5) 放进 profile 的 node_modules（插件零依赖，直接放即可被加载）
NM="${PROFILE}/node_modules/@tidywork/dsh-plugin"
mkdir -p "${NM}" || fail "无法创建 ${NM}"
cp -R "${SRC}/." "${NM}/" || fail "复制插件到 ${NM} 失败"
say "已就位：${NM}"

# 6) 登记到 profile 的 package.json（备份后原地改写，保留已有插件）
BAK="${PROFILE}/package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp "${PROFILE}/package.json" "${BAK}" || fail "备份 package.json 失败"
J=$(mktemp "${TMPDIR:-/tmp}/twpatch.XXXXXX.js") || fail "无法创建临时文件"
cat > "${J}" <<'JS'
const fs = require('fs')
const [pkgPath, pluginDir] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
j.dependencies = j.dependencies || {}
j.dependencies['@tidywork/dsh-plugin'] = 'file:' + pluginDir
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
const bundles = (j.dsh.profile.bundles = j.dsh.profile.bundles || [])
if (!bundles.includes('@tidywork/dsh-plugin')) bundles.push('@tidywork/dsh-plugin')
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n')
console.log('OK')
JS
OUT=$(ELECTRON_RUN_AS_NODE=1 "${NODE_BIN}" "${J}" "${PROFILE}/package.json" "${STORE}" 2>/dev/null)
rm -f "${J}"
[ "${OUT}" = "OK" ] || fail "写入 profile 配置失败。原配置已备份在：${BAK}"
say "已在 profile 中登记插件（备份：${BAK}）"

# 7) 重启应用让插件生效
if [ "${TW_NO_RESTART:-0}" != "1" ]; then
  say ""
  say "正在重启 DSH 桌面版…"
  osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true
  sleep 3
  open -a "${APP}" >/dev/null 2>&1 || fail "自动重启失败，请手动打开 DeepSeek Harness。"
fi

say ""
say "完成。打开 DSH 桌面版后，左侧栏应出现「工作台 / 待办 / 会议 / 笔记」四个入口。"
say "如果右侧仍是 DSH 原界面，点侧栏最上面的「工作台」即可。"
