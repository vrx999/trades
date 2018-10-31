const Exchange = require('../exchange');
const WebSocket = require('ws');

class Bitmex extends Exchange {

	constructor(options) {
		super(options);

		this.id = 'bitmex';

		this.mapping = {
			ETHUSD: 'ETHUSD',
			BTCUSD: 'XBTUSD',
			EOSBTC: 'EOSU18',
			ADABTC: 'ADAU18',
			BCHBTC: 'BCHU18',
			ETHBTC: 'ETHU18',
			LTCBTC: 'LTCU18',
			XRPBTC: 'XRPU18',
		}

		this.options = Object.assign({
			url: () => {
				return `wss://www.bitmex.com/realtime?subscribe=trade:${this.pair},liquidation:${this.pair}`
			},
		}, this.options);
	}

	connect(pair) {
    if (!super.connect(pair))  
      return;

		this.api = new WebSocket(this.getUrl());
		this.api.on('message', event => this.emitData(this.format(event)));

		this.api.on('open', this.emitOpen.bind(this));

		this.api.on('close', this.emitClose.bind(this));

		this.api.on('error', this.emitError.bind(this));
	}

	disconnect() {
    if (!super.disconnect())  
      return;

		if (this.api && this.api.readyState < 2) {
			this.api.close();
		}
	}

	format(event) {
		const json = JSON.parse(event);

		if (json && json.data && json.data.length) {
			if (json.table === 'liquidation' && json.action === 'insert') {
				return json.data.map(trade => {
					return [
						+new Date(),
						trade.price,
						trade.leavesQty / trade.price,
						trade.side === 'Buy' ? 1 : 0,
						1
					]
				});
			} else if (json.table === 'trade' && json.action === 'insert') {
				return json.data.map(trade => {					
					return [
						+new Date(trade.timestamp),
						trade.price,
						trade.size / trade.price,
						trade.side === 'Buy' ? 1 : 0
					]
				});
			}
		}

		return false;
	}

}

module.exports = Bitmex;
