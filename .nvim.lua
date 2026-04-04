-- Append the container debug config after plugins have fully loaded,
-- so it survives any dap.configurations.go = { ... } assignments in plugin config.
vim.api.nvim_create_autocmd("User", {
	pattern = "VeryLazy",
	once = true,
	callback = function()
		local dap = require("dap")
		dap.configurations.go = dap.configurations.go or {}
		table.insert(dap.configurations.go, {
			type = "delve_headless",
			name = "Connect to container (dlv)",
			request = "attach",
			mode = "remote",
			port = 2345,
			substitutePath = {
				{ from = "${workspaceFolder}", to = "/src" },
				{ from = "/src", to = "${workspaceFolder}" },
				{ from = "/usr/local/go", to = "/home/sergio/.local/share/mise/installs/go/1.26.1" },
				{ from = "/home/sergio/.local/share/mise/installs/go/1.26.1", to = "/usr/local/go" },
			},
		})
	end,
})
