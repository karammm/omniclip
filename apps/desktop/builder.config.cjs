// electron-builder settings. The base lives in package.json ("build"); this file adds code signing
// when the secrets for it are present, so builds without them (forks, local builds) stay ad-hoc signed.
//
// macOS  CSC_LINK + CSC_KEY_PASSWORD: a "Developer ID Application" certificate (.p12, path or base64),
//        or CSC_NAME for one already in the keychain. Notarization runs when APPLE_API_KEY (path to
//        the .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
// Windows AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_CERT_PROFILE and AZURE_PUBLISHER_NAME,
//        plus AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET (Azure Artifact Signing, formerly
//        Trusted Signing). A .pfx certificate works too, through WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD.
const base = require('./package.json').build;

const env = (name) => (process.env[name] ?? '').trim();
const signMac = process.platform === 'darwin' && !!(env('CSC_LINK') || env('CSC_NAME'));
const azure = !!(env('AZURE_SIGNING_ENDPOINT') && env('AZURE_SIGNING_ACCOUNT') && env('AZURE_CERT_PROFILE') && env('AZURE_TENANT_ID'));

const mac = { ...base.mac };
if (signMac) {
  delete mac.identity; // picked from CSC_LINK / CSC_NAME
  mac.hardenedRuntime = true;
  mac.gatekeeperAssess = false;
  mac.entitlements = 'assets/entitlements.mac.plist';
  mac.entitlementsInherit = 'assets/entitlements.mac.plist';
  // the zip and latest-mac.yml let signed installs update themselves
  mac.target = [...base.mac.target, { target: 'zip', arch: ['arm64', 'x64'] }];
}

const win = { ...base.win };
if (azure) {
  win.azureSignOptions = {
    endpoint: env('AZURE_SIGNING_ENDPOINT'),
    codeSigningAccountName: env('AZURE_SIGNING_ACCOUNT'),
    certificateProfileName: env('AZURE_CERT_PROFILE'),
    publisherName: env('AZURE_PUBLISHER_NAME') || undefined,
  };
}

console.log(`[builder] macOS: ${signMac ? 'Developer ID signed' + (env('APPLE_API_KEY') ? ' + notarized' : ' (not notarized)') : 'ad-hoc'}; Windows: ${azure ? 'Azure signed' : env('WIN_CSC_LINK') ? '.pfx signed' : 'unsigned'}`);

module.exports = { ...base, mac, win };
