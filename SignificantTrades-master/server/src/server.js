const EventEmitter = require('events');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const http = require('http');
const axios = require('axios');

class Server extends EventEmitter {

	constructor(options) {
		super();

		this.timestamps = {};
		this.connected = false;
		this.processingAction = false;
		this.chunk = [];

		this.options = Object.assign({

			// default pair we track
			pair: 'BTCUSD',

			// default server port
			port: 3000,

			// dont broadcast below ms interval
			delay: 0,

			// restrict origin
			origin: '*',

			// profile exchange status interval
			profilerInterval: 60000 * 3,

			// do backup interval
			backupInterval: 60000 * 10,

			// create backup file every X ms
			backupTimeframe: 1000 * 60 * 60 * 24,

		}, options);

		if (!this.options.exchanges || !this.options.exchanges.length) {
			throw new Error('You need to specify at least one exchange to track');
		}

		this.exchanges = this.options.exchanges;

		this.queue = [];

		this.listen();
		this.connect();
	}

	listen() {
		this.wss = new WebSocket.Server({
			noServer: true
		});

		this.wss.on('connection', (ws, req) =>  {
			const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

			ws.admin = this.isAdmin(ip);

			console.log(`[client] ${ip} joined ${req.url}`);

			this.emit('connections', this.wss.clients.size);

			ws.send(JSON.stringify({
				type: 'welcome',
				admin: ws.admin,
				pair: this.options.pair,
				timestamp: +new Date(),
				exchanges: this.exchanges.map((exchange) => {
					return {
						id: exchange.id,
						connected: exchange.connected
					}
				})
			}));

			ws.on('message', event => {
				if (this.processing) {
					console.log(`[${ip}] message blocked due to current action`, event);
				}

				let method, message;

				try {
					const json = JSON.parse(event);

					method = json.method;
					message = json.message;
				} catch (error) {
					console.log(`[${ip}]`, 'invalid message', event);
					return;
				}

				switch (method) {
					case 'pair':
						if (!ws.admin) {
							return;
						}

						this.options.pair = message.toUpperCase();

						console.log(`[${ip}] switching pair`, this.options.pair);

						this.action(method, next => {
							this.disconnect();

							this.broadcast({
								type: 'pair',
								pair: this.options.pair,
							})

							setTimeout(() => {
								this.connect();

								next();
							}, 5000);
						})
					break;
					default:
						console.log(`[${ip}] unrecognized method`, method);
					break;
				}
			});

			ws.on('close', event => {
				setTimeout(() => this.emit('connections', this.wss.clients.size), 100);
			});
		});

		this.exchanges.forEach(exchange => {
			exchange.on('data', event => {
				this.timestamps[event.exchange] = +new Date();

				for (let trade of event.data) {
					trade.unshift(event.exchange);

					this.chunk.push(trade);

					if (this.options.delay) {
						this.queue.unshift(trade);
					}
				}

				if (!this.options.delay) {
					this.broadcast(event.data);
				}
			});

			exchange.on('open', event => {
				if (!this.connected) {
					console.log(`[warning] "${exchange.id}" connected but the server state was disconnected`);
					return exchange.disconnect();
				}

				this.broadcast({
					type: 'exchange_connected',
					id: exchange.id
				});
			});

			exchange.on('err', event => {
				this.broadcast({
					type: 'exchange_error',
					id: exchange.id,
					message: event.message
				});
			});

			exchange.on('close', event => {
				if (this.connected) {
					exchange.reconnect(this.options.pair);
				}

				this.broadcast({
					type: 'exchange_disconnected',
					id: exchange.id
				});
			});
		});

		this.profilerInterval = setInterval(this.profiler.bind(this), this.options.profilerInterval);
		this.backupInterval = setInterval(this.backup.bind(this), this.options.backupInterval);

		this.http = http.createServer((request, response) => {
			response.setHeader('Access-Control-Allow-Origin', this.options.origin);

			let ip = request.headers['x-forwarded-for'] || request.connection.remoteAddress;

			if (ip.indexOf('::ffff:') === 0) {
				ip = ip.substr('::ffff:'.length, ip.length);
			}

			const path = url.parse(request.url).path;			
			
			let helloworld = true;

			const routes = [{
				match: /^\/?history\/(\d+)\/(\d+)\/?$/,
				response: (from, to) => {
					let date, name, path, chunk, output = [];

					from = +from;
					to = +to;

					if (from > to) {
						response.writeHead(400);
						response.end('Invalid interval');
						return;
					}

					if (to - from > this.options.backupTimeframe * 2) {
						response.writeHead(400);
						response.end('Interval must be <= than 2 days');
						return;
					}

					console.log(`[server/history] requesting ${to - from}ms of trades`);

					for (let i = +new Date(new Date(+from).setHours(0, 0, 0, 0)); i <= to; i += this.options.backupTimeframe) {
						date = new Date(i);
						path = this.getBackupFilename(date);

						try {
							chunk = fs.readFileSync(path, 'utf8').trim().split("\n");

							if (chunk[0].split(' ')[1] >= from && chunk[chunk.length - 1].split(' ')[1] <= to) {
								console.log(`[server/history] append ${path} (ms ${i}) to output`, chunk.length);

								output = output.concat(chunk.map(row => row.split(' ')));
							} else {
								console.log(`[server/history] unpacking ${path} (total ${chunk.length} trades)`);

								for (let j = 0; j < chunk.length; j++) {
									const trade = chunk[j].split(' ');

									if (trade[1] <= from || trade[1] >= to) {
										continue;
									}

									output.push(trade);
								}
							}
						} catch (error) {
							console.log(`[server/history] unable to get ${path} (ms ${i})`, error.message);
						}
					}

					for (let i = 0; i < this.chunk.length; i++) {
						if (this.chunk[i][1] <= from || this.chunk[i][1] >= to) {
							continue;
						}

						output.push(this.chunk[i]);
					}

					response.setHeader('Content-Type', 'application/json');
					response.end(JSON.stringify(output));
				}
			},
			{
				match: /^\/?cors\/(.*)\/?$/,
				response: (arg) => {
					const location = url.parse(arg);

					console.log(`[server/cors] ${ip} fetching ${location.host} -> ${location.pathname}`);

					if ([
						'api.kraken.com',
						'api.binance.com',
						'api.bitfinex.com',
						'api.gdax.com',
						'api.pro.coinbase.com',
						'api.prime.coinbase.com',
						'www.bitstamp.net',
						'api.hitbtc.com',
						'poloniex.com',
						'www.okex.com',
						'api.huobi.pro',
						'www.bitmex.com',
						'api.coinex.com',
					].indexOf(location.hostname) === -1) {
						console.log(`[server/cors] unknown host ${location.hostname}`);
					} else {
						helloworld = false;

						axios.get(arg, {transformResponse: undefined})
							.then(_response => {
								response.writeHead(200);
								response.end(_response.data);
							})
							.catch(error => {
								console.log(error);
								response.writeHead(500);
								response.end();
							})
					}
				}
			}];

			for (let route of routes) {
				if (route.match.test(path)) {
					route.response.apply(this, path.match(route.match).splice(1));
					break;
				}
			}

			if (!response.finished && helloworld) {
				response.writeHead(404);
				response.end(`
					<!DOCTYPE html>
					<html>
						<head>
							<title>SignificantTrades</title>
							<meta name="robots" content="noindex">
						</head>
						<body>
							You seems lost, the actual app is located <a target="_blank" href="https://github.com/Tucsky/SignificantTrades">here</a>.<br>
							You like it ? <a target="_blank" href="bitcoin:3GLyZHY8gRS96sH4J9Vw6s1NuE4tWcZ3hX">BTC for more :-)</a>.<br><br>
							<small>24/7 aggregator for BTCUSD</small>
						</body>
					</html>
				`);
			}
		});

		this.http.on('upgrade', (request, socket, head) => {
			if (this.options.origin !== '*' && request.headers['origin'] !== this.options.origin) {
				console.log(`[client] socket origin mismatch (${this.options.origin} !== ${request.headers['origin']})`)

				socket.destroy();

				return;
			}

			this.wss.handleUpgrade(request, socket, head, ws => {
				this.wss.emit('connection', ws, request);
			});
		});

		this.http.listen(this.options.port, () => {
			console.log('http server listening on port ' + this.options.port);
		});
	}

	connect() {
		console.log('[server] connect exchange using pair', this.options.pair);

		this.connected = true;
		this.chunk = [];

		this.exchanges.forEach(exchange => {
			exchange.connect(this.options.pair);
		});

		if (this.options.delay) {
			this.delayInterval = setInterval(() => {
				if (!this.queue.length) {
					return;
				}

				this.broadcast(this.queue);

				this.queue = [];
			}, this.options.delay || 1000);
		}
	}

	broadcast(data) {
		this.wss.clients.forEach(client => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(data));
			}
		});
	}

	disconnect() {
		clearInterval(this.delayInterval);

		this.connected = false;

		this.exchanges.forEach(exchange => {
			exchange.disconnect();
		});
	}

	action(method, fn) {
		if (this.processingAction) {
			return console.error('[warning] wait until current action is done');
		}

		console.log(`[${method}] starting`);

		this.processingAction = true;

		fn(() => {
			console.log(`[${method}] done`);
			this.processingAction = false;
		});
	}

	profiler() {
		const now = +new Date();

		this.exchanges.forEach(exchange => {
			if (!exchange.connected) {
				return;
			}

			if (!this.timestamps[exchange.id]) {
				console.log('[warning] no data sent from ' + exchange.id);
				exchange.disconnect() && exchange.reconnect(this.options.pair);

				return;
			}

			if (now - this.timestamps[exchange.id] > 1000 * 60 * 5) {
				console.log('[warning] ' + exchange.id + ' hasn\'t sent any data since more than 5 minutes');
				
				delete this.timestamps[exchange.id];
				
				exchange.disconnect() && exchange.reconnect(this.options.pair);
				
				return;
			}
		})
	}

	isAdmin(ip) {
		if (['localhost', '127.0.0.1', '::1'].indexOf(ip) !== -1) {
			return true;
		}

		const whitelistPath = '../admin.txt';

		if (fs.existsSync(whitelistPath)) {
			const file = fs.readFileSync(whitelistPath, 'utf8');

			if (!file || !file.trim().length) {
				return false;
			}

			return file.split("\n").indexOf(ip) !== -1;
		}

		return false;
	}

	backup(exit = false) {
		if (!this.chunk.length) {
			exit && process.exit();
			
			return;
		}

		console.log(`[server/backup] preparing to backup ${this.chunk.length} trades... (${this.options.backupInterval / 1000 + 's'} of data)`);

		const processDate = (date) => {
			const nextDateTimestamp = +date + this.options.backupTimeframe;
			const path = this.getBackupFilename(date);

			console.log(`[server/backup] retrieve trades < ${nextDateTimestamp}`);

			let tradesOfTheDay = [];

			for (let i = 0; i < this.chunk.length; i++) {
				if (this.chunk[i][1] < nextDateTimestamp) {
					tradesOfTheDay.push(this.chunk[i]);
					this.chunk.splice(i, 1);
					i--;
				}
			}

			if (!tradesOfTheDay.length) {
				console.log(`[server/backup] no trades that day, on to the next day (first timestamp: ${this.chunk[0][1]})`);
				return processDate(new Date(nextDateTimestamp));
			}

			console.log(`[server/backup] write ${tradesOfTheDay.length} trades into ${path}`);

			fs.appendFile(path, tradesOfTheDay.map(trade => trade.join(' ')).join("\n") + "\n", (err) => {
				if (err) {
					throw new Error(err);
				}

				if (this.chunk.length && this.chunk[0][1] >= nextDateTimestamp) {
					console.log(`[server/backup] next chunk start at ${this.chunk[0][1]}, next day at ${nextDateTimestamp}`);

					return processDate(new Date(nextDateTimestamp));
				} else {
					exit && process.exit();
				}
			});
		};

		processDate(new Date(new Date(this.chunk[0][1]).setHours(0, 0, 0, 0)));
	}

	getBackupFilename(date) {
		return 'data/' + (this.options.pair + '_' + date.getFullYear() + '-' + ('0' + (date.getMonth()+1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2));
	}

}

module.exports = Server;