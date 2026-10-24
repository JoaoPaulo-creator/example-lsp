-- Paste into init.lua (or require it). Works on Neovim 0.11+, falls back to vim.lsp.start on 0.10.
local cmd = { 'js-lsp', '--stdio' } -- or { 'node', '/abs/path/to/js_lsp/dist/cli.js', '--stdio' }
local filetypes = { 'javascript', 'javascriptreact' }
local root_markers = { 'jsconfig.json', 'package.json', '.git' }

if vim.lsp.config and vim.lsp.enable then
  vim.lsp.config('js_lsp', { cmd = cmd, filetypes = filetypes, root_markers = root_markers })
  vim.lsp.enable('js_lsp')
else
  vim.api.nvim_create_autocmd('FileType', {
    pattern = filetypes,
    callback = function(args)
      vim.lsp.start({
        name = 'js_lsp',
        cmd = cmd,
        root_dir = vim.fs.root(args.buf, root_markers) or vim.fn.getcwd(),
      })
    end,
  })
end

-- Optional keymaps. Neovim 0.11+ already maps K (hover), grn (rename), grr (references),
-- gO (document symbols) and <C-x><C-o> (completion); these add the rest.
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('js_lsp_attach', { clear = true }),
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if not client or client.name ~= 'js_lsp' then return end
    local map = function(lhs, rhs, desc) vim.keymap.set('n', lhs, rhs, { buffer = args.buf, desc = desc }) end
    map('gd', vim.lsp.buf.definition, 'Go to definition')
    map('K', vim.lsp.buf.hover, 'Hover')
    map('<leader>rn', vim.lsp.buf.rename, 'Rename symbol')
    map('<leader>fr', vim.lsp.buf.references, 'Find references')
    map('<leader>ds', vim.lsp.buf.document_symbol, 'Document symbols')
    map('<leader>f', function() vim.lsp.buf.format({ bufnr = args.buf }) end, 'Format document')
    if vim.lsp.completion then -- 0.11+: native autocompletion popup
      vim.lsp.completion.enable(true, client.id, args.buf, { autotrigger = true })
    end
  end,
})
