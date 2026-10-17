// Preloaded with --import by tests/gate-security.test.ts: any network, DNS or child-process call the CLI makes is
// reported on stderr as "SENTINEL <call>" and fails. The Permission Model blocks child processes on every supported
// Node.js version but the network only from 25 on; this covers 22 and 24 too.
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const deny = (call) =>
    function denied() {
        process.stderr.write(`SENTINEL ${call}\n`);
        throw new Error(`Denied by the test sentinel: ${call}`);
    };

net.Socket.prototype.connect = deny('net.Socket.connect');
net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
net.Server.prototype.listen = deny('net.Server.listen');
tls.connect = deny('tls.connect');
dgram.Socket.prototype.send = deny('dgram.send');
dgram.Socket.prototype.bind = deny('dgram.bind');
dns.lookup = deny('dns.lookup');
dns.resolve = deny('dns.resolve');
dns.promises.lookup = deny('dns.promises.lookup');
http.request = deny('http.request');
https.request = deny('https.request');
globalThis.fetch = deny('fetch');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = deny(`child_process.${name}`);
}
syncBuiltinESMExports();
