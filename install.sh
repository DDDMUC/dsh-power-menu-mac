#!/bin/sh
# dsh-power-menu-mac 一键安装脚本（macOS）
#
# 把 dsh-power-menu-mac 装进 DSH Desktop 的 profile，并补齐
# `dsh.profile.bundles`，让宿主半在重启后真正加载。
#
# 安装方式（默认自动选择）：
#   - 机器上有 git：用 `github:DDDMUC/dsh-power-menu-mac`（pnpm 的 git 依赖）
#   - 没有 git，或 --tarball：下载 GitHub Release 里的 .tgz，再用本地文件安装，
#     全程不调用 git
#
# 用法：
#   ./install.sh
#   ./install.sh --profile desktop
#   ./install.sh --tarball                 # 强制走 tgz
#   ./install.sh --tgz ./dsh-power-menu-mac-0.1.0.tgz   # 完全离线
#   ./install.sh --sha256 <hash>           # 手动指定安装包 SHA-256
#   ./install.sh --mirror                  # GitHub 直连不通时改走 gh-proxy
#   ./install.sh --version 0.1.0           # 指定要下载的 Release 版本
#
# 装完请重启 DSH Desktop。
#
# 和原版（Windows）的区别：这里不需要 MinGit、不需要改 PATH、不需要处理
# junction —— macOS 自带 /usr/bin/git（Xcode CLT），link 安装就是普通符号链接。
# 真正的坑只有一个：dsh 不在 PATH 上，它在 .app 包里。

set -eu

PROFILE=desktop
VERSION=0.1.0
REPO=DDDMUC/dsh-power-menu-mac
PLUGIN=dsh-power-menu-mac
MODE=auto
MIRROR=0
TGZ_PATH=
SHA256=
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要参数}"; shift 2 ;;
    --version) VERSION="${2:?--version 需要参数}"; shift 2 ;;
    --tgz)     TGZ_PATH="${2:?--tgz 需要参数}"; MODE=tarball; shift 2 ;;
    --sha256)  SHA256="${2:?--sha256 需要参数}"; shift 2 ;;
    --git)     MODE=git; shift ;;
    --tarball) MODE=tarball; shift ;;
    --mirror)  MIRROR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 1 ;;
  esac
done

say() { printf '[%s] %s\n' "$PLUGIN" "$*"; }
warn() { printf '[%s] %s\n' "$PLUGIN" "$*" >&2; }

# ---------------------------------------------------------------- dsh 命令行
find_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "/Applications/DeepSeekHarness.app/Contents/Resources/runtime/cli/bin/dsh"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

DSH=$(find_dsh) || {
  warn "没找到 dsh 命令行。"
  warn "它通常在 /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  warn "装上 DSH Desktop 后再跑一次，或用下面的命令手动安装："
  warn "  <dsh> plugin --profile $PROFILE add github:$REPO"
  exit 1
}
say "dsh: $DSH"

# ---------------------------------------------------------------- SHA-256
sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_sha256() {
  file=$1
  expected=$(printf '%s' "$SHA256" | tr '[:upper:]' '[:lower:]' | sed 's/^sha256://')
  if [ -z "$expected" ]; then
    # 没有显式给 hash：尝试 Release 里的 SHA256SUMS.txt。取不到只是警告，
    # 不静默通过 —— 用户能从这条输出里看到"这次没校验"。
    sums=$(mktemp -t dsh-power-menu-mac-sums)
    url=$(release_url SHA256SUMS.txt)
    if curl -fsSL "$url" -o "$sums" 2>/dev/null; then
      expected=$(awk -v f="dsh-power-menu-mac-$VERSION.tgz" '$2 == f || $2 == "*"f { print $1; exit }' "$sums" | tr '[:upper:]' '[:lower:]')
    fi
    rm -f "$sums"
    if [ -z "$expected" ]; then
      warn "没有取到 SHA256SUMS.txt，跳过自动校验；可用 --sha256 手动指定。"
      return 0
    fi
  fi
  actual=$(sha256_of "$file")
  if [ "$actual" != "$expected" ]; then
    rm -f "$file"
    warn "SHA-256 不匹配：期望 ${expected}，实际 ${actual}。安装包已删除。"
    exit 1
  fi
  say "SHA-256 校验通过。"
}

# ---------------------------------------------------------------- 下载地址
release_url() {
  name=$1
  base="https://github.com/$REPO/releases/download/v$VERSION/$name"
  if [ "$MIRROR" = "1" ]; then
    printf 'https://gh-proxy.com/%s\n' "$base"
  else
    printf '%s\n' "$base"
  fi
}

# ---------------------------------------------------------------- 安装
install_from_git() {
  say "用 git 依赖安装：github:$REPO"
  "$DSH" plugin --profile "$PROFILE" add "github:$REPO"
}

install_from_tarball() {
  if [ -n "$TGZ_PATH" ]; then
    file=$TGZ_PATH
    [ -f "$file" ] || { warn "找不到安装包：$file"; exit 1; }
    say "用本地安装包：$file"
  else
    file=$(mktemp -t "$PLUGIN-$VERSION")
    file="$file.tgz"
    url=$(release_url "dsh-power-menu-mac-$VERSION.tgz")
    say "下载 $url"
    curl -fL --retry 2 --connect-timeout 15 "$url" -o "$file" || {
      warn "下载失败。GitHub 直连不通时可以加 --mirror，或手动下载后用 --tgz 指定。"
      exit 1
    }
  fi
  verify_sha256 "$file"
  "$DSH" plugin --profile "$PROFILE" add "$file"
}

case "$MODE" in
  git) install_from_git ;;
  tarball) install_from_tarball ;;
  auto)
    if command -v git >/dev/null 2>&1; then
      install_from_git || {
        warn "git 方式失败，改用 tgz 重试。"
        install_from_tarball
      }
    else
      install_from_tarball
    fi
    ;;
esac

# ---------------------------------------------------------------- 补 bundles
# 插件管理器只写 dependencies，不写 dsh.profile.bundles；少了这一步，宿主半
# 不加载，点按钮就是 HTTP 404。这一步和 enable.sh 是同一件事。
if [ -x "$SCRIPT_DIR/enable.sh" ]; then
  "$SCRIPT_DIR/enable.sh" "$PROFILE"
else
  warn "没找到 enable.sh，请手动把 \"$PLUGIN\" 加进 profile 的 dsh.profile.bundles。"
  warn "profile: $HOME/.dsh/profiles/$PROFILE/package.json"
fi

say "完成。请重启 DSH Desktop。"
