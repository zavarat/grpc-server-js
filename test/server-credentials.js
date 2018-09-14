'use strict';
const Assert = require('assert');
const Fs = require('fs');
const Path = require('path');
const Barrier = require('cb-barrier');
const Lab = require('lab');
const Grpc = require('@grpc/grpc-js');
const { Server, ServerCredentials } = require('../lib');
const { loadProtoFile } = require('./common');

// Test shortcuts
const lab = exports.lab = Lab.script();
const { describe, it, before, after } = lab;


const ca = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'ca.pem'));
const key = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'server1.key'));
const cert = Fs.readFileSync(Path.join(__dirname, 'fixtures', 'server1.pem'));


describe('ServerCredentials', () => {
  describe('createSsl', () => {
    it('accepts a buffer and array as the first two arguments', () => {
      const creds = ServerCredentials.createSsl(ca, []);

      Assert.strictEqual(creds.secure, true);
      Assert.deepStrictEqual(creds.settings, {
        ca,
        cert: [],
        key: [],
        requestCert: false
      });
    });

    it('accepts a boolean as the third argument', () => {
      const creds = ServerCredentials.createSsl(ca, [], true);

      Assert.strictEqual(creds.secure, true);
      Assert.deepStrictEqual(creds.settings, {
        ca,
        cert: [],
        key: [],
        requestCert: true
      });
    });

    it('accepts an object with two buffers in the second argument', () => {
      const keyCertPairs = [{ privateKey: key, certChain: cert }];
      const creds = ServerCredentials.createSsl(null, keyCertPairs);

      Assert.strictEqual(creds.secure, true);
      Assert.deepStrictEqual(creds.settings, {
        ca: null,
        cert: [cert],
        key: [key],
        requestCert: false
      });
    });

    it('accepts multiple objects in the second argument', () => {
      const keyCertPairs = [
        { privateKey: key, certChain: cert },
        { privateKey: key, certChain: cert }
      ];
      const creds = ServerCredentials.createSsl(null, keyCertPairs, false);

      Assert.strictEqual(creds.secure, true);
      Assert.deepStrictEqual(creds.settings, {
        ca: null,
        cert: [cert, cert],
        key: [key, key],
        requestCert: false
      });
    });

    it('fails if the second argument is not an Array', () => {
      Assert.throws(() => {
        ServerCredentials.createSsl(ca, 'test');
      }, /TypeError: keyCertPairs must be an array/);
    });

    it('fails if the first argument is a non-Buffer value', () => {
      Assert.throws(() => {
        ServerCredentials.createSsl('test', []);
      }, /TypeError: rootCerts must be null or a Buffer/);
    });

    it('fails if the third argument is a non-boolean value', () => {
      Assert.throws(() => {
        ServerCredentials.createSsl(ca, [], 'test');
      }, /TypeError: checkClientCertificate must be a boolean/);
    });

    it('fails if the array elements are not objects', () => {
      Assert.throws(() => {
        ServerCredentials.createSsl(ca, ['test']);
      }, /TypeError: keyCertPair\[0\] must be an object/);

      Assert.throws(() => {
        ServerCredentials.createSsl(ca, [null]);
      }, /TypeError: keyCertPair\[0\] must be an object/);
    });

    it('fails if the object does not have a Buffer privateKey', () => {
      const keyCertPairs = [{ privateKey: 'test', certChain: cert }];

      Assert.throws(() => {
        ServerCredentials.createSsl(null, keyCertPairs);
      }, /TypeError: keyCertPair\[0\].privateKey must be a Buffer/);
    });

    it('fails if the object does not have a Buffer certChain', () => {
      const keyCertPairs = [{ privateKey: key, certChain: 'test' }];

      Assert.throws(() => {
        ServerCredentials.createSsl(null, keyCertPairs);
      }, /TypeError: keyCertPair\[0\].certChain must be a Buffer/);
    });
  });

  it('should bind to an unused port with ssl credentials', async () => {
    const keyCertPairs = [{ privateKey: key, certChain: cert }];
    const creds = ServerCredentials.createSsl(ca, keyCertPairs, true);
    const server = new Server();

    await server.bind('localhost:0', creds);
    server.start();
    server.tryShutdown();
  });

  it('should bind to an unused port with insecure credentials', async () => {
    const server = new Server();

    await server.bind('localhost:0', ServerCredentials.createInsecure());
    server.start();
    server.tryShutdown();
  });
});

describe('client credentials', () => {
  let Client;
  let server;
  let port;
  let clientSslCreds;
  const clientOptions = {};
  function noop () {}

  before(async () => {
    const proto = loadProtoFile(Path.join(__dirname, 'proto', 'test_service.proto'));

    server = new Server();
    server.addService(proto.TestService.service, {
      unary (call, cb) {
        // TODO: Revisit when sendMetadata() is implemented.
        // call.sendMetadata(call.metadata);
        cb(null, {});
      },

      clientStream (stream, cb) {
        stream.on('data', noop);
        stream.on('end', () => {
          // TODO: Revisit when sendMetadata() is implemented.
          // stream.sendMetadata(stream.metadata);
          cb(null, {});
        });
      },

      serverStream (stream) {
        // TODO: Revisit when sendMetadata() is implemented.
        // stream.sendMetadata(stream.metadata);
        stream.end();
      },

      bidiStream (stream) {
        stream.on('data', noop);
        stream.on('end', () => {
          // TODO: Revisit when sendMetadata() is implemented.
          // stream.sendMetadata(stream.metadata);
          stream.end();
        });
      }
    });

    const keyCertPairs = [{ privateKey: key, certChain: cert }];
    const creds = ServerCredentials.createSsl(null, keyCertPairs);
    port = await server.bind('localhost:0', creds);
    server.start();

    Client = proto.TestService;
    clientSslCreds = Grpc.credentials.createSsl(ca);
    const hostOverride = 'foo.test.google.fr';
    clientOptions['grpc.ssl_target_name_override'] = hostOverride;
    clientOptions['grpc.default_authority'] = hostOverride;
  });

  after(() => {
    // TODO: Use forceShutdown() once implemented.
    server.tryShutdown();
  });

  it('Should accept SSL creds for a client', () => {
    const barrier = new Barrier();
    const client = new Client(`localhost:${port}`, clientSslCreds, clientOptions);

    client.unary({}, (err, data) => {
      Assert.ifError(err);
      barrier.pass();
    });

    return barrier;
  });

  it('Verify callback receives correct arguments', () => {
    const barrier = new Barrier();
    let callbackHost;
    let callbackCert;
    const clientSslCreds = Grpc.credentials.createSsl(ca, null, null, {
      checkServerIdentity (host, cert) {
        callbackHost = host;
        callbackCert = cert;
      }
    });
    const client = new Client(`localhost:${port}`, clientSslCreds, clientOptions);

    client.unary({}, (err, data) => {
      Assert.ifError(err);

      // TODO: These values don't seem to be set by the JavaScript client yet.
      // If that changes in the future, update these assertions.
      Assert.strictEqual(callbackHost, undefined);
      Assert.strictEqual(callbackCert, undefined);

      Assert.deepStrictEqual(data, { count: 0 });
      barrier.pass();
    });

    return barrier;
  });

  describe('Per-rpc creds', () => {
    let client;
    let updaterCreds;

    before(() => {
      client = new Client(`localhost:${port}`, clientSslCreds, clientOptions);

      function metadataUpdater (serviceUrl, callback) {
        const metadata = new Grpc.Metadata();

        metadata.set('plugin_key', 'plugin_value');
        callback(null, metadata);
      }

      updaterCreds = Grpc.credentials.createFromMetadataGenerator(metadataUpdater);
    });

    // TODO: Revisit this. Expected metadata is not being sent back from the server.
    it('Should update metadata on a unary call', { skip: true }, () => {
      const barrier = new Barrier(2);
      const call = client.unary({}, { credentials: updaterCreds }, (err, data) => {
        Assert.ifError(err);
        barrier.pass();
      });

      call.on('metadata', (metadata) => {
        Assert.deepStrictEqual(metadata.get('plugin_key'), ['plugin_value']);
        barrier.pass();
      });

      return barrier;
    });

    // TODO: Revisit this. Expected metadata is not being sent back from the server.
    it('should update metadata on a client streaming call', { skip: true }, () => {
      const barrier = new Barrier(2);
      const call = client.clientStream({ credentials: updaterCreds }, (err, data) => {
        Assert.ifError(err);
        barrier.pass();
      });

      call.on('metadata', (metadata) => {
        Assert.deepStrictEqual(metadata.get('plugin_key'), ['plugin_value']);
        barrier.pass();
      });

      call.end();
      return barrier;
    });

    // TODO: Revisit this. Expected metadata is not being sent back from the server.
    it('should update metadata on a server streaming call', { skip: true }, () => {
      const barrier = new Barrier();
      const call = client.serverStream({}, { credentials: updaterCreds });

      call.on('data', noop);
      call.on('metadata', (metadata) => {
        Assert.deepStrictEqual(metadata.get('plugin_key'), ['plugin_value']);
        barrier.pass();
      });

      return barrier;
    });

    // TODO: Revisit this. Expected metadata is not being sent back from the server.
    it('should update metadata on a bidi streaming call', { skip: true }, () => {
      const barrier = new Barrier();
      const call = client.bidiStream({ credentials: updaterCreds });

      call.on('data', noop);
      call.on('metadata', (metadata) => {
        Assert.deepStrictEqual(metadata.get('plugin_key'), ['plugin_value']);
        barrier.pass();
      });

      call.end();
      return barrier;
    });

    // TODO: Revisit this. Expected metadata is not being sent back from the server.
    it('should be able to use multiple plugin credentials', { skip: true }, () => {
      function altMetadataUpdater (serviceUrl, callback) {
        const metadata = new Grpc.Metadata();

        metadata.set('other_plugin_key', 'other_plugin_value');
        callback(null, metadata);
      }

      const barrier = new Barrier(2);
      const altUpdaterCreds = Grpc.credentials.createFromMetadataGenerator(altMetadataUpdater);
      const combinedUpdater = Grpc.credentials.combineCallCredentials(updaterCreds, altUpdaterCreds);
      const call = client.unary({}, { credentials: combinedUpdater }, (err, data) => {
        Assert.ifError(err);
        barrier.pass();
      });

      call.on('metadata', (metadata) => {
        Assert.deepStrictEqual(metadata.get('plugin_key'), ['plugin_value']);
        Assert.deepStrictEqual(metadata.get('other_plugin_key'), ['other_plugin_value']);
        barrier.pass();
      });

      return barrier;
    });
  });
});