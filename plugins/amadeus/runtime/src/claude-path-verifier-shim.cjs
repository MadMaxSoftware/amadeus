"use strict";

const fs = require("node:fs");
const path = require("node:path");

const originalRealpath = fs.promises.realpath.bind(fs.promises);
const originalRealpathSync = fs.realpathSync.bind(fs);

function containedFallback(input, error) {
  const workspaceValue = process.env.CLAUDE_CONTAINED_WORKSPACE;
  if (error?.code !== "EPERM" || !workspaceValue) throw error;
  const workspace = path.resolve(workspaceValue);
  const requested = path.resolve(String(input));
  const relative = path.relative(workspace, requested);
  const insideWorkspace = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!insideWorkspace) throw error;
  return requested;
}

fs.promises.realpath = async function containedClaudeRealpath(input, ...args) {
  try {
    return await originalRealpath(input, ...args);
  } catch (error) {
    return containedFallback(input, error);
  }
};

fs.realpathSync = function containedClaudeRealpathSync(input, ...args) {
  try {
    return originalRealpathSync(input, ...args);
  } catch (error) {
    return containedFallback(input, error);
  }
};
