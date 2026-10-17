// Reaches the network at import time: TCP to LSV_ADVERSARIAL_TCP (host:port), fetch, DNS and UDP.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { attempt } from './common.mjs';

const [host, port] = process.env.LSV_ADVERSARIAL_TCP.split(':');

function connect() {
    return new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), host);
        socket.on('connect', () => {
            socket.destroy();
            resolve('connected');
        });
        socket.on('error', reject);
    });
}

function udp() {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.on('error', reject);
        socket.send('x', Number(port), host, (error) => {
            socket.close();
            error ? reject(error) : resolve('sent');
        });
    });
}

export const outcome = {
    tcp: await attempt(connect),
    fetch: await attempt(async () => (await fetch(`http://${host}:${port}/`), 'fetched')),
    dns: await attempt(async () => (await dns.lookup('example.com'), 'resolved')),
    udp: await attempt(udp),
};
