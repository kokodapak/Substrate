// Custom Metro config to keep the RN app isolated from server code
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const serverRoot = path.join(workspaceRoot, 'server');

/** @type {import('metro-config').ConfigT} */
const config = getDefaultConfig(projectRoot);

// Only watch the app itself and explicitly block the server folder
config.watchFolders = [projectRoot];
config.resolver = config.resolver || {};
// Merge our block entry with Metro's default block list
const defaultBlockList = config.resolver.blockList;
const serverBlock = new RegExp(`${serverRoot.replace(/[/\\]/g, '[\\/]')}.*`);
config.resolver.blockList = new RegExp(
  `${defaultBlockList ? defaultBlockList.source + '|' : ''}${serverBlock.source}`
);

// Optional: stub Node core modules that may be referenced by some deps
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  fs: path.join(projectRoot, 'shims', 'fs.js'),
};

module.exports = config;
