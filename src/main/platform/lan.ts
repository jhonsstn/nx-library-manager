import { createSocket } from 'node:dgram';

/**
 * Detects the LAN address used for the DBI directory URL.
 *
 * Ports `http_server.local_lan_ip`: open a UDP socket toward a public address and
 * read back the local interface the OS picked. No packets are sent.
 */
export function detectLanIp(timeoutMs = 1000): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const socket = createSocket('udp4');
  let settled = false;
  const finish = (address: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.close();
    resolve(address);
  };
  const timer = setTimeout(() => finish('127.0.0.1'), timeoutMs);

  socket.on('error', () => finish('127.0.0.1'));
  try {
    socket.connect(80, '8.8.8.8', () => {
      const address = socket.address();
      finish(typeof address === 'string' ? '127.0.0.1' : address.address);
    });
  } catch {
    finish('127.0.0.1');
  }
  return promise;
}

/** Exact shape of the URL shown in Settings and pasted into DBI. */
export function switchDirectoryUrl(ip: string, port: number): string {
  return `http://${ip}:${port || 8000}/dir/`;
}
