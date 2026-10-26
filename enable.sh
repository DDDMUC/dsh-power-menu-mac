#!/bin/sh
# dsh-power-menu-mac 一键启用脚本（macOS）
#
# 用途：DSH 插件管理器安装后只写 dependencies，不一定会把插件加进
# `dsh.profile.bundles`；少了这一条，宿主半不加载，点按钮就会 HTTP 404。
# 这个脚本只做一件事：把 dsh-power-menu-mac 补进指定 profile 的 bundles，
# 写之前备份 profile 的 package.json。
#
# 用法：
#   ./enable.sh              # 默认 desktop profile
#   ./enable.sh web          # 指定 profile
#
# 然后重启 DSH。
#
# 实现说明：原版（PowerShell）用正则往 JSON 文本里插一段字符串，只为了保留
# 原文件排版。macOS 这边直接用 node 或 python3 解析再写回 —— 同样的 2 空格
# 缩进，但不会因为格式差异把文件写坏。两个都没有时才退回文本插入。

set -eu

PROFILE="${1:-desktop}"
PLUGIN="dsh-power-menu-mac"
PKG="$HOME/.dsh/profiles/$PROFILE/package.json"

if [ ! -f "$PKG" ]; then
  echo "找不到 DSH profile 的 package.json：$PKG" >&2
  echo "可用的 profile：" >&2
  ls -1 "$HOME/.dsh/profiles" 2>/dev/null >&2 || echo "  （~/.dsh/profiles 不存在）" >&2
  exit 1
fi

# 退出码 0 = 写好了，2 = 本来就有，1 = 失败。
with_node() {
  node - "$PKG" "$PLUGIN" <<'JS'
const fs = require('node:fs')
const [pkg, plugin] = process.argv.slice(2)
const data = JSON.parse(fs.readFileSync(pkg, 'utf8'))
data.dsh = data.dsh ?? {}
data.dsh.profile = data.dsh.profile ?? {}
const bundles = (data.dsh.profile.bundles = data.dsh.profile.bundles ?? [])
if (bundles.includes(plugin)) process.exit(2)
bundles.push(plugin)
fs.copyFileSync(pkg, `${pkg}.bak-${plugin}`)
fs.writeFileSync(pkg, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
JS
}

with_python() {
  python3 - "$PKG" "$PLUGIN" <<'PY'
import json, shutil, sys
pkg, plugin = sys.argv[1], sys.argv[2]
with open(pkg, encoding='utf-8') as fh:
    data = json.load(fh)
profile = data.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if plugin in bundles:
    sys.exit(2)
bundles.append(plugin)
shutil.copyfile(pkg, pkg + '.bak-' + plugin)
with open(pkg, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY
}

# 兜底：纯文本插入。只在既没有 node 也没有 python3 时用。
#
# 必须先判断文件里到底有没有 bundles 这一项，再决定往哪儿插：逐行扫描时
# `"profile": {` 出现在 `"bundles"` 之前，如果边扫边插就会先插出一个重复的
# bundles 键 —— JSON 解析取最后一个，于是新加的那条被静默丢掉。
with_sed() {
  if grep -q "\"$PLUGIN\"" "$PKG"; then return 2; fi
  cp "$PKG" "$PKG.bak-$PLUGIN"
  if grep -q '"bundles"' "$PKG"; then
    awk -v plugin="$PLUGIN" '
      BEGIN { done = 0 }
      {
        if (!done && match($0, /"bundles"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]/)) {
          sub(/\[[[:space:]]*\]/, "[\"" plugin "\"]")
          print; done = 1; next
        }
        if (!done && match($0, /"bundles"[[:space:]]*:[[:space:]]*\[/)) {
          print; print "      \"" plugin "\","; done = 1; next
        }
        print
      }
    ' "$PKG" > "$PKG.tmp" && mv "$PKG.tmp" "$PKG"
  else
    awk -v plugin="$PLUGIN" '
      BEGIN { done = 0 }
      {
        print
        if (!done && match($0, /"profile"[[:space:]]*:[[:space:]]*\{/)) {
          print "      \"bundles\": [\"" plugin "\"],"; done = 1
        }
      }
    ' "$PKG" > "$PKG.tmp" && mv "$PKG.tmp" "$PKG"
  fi
}

status=1
if command -v node >/dev/null 2>&1; then
  set +e; with_node; status=$?; set -e
elif command -v python3 >/dev/null 2>&1; then
  set +e; with_python; status=$?; set -e
else
  echo "[$PLUGIN] 没找到 node 或 python3，改用文本插入（请检查结果）。"
  set +e; with_sed; status=$?; set -e
fi

case "$status" in
  0)
    echo "[$PLUGIN] 已加入 dsh.profile.bundles。"
    echo "原文件备份：$PKG.bak-$PLUGIN"
    echo "请重启 DSH 让宿主半加载。"
    ;;
  2)
    echo "[$PLUGIN] 已经在 dsh.profile.bundles 里。"
    echo "如果按钮仍然 404，请确认 dependencies 里有 ${PLUGIN}，并重启 DSH。"
    ;;
  *)
    echo "[$PLUGIN] 写入失败。请手动把 \"$PLUGIN\" 加进 $PKG 的 dsh.profile.bundles。" >&2
    exit 1
    ;;
esac
