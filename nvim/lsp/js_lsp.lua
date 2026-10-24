-- Neovim 0.11+ native LSP config for js-lsp.
-- Copy to ~/.config/nvim/lsp/js_lsp.lua, then call `vim.lsp.enable('js_lsp')` in init.lua.
-- If `js-lsp` is not on $PATH, set cmd = { 'node', '/abs/path/to/js_lsp/dist/cli.js', '--stdio' }.
---@type vim.lsp.Config
return {
  cmd = { 'js-lsp', '--stdio' },
  filetypes = { 'javascript', 'javascriptreact' },
  root_markers = { 'jsconfig.json', 'package.json', '.git' },
  settings = {},
}
