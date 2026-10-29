// Sets one version everywhere: `node scripts/set-version.mjs 0.2.0` (a leading "v" is fine, so CI can pass the tag).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!m) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}
const [major, minor, patch] = m.slice(1).map(Number);
// Android needs a growing integer; 1.2.3 -> 10203
const versionCode = major * 10000 + minor * 100 + patch;

function edit(rel, fn) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) fs.writeFileSync(file, after);
  console.log(`${after !== before ? 'updated' : 'unchanged'} ${rel}`);
}

const packages = ['package.json', 'packages/protocol/package.json', 'packages/ui/package.json', 'apps/relay/package.json', 'apps/hub/package.json', 'apps/web/package.json', 'apps/desktop/package.json', 'apps/mobile/package.json'];
for (const rel of packages) {
  edit(rel, (s) =>
    s
      .replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
      // workspace packages depend on each other by exact version
      .replace(/("@omniclip\/[a-z]+":\s*")\d+\.\d+\.\d+(")/g, `$1${version}$2`),
  );
}

edit('apps/mobile/android/app/build.gradle', (s) =>
  s.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${version}"`),
);

edit('apps/mobile/ios/App/App.xcodeproj/project.pbxproj', (s) =>
  s.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`),
);
