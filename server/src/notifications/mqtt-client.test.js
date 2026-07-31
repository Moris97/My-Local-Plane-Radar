import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  encodeRemainingLength,
  decodeRemainingLength,
  encodeUtf8String,
  buildConnectPacket,
  buildPublishPacket,
  MqttPacketReader,
  MqttClient,
} from './mqtt-client.js';

test('encodeRemainingLength matches the spec examples (0, 127, 128, 16383, 16384)', () => {
  assert.deepEqual(encodeRemainingLength(0), Buffer.from([0x00]));
  assert.deepEqual(encodeRemainingLength(127), Buffer.from([0x7f]));
  assert.deepEqual(encodeRemainingLength(128), Buffer.from([0x80, 0x01]));
  assert.deepEqual(encodeRemainingLength(16383), Buffer.from([0xff, 0x7f]));
  assert.deepEqual(encodeRemainingLength(16384), Buffer.from([0x80, 0x80, 0x01]));
});

test('decodeRemainingLength round-trips every encoded value', () => {
  for (const n of [0, 1, 127, 128, 300, 16383, 16384, 2097151]) {
    const encoded = encodeRemainingLength(n);
    const decoded = decodeRemainingLength(encoded, 0);
    assert.equal(decoded.value, n);
    assert.equal(decoded.bytesUsed, encoded.length);
  }
});

test('decodeRemainingLength returns null when the buffer is truncated mid-field', () => {
  // 16384 encodes to 3 bytes (0x80 0x80 0x01) -- only 2 available yet.
  const truncated = encodeRemainingLength(16384).subarray(0, 2);
  assert.equal(decodeRemainingLength(truncated, 0), null);
});

test('encodeUtf8String is a 2-byte big-endian length prefix + UTF-8 bytes', () => {
  assert.deepEqual(encodeUtf8String('MQTT'), Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]));
  assert.deepEqual(encodeUtf8String(''), Buffer.from([0x00, 0x00]));
});

test('buildConnectPacket sets clean-session bit and no other flags for a bare connect', () => {
  const packet = buildConnectPacket({ clientId: 'mlpr', keepAliveSec: 60 });
  assert.equal(packet[0], 0x10); // CONNECT, no flags
  // Variable header: "MQTT" (6 bytes) + level (1) + connect flags (1) + keepalive (2) = 10 bytes.
  const connectFlags = packet[1 + 1 + 6 + 1]; // after fixed header(2) + protocol name(6) + level(1)
  assert.equal(connectFlags, 0x02, 'only Clean Session bit set');
  const clientIdStart = 1 + 1 + 10; // fixed header + remaining-length(1 byte) + variable header(10)
  const clientIdPayload = packet.subarray(clientIdStart);
  assert.deepEqual(clientIdPayload, encodeUtf8String('mlpr'));
});

test('buildConnectPacket sets username/password/will flags and appends fields in spec order', () => {
  const packet = buildConnectPacket({
    clientId: 'mlpr',
    keepAliveSec: 30,
    username: 'user1',
    password: 'pass1',
    will: { topic: 'mlpr/status', payload: 'offline', retain: true },
  });
  const connectFlags = packet[1 + 1 + 6 + 1];
  // User Name (0x80) + Password (0x40) + Will Flag (0x04) + Will Retain (0x20) + Clean Session (0x02)
  assert.equal(connectFlags, 0x80 | 0x40 | 0x04 | 0x20 | 0x02);

  const payloadStart = 1 + 1 + 10;
  const payload = packet.subarray(payloadStart);
  let offset = 0;
  function readString() {
    const len = payload.readUInt16BE(offset);
    const str = payload.subarray(offset + 2, offset + 2 + len).toString('utf8');
    offset += 2 + len;
    return str;
  }
  assert.equal(readString(), 'mlpr'); // client id
  assert.equal(readString(), 'mlpr/status'); // will topic
  assert.equal(readString(), 'offline'); // will payload
  assert.equal(readString(), 'user1'); // username
  assert.equal(readString(), 'pass1'); // password
  assert.equal(offset, payload.length, 'no trailing bytes left unaccounted for');
});

test('buildPublishPacket has no packet identifier (QoS 0) and sets the retain bit', () => {
  const packet = buildPublishPacket({ topic: 'mlpr/events/first_seen', payload: '{"hex":"abc123"}' });
  assert.equal(packet[0] & 0xf0, 0x30); // PUBLISH type
  assert.equal(packet[0] & 0x01, 0); // retain not set

  const retained = buildPublishPacket({ topic: 't', payload: 'x', retain: true });
  assert.equal(retained[0] & 0x01, 1);

  const decoded = decodeRemainingLength(packet, 1);
  const variableHeaderAndPayload = packet.subarray(1 + decoded.bytesUsed);
  const topicLen = variableHeaderAndPayload.readUInt16BE(0);
  const topic = variableHeaderAndPayload.subarray(2, 2 + topicLen).toString('utf8');
  const body = variableHeaderAndPayload.subarray(2 + topicLen).toString('utf8');
  assert.equal(topic, 'mlpr/events/first_seen');
  assert.equal(body, '{"hex":"abc123"}');
});

test('MqttPacketReader parses a single chunk containing two full packets (CONNACK + PINGRESP)', () => {
  const reader = new MqttPacketReader();
  const connack = Buffer.from([0x20, 0x02, 0x00, 0x00]); // session-present=0, return-code=0
  const pingresp = Buffer.from([0xd0, 0x00]);
  const packets = reader.push(Buffer.concat([connack, pingresp]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].type, 2); // CONNACK
  assert.equal(packets[0].body[1], 0); // return code accepted
  assert.equal(packets[1].type, 13); // PINGRESP
});

test('MqttPacketReader buffers a packet split across multiple chunks', () => {
  const reader = new MqttPacketReader();
  const connack = Buffer.from([0x20, 0x02, 0x00, 0x00]);
  assert.equal(reader.push(connack.subarray(0, 2)).length, 0, 'incomplete packet yields nothing yet');
  const packets = reader.push(connack.subarray(2));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 2);
});

// -- End-to-end against an in-process fake broker --
//
// Not a real Mosquitto (none available in this sandbox / CI), but a
// from-scratch, independently-written server-side decoder -- deliberately
// NOT reusing MqttClient's own encode/decode helpers, so a bug shared
// between "what we send" and "what we assert" can't hide from this test.
function startFakeBroker() {
  const receivedPublishes = [];
  let resolveConnect;
  const connectedPromise = new Promise((resolve) => { resolveConnect = resolve; });

  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const type = (buf[0] >> 4) & 0x0f;
        // Minimal, independent remaining-length decode (single-byte only --
        // every packet this test broker needs to understand fits under 128 bytes).
        const remaining = buf[1];
        const totalLen = 2 + remaining;
        if (buf.length < totalLen) return;
        const body = buf.subarray(2, totalLen);
        buf = buf.subarray(totalLen);

        if (type === 1) { // CONNECT
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK, accepted
          resolveConnect();
        } else if (type === 3) { // PUBLISH
          const topicLen = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + topicLen).toString('utf8');
          const payload = body.subarray(2 + topicLen).toString('utf8');
          receivedPublishes.push({ topic, payload });
        } else if (type === 12) { // PINGREQ
          socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `mqtt://127.0.0.1:${port}`,
        receivedPublishes,
        connectedPromise,
        close: () => server.close(),
      });
    });
  });
}

test('MqttClient connects to a real TCP broker and publish() is received intact', async () => {
  const broker = await startFakeBroker();
  const client = new MqttClient({ url: broker.url, clientId: 'test-client', keepAliveSec: 60 });

  const connected = await new Promise((resolve, reject) => {
    client.connect({ onConnect: () => resolve(true), onFailure: (msg) => reject(new Error(msg)) });
  });
  assert.equal(connected, true);
  assert.equal(client.connected, true);

  const published = client.publish('mlpr/events/first_seen', JSON.stringify({ hex: 'abc123', typeCode: 'A20N' }));
  assert.equal(published, true);

  // Give the fake broker's socket a tick to receive/parse the PUBLISH.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(broker.receivedPublishes.length, 1);
  assert.equal(broker.receivedPublishes[0].topic, 'mlpr/events/first_seen');
  assert.deepEqual(JSON.parse(broker.receivedPublishes[0].payload), { hex: 'abc123', typeCode: 'A20N' });

  client.disconnect();
  broker.close();
});

test('MqttClient.publish() is a no-op (returns false) when not yet connected', () => {
  const client = new MqttClient({ url: 'mqtt://127.0.0.1:1', clientId: 'test-client' });
  assert.equal(client.publish('t', 'x'), false);
});

test('MqttClient reports failure via onFailure for an unreachable broker', async () => {
  // Port 1 is reserved and nothing listens there. Whether that actually
  // fails fast (ECONNREFUSED) or just hangs with no error at all depends
  // on the network environment -- it hung indefinitely in this project's
  // own sandbox, which is exactly the real bug connectTimeoutMs now
  // guards against. A short connectTimeoutMs here means this test stays
  // fast and deterministic either way, instead of assuming a refusal.
  const client = new MqttClient({
    url: 'mqtt://127.0.0.1:1', clientId: 'test-client', reconnectDelayMs: 60000, connectTimeoutMs: 100,
  });
  const message = await new Promise((resolve) => {
    client.connect({ onConnect: () => resolve(null), onFailure: (msg) => resolve(msg) });
  });
  assert.ok(message, 'onFailure should have been called with a reason');
  client.disconnect();
});

test('MqttClient reports a timeout failure if the connection never completes within connectTimeoutMs', async () => {
  // A real listening TCP server whose 'connection' handler simply never
  // does anything -- Node's net server always completes the TCP
  // handshake itself before the 'connection' event fires, so the client's
  // 'connect' event fires immediately here too (this is NOT testing a
  // stalled handshake, real network conditions for that aren't
  // reproducible portably). What this deterministically exercises instead
  // is connectTimeoutMs racing a connection that succeeds at the TCP
  // level but the MQTT handshake (CONNACK) never arrives -- proving the
  // timer is real and does fire with the expected message, not just that
  // *some* error eventually surfaces (already covered by the test above).
  const server = createServer(() => {}); // accepts, then does nothing
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const client = new MqttClient({
    url: `mqtt://127.0.0.1:${port}`, clientId: 'test-client', reconnectDelayMs: 60000, connectTimeoutMs: 50,
  });
  const message = await new Promise((resolve) => {
    client.connect({ onConnect: () => resolve(null), onFailure: (msg) => resolve(msg) });
  });
  assert.match(message, /timed out after 50ms/);
  client.disconnect();
  server.close();
});
