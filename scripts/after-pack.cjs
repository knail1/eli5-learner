// Electron fuses applied after packaging (12 §7.8).
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { Arch } = require('electron-builder');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const exe = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    // Flipping fuses breaks Electron's ad-hoc signature, and Apple silicon kills unsigned code.
    // Re-sign ad hoc so the unsigned public build runs; a real identity re-signs later (01 §8.3).
    resetAdHocDarwinSignature: context.arch === Arch.arm64 || context.arch === Arch.universal,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};
