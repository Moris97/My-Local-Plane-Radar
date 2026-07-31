// Hand-rolled MQTT 3.1.1 client -- publish-only, QoS 0, no subscribe.
//
// Why hand-rolled instead of the `mqtt` npm package: a *full* MQTT client
// (QoS 1/2 ack tracking, subscriptions, MQTT 5, WebSocket transport) is
// genuinely more than "a few dozen lines" and would justify a dependency.
// But MLPR only ever needs to PUBLISH, fire-and-forget (losing one smart-
// home event because the broker was briefly unreachable is an acceptable
// failure mode -- the same trade-off already made for ntfy delivery). That
// subset of the protocol is small, stable (MQTT 3.1.1 hasn't changed in
// years), and testable against a real broker -- exactly the kind of thing
// this codebase already prefers to hand-write over adding a dependency
// (see the OpenFlights CSV parser, the sunrise-equation daylight code, the
// hand-rolled chart rendering). Runs over Node's built-in `net`/`tls`, so
// `mqtts://` support is free -- no extra protocol work, just a different
// socket constructor.
//
// What's deliberately NOT implemented, because nothing here needs it:
// QoS 1/2 (acks, packet IDs, retry queues), subscribing (PUBACK/SUBSCRIBE/
// SUBACK/UNSUBSCRIBE), MQTT 5's extra properties, WebSocket transport.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const PACKET_TYPE = { CONNACK: 2, PUBLISH: 3, PINGRESP: 13 };
const PINGREQ_PACKET = Buffer.from([0xc0, 0x00]);
const DISCONNECT_PACKET = Buffer.from([0xe0, 0x00]);

// MQTT's "Remaining Length" field: a variable-length integer, 1-4 bytes,
// 7 payload bits per byte with the 8th bit as a continuation flag.
export function encodeRemainingLength(length) {
  const bytes = [];
  let x = length;
  do {
    let digit = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) digit |= 0x80;
    bytes.push(digit);
  } while (x > 0);
  return Buffer.from(bytes);
}

// Returns null if `buf` doesn't yet contain the full remaining-length field
// (the caller has more bytes coming on a later `data` event) -- not an
// error, just "not enough buffered yet".
export function decodeRemainingLength(buf, offset) {
  let multiplier = 1;
  let value = 0;
  let i = offset;
  let byte;
  do {
    if (i >= buf.length) return null;
    byte = buf[i];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    i += 1;
    if (multiplier > 128 * 128 * 128 * 128) throw new Error('malformed remaining-length field');
  } while ((byte & 0x80) !== 0);
  return { value, bytesUsed: i - offset };
}

export function encodeUtf8String(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([(strBuf.length >> 8) & 0xff, strBuf.length & 0xff]), strBuf]);
}

// will: { topic, payload, retain } | undefined -- always QoS 0 (matches
// every publish this client ever sends).
export function buildConnectPacket({ clientId, keepAliveSec, username, password, will }) {
  let flags = 0x02; // Clean Session -- no persistent session/subscriptions to resume, we never subscribe.
  const payloadParts = [encodeUtf8String(clientId)];

  if (will) {
    flags |= 0x04;
    if (will.retain) flags |= 0x20;
    payloadParts.push(encodeUtf8String(will.topic));
    payloadParts.push(encodeUtf8String(will.payload ?? ''));
  }
  if (username) {
    flags |= 0x80;
    payloadParts.push(encodeUtf8String(username));
  }
  if (password) {
    flags |= 0x40;
    payloadParts.push(encodeUtf8String(password));
  }

  const variableHeader = Buffer.concat([
    encodeUtf8String('MQTT'),
    Buffer.from([0x04, flags, (keepAliveSec >> 8) & 0xff, keepAliveSec & 0xff]),
  ]);
  const payload = Buffer.concat(payloadParts);
  const remaining = encodeRemainingLength(variableHeader.length + payload.length);
  return Buffer.concat([Buffer.from([0x10]), remaining, variableHeader, payload]);
}

// QoS 0 only -- no packet identifier in the variable header, no PUBACK to
// wait for. `retain` is the only per-publish flag this client ever needs.
export function buildPublishPacket({ topic, payload, retain = false }) {
  const topicBuf = encodeUtf8String(topic);
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const remaining = encodeRemainingLength(topicBuf.length + payloadBuf.length);
  const fixedHeaderByte = 0x30 | (retain ? 0x01 : 0x00);
  return Buffer.concat([Buffer.from([fixedHeaderByte]), remaining, topicBuf, payloadBuf]);
}

// Accumulates raw TCP bytes across `data` events and yields complete MQTT
// packets -- a socket delivers a byte stream, not message boundaries, so a
// single `data` chunk can hold half a packet, exactly one, or several.
export class MqttPacketReader {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const packets = [];
    for (;;) {
      if (this._buf.length < 2) break;
      const decoded = decodeRemainingLength(this._buf, 1);
      if (!decoded) break;
      const headerLen = 1 + decoded.bytesUsed;
      const totalLen = headerLen + decoded.value;
      if (this._buf.length < totalLen) break;
      const firstByte = this._buf[0];
      packets.push({ type: (firstByte >> 4) & 0x0f, flags: firstByte & 0x0f, body: this._buf.subarray(headerLen, totalLen) });
      this._buf = this._buf.subarray(totalLen);
    }
    return packets;
  }
}

const DEFAULT_KEEPALIVE_SEC = 60;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

// Fire-and-forget, auto-reconnecting publisher. `will` (if given) is sent
// as part of CONNECT and delivered by the *broker* if this client
// disconnects uncleanly (crash, network drop) -- the standard MQTT
// "availability" pattern (see smart-home.js's use of it for mlpr/status).
export class MqttClient {
  constructor({
    url, clientId, username, password, will,
    keepAliveSec = DEFAULT_KEEPALIVE_SEC,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  }) {
    this.url = url;
    this.clientId = clientId;
    this.username = username;
    this.password = password;
    this.will = will;
    this.keepAliveSec = keepAliveSec;
    this.reconnectDelayMs = reconnectDelayMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this._socket = null;
    this._connectTimer = null;
    this._reader = new MqttPacketReader();
    this._connected = false;
    this._intentionalDisconnect = false;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._onConnect = null; // test hook, see connect()
  }

  get connected() {
    return this._connected;
  }

  // `onConnect`/`onFailure` are one-shot callbacks for the FIRST connection
  // attempt only (used by the Settings "test connection" button, which
  // wants a single pass/fail rather than an open-ended reconnect loop) --
  // reconnects after that never call them again.
  connect({ onConnect, onFailure } = {}) {
    this._intentionalDisconnect = false;
    this._firstAttemptCallbacks = { onConnect, onFailure };
    this._openSocket();
  }

  _openSocket() {
    let parsed;
    try {
      parsed = new URL(this.url);
    } catch {
      this._reportFailure(`invalid broker URL: ${this.url}`);
      return;
    }
    const isTls = parsed.protocol === 'mqtts:';
    const port = Number(parsed.port) || (isTls ? 8883 : 1883);
    const connectFn = isTls ? tlsConnect : netConnect;

    let socket;
    try {
      socket = connectFn({ host: parsed.hostname, port });
    } catch (err) {
      this._reportFailure(err.message);
      this._scheduleReconnect();
      return;
    }
    this._socket = socket;
    this._reader = new MqttPacketReader();

    // Guards the whole path from opening the socket to a successful
    // CONNACK -- cleared in _handlePacket() below on CONNACK, not on the
    // plain TCP 'connect' event, since a broker that accepts the TCP
    // handshake but never actually answers the MQTT CONNECT (hung,
    // overloaded, wrong port with some other service listening) is just as
    // real a failure mode as the handshake itself never completing. A
    // plain one-shot setTimeout, not socket.setTimeout()/the `timeout`
    // connect option (which resets on any read/write and would otherwise
    // misfire on a healthy, merely-quiet *already-connected* session
    // between our own keepalive pings, tens of seconds apart -- this timer
    // only ever needs to run once, for the initial handshake). Without
    // this at all, an address that never actively refuses or completes
    // the connection (firewalled/dropped rather than ECONNREFUSED, or a
    // silent broker) left the socket -- and the caller awaiting
    // onConnect/onFailure -- hanging forever, since neither 'error' nor
    // 'close' ever fired. Caught via a real hang in this file's own test
    // suite, not a live report.
    this._connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connection timed out after ${this.connectTimeoutMs}ms`));
    }, this.connectTimeoutMs);

    socket.on('connect', () => {
      socket.write(buildConnectPacket({
        clientId: this.clientId,
        keepAliveSec: this.keepAliveSec,
        username: this.username,
        password: this.password,
        will: this.will,
      }));
    });

    socket.on('data', (chunk) => {
      let packets;
      try {
        packets = this._reader.push(chunk);
      } catch (err) {
        console.warn(`[mqtt] malformed packet from broker: ${err.message}`);
        socket.destroy();
        return;
      }
      for (const packet of packets) this._handlePacket(packet);
    });

    socket.on('error', (err) => {
      clearTimeout(this._connectTimer);
      console.warn(`[mqtt] connection error: ${err.message}`);
      this._reportFailure(err.message);
    });

    socket.on('close', () => {
      clearTimeout(this._connectTimer);
      this._connected = false;
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      if (!this._intentionalDisconnect) this._scheduleReconnect();
    });
  }

  _handlePacket(packet) {
    if (packet.type === PACKET_TYPE.CONNACK) {
      clearTimeout(this._connectTimer);
      const returnCode = packet.body[1];
      if (returnCode === 0) {
        this._connected = true;
        this._pingTimer = setInterval(
          () => this._socket?.writable && this._socket.write(PINGREQ_PACKET),
          Math.max(1000, this.keepAliveSec * 1000 * 0.5),
        );
        this._reportSuccess();
      } else {
        console.warn(`[mqtt] broker refused connection (return code ${returnCode})`);
        this._reportFailure(`broker refused connection (return code ${returnCode})`);
        this._socket?.destroy();
      }
    }
    // PUBLISH/PINGRESP need no action -- we never subscribe, so a PUBLISH
    // from the broker should never arrive; PINGRESP just confirms liveness.
  }

  _reportSuccess() {
    this._firstAttemptCallbacks?.onConnect?.();
    this._firstAttemptCallbacks = null;
  }

  _reportFailure(message) {
    this._firstAttemptCallbacks?.onFailure?.(message);
    this._firstAttemptCallbacks = null;
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._openSocket(), this.reconnectDelayMs);
  }

  publish(topic, payload, { retain = false } = {}) {
    if (!this._connected || !this._socket) return false;
    this._socket.write(buildPublishPacket({ topic, payload, retain }));
    return true;
  }

  disconnect() {
    this._intentionalDisconnect = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    if (this._socket && this._connected) {
      try {
        this._socket.write(DISCONNECT_PACKET);
      } catch {
        // Closing anyway -- a failed clean-disconnect write isn't worth surfacing.
      }
    }
    this._socket?.end();
    this._socket?.destroy();
    this._connected = false;
  }
}
