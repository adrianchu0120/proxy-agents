import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { promisify } from 'util';
import { once } from 'events';
import assert from 'assert';
import WebSocket, { WebSocketServer } from 'ws';
import { json, req } from 'agent-base';
import { ProxyServer, createProxy } from 'proxy';
// @ts-expect-error no types
import socks from 'socksv5';
import { listen } from 'async-listen';
import { ProxyAgent } from '../src';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const sslOptions = {
	key: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.key'),
	cert: fs.readFileSync(__dirname + '/ssl-cert-snakeoil.pem'),
};

describe('ProxyAgent', () => {
	// target servers
	let httpServer: http.Server;
	let httpWebSocketServer: WebSocketServer;
	let httpServerUrl: URL;
	let httpsServer: https.Server;
	let httpsWebSocketServer: WebSocketServer;
	let httpsServerUrl: URL;

	// proxy servers
	let httpProxyServer: ProxyServer;
	let httpProxyServerUrl: URL;
	let httpsProxyServer: ProxyServer;
	let httpsProxyServerUrl: URL;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let socksServer: any;
	let socksPort: number;

	beforeAll(async () => {
		// setup target HTTP server
		httpServer = http.createServer();
		httpWebSocketServer = new WebSocketServer({ server: httpServer });
		httpServerUrl = await listen(httpServer);
	});

	beforeAll(async () => {
		// setup target SSL HTTPS server
		httpsServer = https.createServer(sslOptions);
		httpsWebSocketServer = new WebSocketServer({ server: httpsServer });
		httpsServerUrl = await listen(httpsServer);
	});

	beforeAll(async () => {
		// setup SOCKS proxy server
		// @ts-expect-error no types
		socksServer = socks.createServer((_info, accept) => {
			accept();
		});
		socksServer.useAuth(socks.auth.None());
		await listen(socksServer);
		socksPort = socksServer.address().port;
	});

	beforeAll(async () => {
		// setup HTTP proxy server
		httpProxyServer = createProxy();
		httpProxyServerUrl = await listen(httpProxyServer);
	});

	beforeAll(async () => {
		// setup SSL HTTPS proxy server
		httpsProxyServer = createProxy(https.createServer(sslOptions));
		httpsProxyServerUrl = await listen(httpsProxyServer);
	});

	afterAll(() => {
		socksServer.close();
		httpServer.close();
		httpsServer.close();
		httpProxyServer.close();
		httpsProxyServer.close();
	});

	beforeEach(() => {
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;
		delete process.env.WS_PROXY;
		delete process.env.WSS_PROXY;
		delete process.env.NO_PROXY;
		httpServer.removeAllListeners('request');
		httpsServer.removeAllListeners('request');
		httpWebSocketServer.removeAllListeners('connection');
		httpsWebSocketServer.removeAllListeners('connection');
	});

	describe('"http" module', () => {
		it('should work with no proxy from env', async () => {
			httpServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			// `NO_PROXY` should take precedence
			process.env.NO_PROXY = '*';
			process.env.HTTP_PROXY = httpProxyServerUrl.href;
			const agent = new ProxyAgent();

			const res = await req(new URL('/test', httpServerUrl), { agent });
			const body = await json(res);
			assert.equal(httpServerUrl.host, body.host);
			assert(!('via' in body));
		});

		it('should work over "http" proxy', async () => {
			httpServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			process.env.HTTP_PROXY = httpProxyServerUrl.href;
			const agent = new ProxyAgent();

			const res = await req(new URL('/test', httpServerUrl), { agent });
			const body = await json(res);
			assert.equal(httpServerUrl.host, body.host);
			assert('via' in body);
		});

		it('should work over "https" proxy', async () => {
			httpServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			process.env.HTTP_PROXY = httpsProxyServerUrl.href;
			const agent = new ProxyAgent({ rejectUnauthorized: false });

			const res = await req(new URL('/test', httpServerUrl), { agent });
			const body = await json(res);
			assert.equal(httpServerUrl.host, body.host);
		});

		it('should work over "socks" proxy', async () => {
			httpServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			process.env.HTTP_PROXY = `socks://localhost:${socksPort}`;
			const agent = new ProxyAgent();

			const res = await req(new URL('/test', httpServerUrl), { agent });
			const body = await json(res);
			assert.equal(httpServerUrl.host, body.host);
		});

		it('should work with `keepAlive: true`', async () => {
			httpServer.on('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			process.env.HTTP_PROXY = httpsProxyServerUrl.href;
			const agent = new ProxyAgent({
				keepAlive: true,
				rejectUnauthorized: false,
			});

			try {
				const res = await req(new URL('/test', httpServerUrl), {
					agent,
				});
				res.resume();
				expect(res.headers.connection).toEqual('keep-alive');
				const s1 = res.socket;
				await once(s1, 'free');

				const res2 = await req(new URL('/test', httpServerUrl), {
					agent,
				});
				res2.resume();
				expect(res2.headers.connection).toEqual('keep-alive');
				const s2 = res2.socket;
				assert(s1 === s2);

				await once(s2, 'free');
			} finally {
				agent.destroy();
			}
		});
	});

	describe('"https" module', () => {
		it('should work over "https" proxy', async () => {
			let gotReq = false;
			httpsServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
				gotReq = true;
			});

			process.env.HTTPS_PROXY = httpsProxyServerUrl.href;
			const agent = new ProxyAgent({ rejectUnauthorized: false });

			const res = await req(new URL('/test', httpsServerUrl), {
				agent,
				rejectUnauthorized: false,
			});
			const body = await json(res);
			assert(gotReq);
			assert.equal(httpsServerUrl.host, body.host);
		});

		it('should work over "socks" proxy', async () => {
			let gotReq = false;
			httpsServer.once('request', function (req, res) {
				gotReq = true;
				res.end(JSON.stringify(req.headers));
			});

			process.env.HTTP_PROXY = `socks://localhost:${socksPort}`;
			const agent = new ProxyAgent();

			const res = await req(new URL('/test', httpsServerUrl), {
				agent,
				rejectUnauthorized: false,
			});
			const body = await json(res);
			assert(gotReq);
			assert.equal(httpsServerUrl.host, body.host);
		});

		it('should use `HttpProxyAgent` for "http" and `HttpsProxyAgent` for "https"', async () => {
			let gotHttpReq = false;
			httpServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
				gotHttpReq = true;
			});

			let gotHttpsReq = false;
			httpsServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
				gotHttpsReq = true;
			});

			process.env.ALL_PROXY = httpsProxyServerUrl.href;
			const agent = new ProxyAgent({ rejectUnauthorized: false });

			const res = await req(httpServerUrl, {
				agent,
			});
			const body = await json(res);
			assert(gotHttpReq);
			assert.equal(httpServerUrl.host, body.host);
			expect(agent.cache.size).toEqual(1);
			expect([...agent.cache.values()][0]).toBeInstanceOf(HttpProxyAgent);

			const res2 = await req(httpsServerUrl, {
				agent,
			});
			const body2 = await json(res2);
			assert(gotHttpsReq);
			assert.equal(httpsServerUrl.host, body2.host);
			expect(agent.cache.size).toEqual(2);
			expect([...agent.cache.values()][0]).toBeInstanceOf(
				HttpsProxyAgent
			);
		});

		it('should call provided function with getProxyForUrl option', async () => {
			let gotCall = false;
			let urlParameter = '';
			httpsServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			const agent = new ProxyAgent({
				rejectUnauthorized: false,
				getProxyForUrl: (u) => {
					gotCall = true;
					urlParameter = u;
					return httpsProxyServerUrl.href;
				},
			});
			const requestUrl = new URL('/test', httpsServerUrl);
			const res = await req(requestUrl, {
				agent,
				rejectUnauthorized: false,
			});
			const body = await json(res);
			assert(httpsServerUrl.host === body.host);
			assert(gotCall);
			assert(requestUrl.href === urlParameter);
		});

		it('should call provided function with asynchronous getProxyForUrl option', async () => {
			let gotCall = false;
			let urlParameter = '';
			httpsServer.once('request', function (req, res) {
				res.end(JSON.stringify(req.headers));
			});

			const agent = new ProxyAgent({
				rejectUnauthorized: false,
				getProxyForUrl: async(u) => {
					gotCall = true;
					urlParameter = u;
					await promisify(setTimeout)(1);
					return httpsProxyServerUrl.href;
				},
			});
			const requestUrl = new URL('/test', httpsServerUrl);
			const res = await req(requestUrl, {
				agent,
				rejectUnauthorized: false,
			});
			const body = await json(res);
			assert(httpsServerUrl.host === body.host);
			assert(gotCall);
			assert(requestUrl.href === urlParameter);
		});
	});

	describe('"ws" module', () => {
		it('should work over "http" proxy to `ws:` URL', async () => {
			let requestCount = 0;
			let connectionCount = 0;
			httpServer.once('request', function (req, res) {
				requestCount++;
				res.end();
			});
			httpWebSocketServer.on('connection', (ws) => {
				connectionCount++;
				ws.send('OK');
			});

			process.env.WS_PROXY = httpProxyServerUrl.href;
			const agent = new ProxyAgent();

			const ws = new WebSocket(httpServerUrl.href.replace('http', 'ws'), {
				agent,
			});
			const [message] = await once(ws, 'message');
			expect(connectionCount).toEqual(1);
			expect(requestCount).toEqual(0);
			expect(message.toString()).toEqual('OK');
			ws.close();
		});

		it('should work over "http" proxy to `wss:` URL', async () => {
			let requestCount = 0;
			let connectionCount = 0;
			httpsServer.once('request', function (req, res) {
				requestCount++;
				res.end();
			});
			httpsWebSocketServer.on('connection', (ws) => {
				connectionCount++;
				ws.send('OK');
			});

			process.env.WSS_PROXY = httpProxyServerUrl.href;
			const agent = new ProxyAgent();

			const ws = new WebSocket(
				httpsServerUrl.href.replace('https', 'wss'),
				{
					agent,
					rejectUnauthorized: false,
				}
			);
			const [message] = await once(ws, 'message');
			expect(connectionCount).toEqual(1);
			expect(requestCount).toEqual(0);
			expect(message.toString()).toEqual('OK');
			ws.close();
		});
	});
});
