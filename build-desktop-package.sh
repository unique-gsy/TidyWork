#!/bin/sh
# 一键生成「TidyWork 桌面插件安装包」
# 用法：在 tidywork-assistant 目录下执行  bash build-desktop-package.sh
# 做的事：同步最新插件源码 → 编码自检 → 打成 dist/TidyWork-DSH桌面插件-vX.Y.zip
set -eu

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
# 脚本可能在仓库根，也可能在 scripts/ 里，向上找一层有 desktop/ 或 share-desktop/ 的目录当项目根
PROJ="${HERE}"
if [ ! -d "${PROJ}/share-desktop" ] && [ ! -d "${PROJ}/desktop" ]; then
  PROJ=$(cd -- "${HERE}/.." && pwd)
fi
# 同一份脚本在生产目录（share-desktop/ + tidywork-plugin/）和分享仓库（desktop/ + plugin/）都能跑
SHARE="${PROJ}/share-desktop"
[ -d "${SHARE}" ] || SHARE="${PROJ}/desktop"
PLUGIN_SRC="${PROJ}/tidywork-plugin"
[ -d "${PLUGIN_SRC}" ] || PLUGIN_SRC="${PROJ}/plugin"
DIST="${PROJ}/dist"

say() { printf '%s\n' "$*"; }
fail() { printf '\n[失败] %s\n' "$*"; exit 1; }

# ---------- 0. 版本号（改这里就能换包名） ----------
VER_FILE="${SHARE}/VERSION"
[ -f "${VER_FILE}" ] || fail "缺少版本文件：${VER_FILE}"
VER=$(tr -d ' \t\r\n' < "${VER_FILE}")
[ -n "${VER}" ] || fail "VERSION 是空的"

# ---------- 1. 检查两套平台脚本都在 ----------
for f in mac-linux/install-mac.sh mac-linux/uninstall-mac.sh \
         mac-linux/安装-mac.command mac-linux/卸载-mac.command \
         windows/install-windows.ps1 windows/uninstall-windows.ps1 \
         windows/安装-windows.bat windows/卸载-windows.bat 说明.md; do
  [ -f "${SHARE}/${f}" ] || fail "缺少 ${f}"
done

# ---------- 2. 同步最新插件源码 ----------
# ui/ 是面板 iframe 内嵌页面（index.html + app.css/app.js/base.css/tokens.css），
# index.js 的 /tidywork-api/ui/<file> 路由按目录读取，必须随包一起带上。
FILES="package.json cordis.patch.yml icon.svg locale/zh.json lib/client.js lib/index.js lib/types/index.d.ts lib/types/client/index.d.ts ui/index.html ui/app.css ui/base.css ui/tokens.css ui/app.js"
for f in ${FILES}; do
  [ -f "${PLUGIN_SRC}/${f}" ] || fail "插件源码缺少 ${f}"
done

rm -f "${SHARE}/plugin"/package.json "${SHARE}/plugin"/cordis.patch.yml "${SHARE}/plugin"/icon.svg 2>/dev/null || true
for f in ${FILES}; do
  mkdir -p "${SHARE}/plugin/$(dirname "${f}")"
  cp "${PLUGIN_SRC}/${f}" "${SHARE}/plugin/${f}"
done
CNT=0
for f in ${FILES}; do CNT=$((CNT + 1)); done
say "插件源码已同步：${CNT} 个文件"

# ---------- 3. 副本里的版本号跟 VERSION 对齐 ----------
PKG="${SHARE}/plugin/package.json"
sed -i.bak -E 's/"version": *"[^"]*"/"version": "'"${VER}"'"/' "${PKG}"
rm -f "${PKG}.bak"
grep -q "\"version\": \"${VER}\"" "${PKG}" || fail "插件 package.json 版本号没改成 ${VER}"

# ---------- 4. 语法自检（有 node 就用，没有就跳过） ----------
if command -v node >/dev/null 2>&1; then
  for js in "${SHARE}/plugin/lib/client.js" "${SHARE}/plugin/lib/index.js"; do
    node --check "${js}" || fail "语法检查失败：${js}"
  done
  say "语法检查通过（node $(node -v)）"
else
  say "提示：本机没有 node，跳过语法检查"
fi

# ---------- 5. Windows 脚本编码自检（PowerShell 5.1 要求 UTF-8 BOM + CRLF） ----------
for f in windows/install-windows.ps1 windows/uninstall-windows.ps1; do
  BOM=$(head -c 3 "${SHARE}/${f}" | od -An -tx1 | tr -d ' \n')
  [ "${BOM}" = "efbbbf" ] || say "警告：${f} 不是 UTF-8 BOM，PowerShell 5.1 下中文会乱码"
  LC_ALL=C grep -q "$(printf '\r')" "${SHARE}/${f}" || say "警告：${f} 不是 CRLF 换行"
done
for f in windows/安装-windows.bat windows/卸载-windows.bat; do
  LC_ALL=C grep -q "$(printf '\r')" "${SHARE}/${f}" || say "警告：${f} 不是 CRLF 换行"
  if LC_ALL=C grep -q '[^[:print:][:space:]]' "${SHARE}/${f}"; then
    say "警告：${f} 含非 ASCII 字符（cmd 下可能乱码）"
  fi
done

# ---------- 6. 打包 ----------
NAME="TidyWork-DSH桌面插件-v${VER}"
OUT="${DIST}/${NAME}.zip"
T=$(mktemp -d)
trap 'rm -rf "${T}"' EXIT
mkdir -p "${T}/${NAME}"
cp -R "${SHARE}/说明.md" "${SHARE}/mac-linux" "${SHARE}/windows" "${SHARE}/plugin" "${T}/${NAME}/"
chmod +x "${T}/${NAME}/mac-linux/install-mac.sh" "${T}/${NAME}/mac-linux/uninstall-mac.sh" \
         "${T}/${NAME}/mac-linux/安装-mac.command" "${T}/${NAME}/mac-linux/卸载-mac.command"

mkdir -p "${DIST}"
(cd "${T}" && zip -rqFS -X "${OUT}" "${NAME}")
unzip -t "${OUT}" >/dev/null || fail "压缩包校验失败：${OUT}"

# ---------- 7. 结果 ----------
say ""
say "生成：${OUT}"
say "大小：$(du -h "${OUT}" | cut -f1)　文件数：$(unzip -l "${OUT}" | awk 'END {print $2}')"
say ""
say "包内结构："
(cd "${T}" && find "${NAME}" -type f | sed "s/^/  /" | sort)
