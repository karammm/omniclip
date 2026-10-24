import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';

export interface KeyPair {
  certPem: string;
  keyPem: string;
}

const DAY = 24 * 60 * 60 * 1000;
// Apple rejects TLS server certs valid for more than 825 days, even under a user-installed root.
const LEAF_DAYS = 397;
const CA_DAYS = 3650;

function newKeys(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey; keyPem: string } {
  // node's native keygen is much faster than forge's pure-JS one
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  return { privateKey: forgeKey, publicKey: forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e), keyPem };
}

function serial(): string {
  // positive, 16 bytes
  return '01' + crypto.randomBytes(15).toString('hex');
}

export function createCA(): KeyPair {
  const { privateKey, publicKey, keyPem } = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * DAY);
  const attrs = [
    { name: 'commonName', value: 'OmniClip Local CA' },
    { name: 'organizationName', value: 'OmniClip' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem };
}

export function issueServerCert(ca: KeyPair, ips: string[], dnsNames: string[]): KeyPair {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const { publicKey, keyPem } = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * DAY);
  cert.setSubject([{ name: 'commonName', value: dnsNames[0] ?? ips[0] ?? 'omniclip' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [...dnsNames.map((value) => ({ type: 2, value })), ...ips.map((ip) => ({ type: 7, ip }))],
    },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem };
}

function readPair(dir: string, base: string): KeyPair | null {
  try {
    return {
      certPem: fs.readFileSync(path.join(dir, `${base}.crt`), 'utf8'),
      keyPem: fs.readFileSync(path.join(dir, `${base}.key`), 'utf8'),
    };
  } catch {
    return null;
  }
}

function writePair(dir: string, base: string, pair: KeyPair): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${base}.crt`), pair.certPem);
  fs.writeFileSync(path.join(dir, `${base}.key`), pair.keyPem, { mode: 0o600 });
}

/**
 * Loads the CA from disk (or the seed handed over by a previous hub), creating one if needed,
 * then issues a server cert covering the given hosts. The leaf is cached until hosts change.
 */
export function ensureCerts(dir: string, ips: string[], dnsNames: string[], seedCA?: KeyPair): { ca: KeyPair; server: KeyPair } {
  let ca = seedCA ?? readPair(dir, 'ca');
  if (!ca) ca = createCA();
  if (seedCA || !readPair(dir, 'ca')) writePair(dir, 'ca', ca);

  const hostsKey = [...ips, ...dnsNames].sort().join(',');
  const hostsFile = path.join(dir, 'server.hosts');
  let server = readPair(dir, 'server');
  let reuse = false;
  if (server && !seedCA) {
    try {
      const cert = forge.pki.certificateFromPem(server.certPem);
      const caCert = forge.pki.certificateFromPem(ca.certPem);
      reuse =
        fs.readFileSync(hostsFile, 'utf8') === hostsKey &&
        cert.validity.notAfter.getTime() - Date.now() > 30 * DAY &&
        caCert.verify(cert);
    } catch {
      reuse = false;
    }
  }
  if (!reuse || !server) {
    server = issueServerCert(ca, ips, dnsNames);
    writePair(dir, 'server', server);
    fs.writeFileSync(hostsFile, hostsKey);
  }
  return { ca, server };
}

export function fingerprint(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}
