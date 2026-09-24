const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/desktop",
  workers: 1,
  timeout: 120000,
  reporter: "list",
  use: { trace: "retain-on-failure" }
});
