"use strict";

const os = require("node:os");

try {
  os.userInfo();
} catch (error) {
  if (!error || error.code !== "ERR_SYSTEM_ERROR" || !String(error.message).includes("uv_os_get_passwd")) throw error;
  const username = process.env.CLAUDE_CONTAINED_USERNAME;
  const homedir = process.env.CLAUDE_CONTAINED_HOME;
  if (!username || !homedir) throw new Error("Contained Claude Windows identity fallback is not configured");
  Object.defineProperty(os, "userInfo", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => ({ username, uid: -1, gid: -1, shell: null, homedir }),
  });
}
