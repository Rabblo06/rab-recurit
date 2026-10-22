'use strict';
/**
 * Test-only SMTP sink for the isolated Worker-bundle integration stack. Accepts every message on port 2525 and writes it
 * to /out/<n>.eml. It never relays anything anywhere: there is no outbound connection code in this file at all.
 */
const fs = require('node:fs');
const net = require('node:net');

let counter = 0;
net
  .createServer((socket) => {
    let buffer = '';
    let inData = false;
    let message = [];
    let envelope = { from: '', to: [] };
    socket.write('220 bundle-test-sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            counter += 1;
            const file = `/out/${Date.now()}-${counter}.eml`;
            fs.writeFileSync(file, `X-Sink-Mail-From: ${envelope.from}\nX-Sink-Rcpt-To: ${envelope.to.join(',')}\n${message.join('\n')}\n`);
            console.log(`smtp-sink: stored ${file} for ${envelope.to.join(',')}`);
            message = [];
            envelope = { from: '', to: [] };
            socket.write('250 OK stored\r\n');
          } else {
            message.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-bundle-test-sink\r\n250 SIZE 10485760\r\n');
        else if (verb === 'HELO') socket.write('250 bundle-test-sink\r\n');
        else if (verb === 'MAIL') {
          envelope.from = line.slice(10).trim();
          socket.write('250 OK\r\n');
        } else if (verb === 'RCPT') {
          envelope.to.push(line.slice(8).trim());
          socket.write('250 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 OK\r\n');
        else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  })
  .listen(2525, () => console.log('smtp-sink: listening on 2525'));
