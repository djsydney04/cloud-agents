// Test-only entrypoint: never touches the user's saved desktop connection.
const { app } = require("electron");
const path = require("node:path");
app.setPath("userData", process.env.CLOUD_AGENTS_UI_PROFILE);
require(path.join(__dirname, "../../desktop/main.cjs"));
