const tls = require('node:tls');
const net = require('node:net');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CERTS_DIR = path.join(os.homedir(), '.llm-proxyman', 'certs');
const CA_KEY  = path.join(CERTS_DIR, 'ca.key');
const CA_CERT = path.join(CERTS_DIR, 'ca.crt');
const SRV_KEY = path.join(CERTS_DIR, 'server.key');

const certCache = new Map();

function run(cmd) { execSync(cmd, { stdio: 'pipe' }); }

function detectOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

function checkCATrusted(caCertPath) {
  const osName = detectOS();
  if (osName === 'unknown') return false;

  try {
    if (osName === 'macos') {
      execSync(`security find-certificate -c "llm-proxyman CA" /Library/Keychains/System.keychain 2>/dev/null`, { stdio: 'pipe' });
      return true;
    }
    if (osName === 'linux') {
      const out = execSync(`openssl x509 -noout -text -in "${caCertPath}" 2>/dev/null`, { encoding: 'utf8' });
      if (!out.includes('llm-proxyman CA')) return false;
      // Check if it's in the system trust store
      const storePaths = [
        '/etc/ssl/certs/llm-proxyman.pem',
        '/usr/share/ca-certificates/local/llm-proxyman.crt',
      ];
      for (const sp of storePaths) {
        try {
          if (fs.existsSync(sp)) return true;
        } catch {}
      }
      return false;
    }
    if (osName === 'windows') {
      execSync('powershell -NoProfile -Command "Get-ChildItem cert:\\Root\\,cert:\\Trust\\ | Where-Object { $_.Subject -like \'*llm-proxyman*\' }" 2>&1 | Out-Null', { stdio: 'pipe' });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function printTrustInstructions(caCertPath) {
  const osName = detectOS();
  console.log(`[MITM] CA cert generated: ${caCertPath}`);

  if (osName === 'macos') {
    console.log('[MITM] Trust the CA certificate once with:');
    console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caCertPath}"`);
    console.log('[MITM] Then restart the proxy.');
  } else if (osName === 'linux') {
    console.log('[MITM] Trust the CA certificate:');
    console.log(`  sudo cp "${caCertPath}" /usr/local/share/ca-certificates/llm-proxyman.crt`);
    console.log('  sudo update-ca-certificates');
    console.log('[MITM] Then restart the proxy.');
  } else if (osName === 'windows') {
    console.log('[MITM] Trust the CA certificate by double-clicking:');
    console.log(`  ${caCertPath}`);
    console.log('[MITM] Then install → Trust in Trusted Root Certification Authorities.');
    console.log('[MITM] Then restart the proxy.');
  } else {
    console.log(`[MITM] Manually trust: ${caCertPath}`);
  }
}

function setupCA() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (!fs.existsSync(CA_CERT)) {
    console.log('[MITM] Generating CA certificate...');
    run(`openssl genrsa -out "${CA_KEY}" 2048`);
    run(`openssl req -new -x509 -days 3650 -key "${CA_KEY}" -out "${CA_CERT}" -subj "/CN=llm-proxyman CA/O=llm-proxyman"`);
    run(`openssl genrsa -out "${SRV_KEY}" 2048`);
  }

  const trusted = checkCATrusted(CA_CERT);
  if (!trusted) {
    printTrustInstructions(CA_CERT);
  } else {
    console.log(`[MITM] CA cert already trusted: ${CA_CERT}`);
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

// Maps loopback socket localPort → original CONNECT hostname.
// Used by proxy middleware to route MITM requests to the correct upstream.
// Keyed by port so it works across all keep-alive requests on the same connection.
const mitmHosts = new Map();

function createConnectHandler(port) {
  return function onConnect(req, clientSocket, head) {
    clientSocket.on('error', () => {});

    const parts = (req.url || '').split(':');
    const hostname   = parts[0];
    const targetPort = parseInt(parts[1] || '443', 10);
    console.log(`[MITM] CONNECT ${hostname}:${targetPort}`);

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
      // Register hostname by port so proxy middleware can look it up for every
      // request on this connection (including keep-alive follow-up requests)
      mitmHosts.set(loopback.localPort, hostname);
      if (head && head.length) loopback.write(head);
      tlsSocket.pipe(loopback);
      loopback.pipe(tlsSocket);
    });

    // Propagate closes in both directions so neither side hangs
    tlsSocket.on('close', () => loopback.destroy());
    loopback.on('close', () => {
      mitmHosts.delete(loopback.localPort);
      tlsSocket.destroy();
    });
  };
}

module.exports = { setupCA, createConnectHandler, mitmHosts };
