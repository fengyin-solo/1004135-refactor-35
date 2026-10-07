#!/usr/bin/env bash
# 无浏览器环境下的领域逻辑冒烟测试：tsc 转译到临时目录，再把 @/ 别名替换为产物路径后用 node 运行。
set -euo pipefail
cd "$(dirname "$0")/.."

run_case() {
  local config="$1"
  local entry="$2"
  local build_dir="${TMPDIR:-/tmp}/${3:-smoke-build}"
  rm -rf "$build_dir"
  ./node_modules/typescript/bin/tsc -p "$config"
  grep -rl 'require("@/' "$build_dir" | while read -r file; do
    sed -i "s#require(\"@/#require(\"$build_dir/src/#g" "$file"
  done
  node "$build_dir/scripts/$entry"
}

run_case scripts/tsconfig.smoke.json smoke-flight.js smoke-build
run_case scripts/tsconfig.migrate.json migrate-check.js migrate-build
