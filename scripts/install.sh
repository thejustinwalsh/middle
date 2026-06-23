#!/bin/sh
# install.sh — one-command mm install
#
# Usage:
#   sh scripts/install.sh          # from the repo root
#   bun run setup                  # equivalent, via package.json
#
# What it does:
#   1. Installs all workspace dependencies (bun install).
#   2. Links the mm CLI into ~/.bun/bin (bun link, idempotent).
#   3. Verifies mm is on PATH and prints the installed version.
#   4. Warns with the exact PATH line to add when ~/.bun/bin is missing from PATH.
#
# Safe to re-run — both bun install and bun link are idempotent.
set -eu

# ---------------------------------------------------------------------------
# Resolve the repo root (the directory that contains this script's parent).
# We want the repo root regardless of where the caller invokes the script from.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

echo "middle — mm install"
echo "  repo: ${REPO_ROOT}"
echo ""

# ---------------------------------------------------------------------------
# 1. Install workspace dependencies
# ---------------------------------------------------------------------------
echo "Installing dependencies …"
bun install --cwd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# 2. Link the CLI (idempotent)
# ---------------------------------------------------------------------------
echo "Linking mm CLI …"
(cd "${REPO_ROOT}/packages/cli" && bun link)

# ---------------------------------------------------------------------------
# 3. Resolve BUN_INSTALL/bin — where bun link places the mm symlink.
# ---------------------------------------------------------------------------
if [ -n "${BUN_INSTALL:-}" ]; then
  BUN_BIN="${BUN_INSTALL}/bin"
else
  BUN_BIN="${HOME}/.bun/bin"
fi

# ---------------------------------------------------------------------------
# 4. Verify mm version — this confirms the link and Bun can run the source.
# ---------------------------------------------------------------------------
if command -v mm >/dev/null 2>&1; then
  MM_VERSION="$(mm version 2>&1)"
  echo ""
  echo "  ✓  mm installed: ${MM_VERSION}"
else
  # mm is not yet on PATH — try running via the symlink directly.
  if [ -x "${BUN_BIN}/mm" ]; then
    MM_VERSION="$("${BUN_BIN}/mm" version 2>&1)"
    echo ""
    echo "  ✓  mm installed: ${MM_VERSION}"
    echo "     (mm is in ${BUN_BIN} but not yet on your PATH — see below)"
  else
    echo ""
    echo "  ✗  mm install failed: ${BUN_BIN}/mm not found after bun link"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 5. PATH check — print the exact line the user needs if BUN_BIN is missing.
# ---------------------------------------------------------------------------
case ":${PATH}:" in
  *":${BUN_BIN}:"*) ;;  # already on PATH — nothing to do
  *)
    echo ""
    echo "  ! ${BUN_BIN} is not on your PATH."
    echo "    Add the following line to your shell profile"
    echo "    (~/.bashrc, ~/.zshrc, ~/.profile, or equivalent):"
    echo ""
    echo "      export PATH=\"\${PATH}:${BUN_BIN}\""
    echo ""
    echo "    Then open a new terminal (or run: source ~/.zshrc) and re-run mm."
    ;;
esac

echo ""
echo "Done. Run 'mm doctor' to verify your toolchain, then 'mm start' to launch the dispatcher."
