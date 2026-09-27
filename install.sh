#!/bin/bash
# SNS 발행기 설치·업데이트 (Mac mini)
#
# 터미널(응용 프로그램 → 유틸리티 → 터미널)에 아래 한 줄을 붙여 넣고 Enter:
#   curl -fsSL https://raw.githubusercontent.com/dreamthinkerharvester/claude_Desktopapp/HEAD/install.sh | bash
#
# 하는 일: 개발 도구·Node.js 확인 → ~/sns-publisher 에 내려받기(있으면 최신으로) → 설정 마법사 실행
# 같은 명령을 다시 실행하면 프로그램을 최신으로 바꾸고 설정 마법사를 다시 엽니다 (기존 설정은 기본값으로 유지).

set -euo pipefail

REPO_URL="${SNSPUB_REPO:-https://github.com/dreamthinkerharvester/claude_Desktopapp.git}"
DEST="${SNSPUB_HOME:-$HOME/sns-publisher}"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Mac 에서 실행해 주세요."

step "1/4 개발 도구(git) 확인"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  fail "개발 도구 설치 창이 떴습니다. 설치가 끝나면 같은 명령을 다시 붙여 넣어 주세요."
fi
echo "git $(git --version | awk '{print $3}')"

step "2/4 Node.js 확인 (22.13 이상 필요)"
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  BREW="$(command -v brew || true)"
  if [ -z "$BREW" ]; then
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      [ -x "$candidate" ] && BREW="$candidate" && break
    done
  fi
  [ -n "$BREW" ] || fail "Homebrew 가 없습니다. https://brew.sh 에 있는 설치 명령을 먼저 실행한 뒤 이 명령을 다시 붙여 넣어 주세요."
  echo "Homebrew 로 Node.js 를 설치합니다..."
  "$BREW" install node || "$BREW" upgrade node
  eval "$("$BREW" shellenv)"
  node_ok || fail "Node.js 를 22.13 이상으로 준비하지 못했습니다 (지금: $(node -v 2>/dev/null || echo '없음')). 'brew upgrade node' 를 실행해 주세요."
fi
echo "Node.js $(node -v)"

step "3/4 프로그램 내려받기 → $DEST"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only || fail "업데이트에 실패했습니다. $DEST 안의 파일을 직접 고쳤다면 되돌린 뒤 다시 실행해 주세요."
else
  [ -e "$DEST" ] && fail "$DEST 가 이미 있지만 이 프로그램 폴더가 아닙니다. 옮기거나 SNSPUB_HOME 으로 다른 위치를 지정해 주세요."
  git clone "$REPO_URL" "$DEST"
fi

step "4/4 설정 마법사"
cd "$DEST"
# curl | bash 로 실행하면 표준 입력이 스크립트이므로, 질문의 답은 터미널에서 직접 받습니다
if { exec 3</dev/tty; } 2>/dev/null; then
  node bin/snspub.js setup <&3
else
  node bin/snspub.js setup
fi
