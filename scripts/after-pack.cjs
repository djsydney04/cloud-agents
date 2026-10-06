const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  // Finder metadata can be inherited from the build directory. Apple rejects
  // these attributes during signing; clear only the generated application.
  execFileSync('/usr/bin/xattr', ['-cr', path.join(appOutDir, `${packager.appInfo.productFilename}.app`)]);
};
