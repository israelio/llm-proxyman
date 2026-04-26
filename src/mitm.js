const tls = require('node:tls');
const net = require('node:net');
const { Transform } = require('node:stream');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CERTS_DIR = path.join(os.homedir(), '.local-llm-proxy', 'certs');
const CA_KEY  = path.join(CERTS_DIR, 'ca.key');
const CA_CERT = path.join(CERTS_DIR, 'ca.crt');
const SRV_KEY = path.join(CERTS_DIR, 'server.key');

const certCache = new Map();

function run(cmd) { execSync(cmd, { stdio: 'pipe' }); }

function setupCA() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (!fs.existsSync(CA_CERT)) {
    console.log('[MITM] Generating CA certificate...');
    run(`openssl genrsa -out "${CA_KEY}" 2048`);
    run(`openssl req -new -x509 -days 3650 -key "${CA_KEY}" -out "${CA_CERT}" -subj "/CN=local-llm-proxy CA/O=local-llm-proxy"`);
    run(`openssl genrsa -out "${SRV_KEY}" 2048`);
    console.log(`[MITM] CA ready: ${CA_CERT}`);
    console.log('[MITM] Trust it once with:');
    console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT}"`);
  }

  return CA_CERT;
}

function getCert(hostname) {
  if (certCache.has(hostname)) return certCache.get(hostname);

  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const certFile = path.join(CERTS_DIR, `${hostname}.crt`);
  const csrFile  = path.join(CERTS_DIR, `${hostname}.csr`);
  const extFile  = path.join(CERTS_DIR, `${hostname}.ext`);

  if (!fs.existsSync(certFile)) {
    // Build SAN — include hostname + wildcard parent
    const parts = hostname.split('.');
    const san = parts.length > 2
      ? `DNS:${hostname},DNS:*.${parts.slice(1).join('.')}`
      : `DNS:${hostname}`;

    fs.writeFileSync(extFile, `subjectAltName=${san}\n`);
    try {
      run(`openssl req -new -key "${SRV_KEY}" -subj "/CN=${hostname}" -out "${csrFile}"`);
      run(`openssl x509 -req -days 365 -in "${csrFile}" -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial -extfile "${extFile}" -out "${certFile}"`);
    } finally {
      for (const f of [csrFile, extFile]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }

  const data = { key: fs.readFileSync(SRV_KEY), cert: fs.readFileSync(certFile) };
  certCache.set(hostname, data);
  return data;
}

// Injects X-Mitm-Host header after the first line of the HTTP request.
// Operates on the first chunk only — headers always arrive in the first segment.
function injectMitmHost(hostname) {
  let done = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (done) { this.push(chunk); cb(); return; }
      done = true;
      const s = chunk.toString('binary');
      const i = s.indexOf('\r\n');
      if (i === -1) { this.push(chunk); cb(); return; }
      const out = s.slice(0, i + 2) + `X-Mitm-Host: ${hostname}\r\n` + s.slice(i + 2);
      this.push(Buffer.from(out, 'binary'));
      cb();
    },
  });
}

function createConnectHandler(port) {
  return function onConnect(req, clientSocket, head) {
    clientSocket.on('error', () => {});

    const parts = (req.url || '').split(':');
    const hostname   = parts[0];
    const targetPort = parseInt(parts[1] || '443', 10);

    // Non-443: blind TCP tunnel (can't inspect, but don't break it)
    if (targetPort !== 443) {
      const tunnel = net.connect(targetPort, hostname);
      tunnel.on('error', () => clientSocket.destroy());
      tunnel.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) tunnel.write(head);
        tunnel.pipe(clientSocket);
        clientSocket.pipe(tunnel);
      });
      return;
    }

    // MITM for HTTPS (port 443)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    let certData;
    try {
      certData = getCert(hostname);
    } catch (err) {
      console.error('[MITM] cert error for', hostname, ':', err.message);
      clientSocket.destroy();
      return;
    }

    // Terminate TLS — force HTTP/1.1 (no h2 ALPN so we can read plain HTTP)
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: certData.key,
      cert: certData.cert,
      ALPNProtocols: ['http/1.1'],
    });
    tlsSocket.on('error', () => {});

    // Pipe decrypted traffic to our own Express HTTP server on the same port.
    // Inject X-Mitm-Host header so the proxy middleware knows which host to forward to.
    const loopback = net.connect(port, '127.0.0.1');
    loopback.on('error', () => tlsSocket.destroy());
    loopback.on('connect', () => {
      if (head && head.length) loopback.write(head);
      tlsSocket.pipe(injectMitmHost(hostname)).pipe(loopback);
      loopback.pipe(tlsSocket);
    });
  };
}

module.exports = { setupCA, createConnectHandler };
