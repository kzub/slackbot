var slack = require('../node-slack-sdk');
var fs = require('fs');
const BOT_NAME = "zuma";
const CLIAM_TIME = 1000*60*2;
const CLAIM_DIR = "servers";
const DESTROY_TIME = 1000*60*5;
const BOT_CHANNEL = "zktest";
const CHECK_SERVERS_STATUS_INTERVAL = 1000*5;

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;

var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!');
});

rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
	var result;
  try {
		console.log(message);
		if (!message.user) {
			return;
		}
		var slackuser = rtm.dataStore.getUserById(message.user).name;
		var slackchannel = rtm.dataStore.getChannelGroupOrDMById(message.channel).name;
		console.log('User %s posted a message in %s channel', slackuser, slackchannel);

	  var data = parseMessage(message.text);
	  if (!data) {
	  	console.log('no cmd');
	  	return;
	  }

	  switch (data.cmd) {
	  	case 'get': 
	  		result = claimServer(data.params[0], slackuser); break;
	  	case 'free': 
	  		result = unClaimServer(data.params[0], slackuser); break;
	  	case 'list':
	  		result = listServers(); break;
	  	default: 
	  		result = 'unknown command';
	  }  	
  } catch(err) {
  	console.error(err);
  	result = typeof(err) === "string" ? err : "Internal error";
  }

  rtm.sendMessage(result, message.channel);
});

//-----------------------------------------------------------
function claimServer(server, slackuser) {
	var data = readServerData(server);
	var current_time = Date.now();
	var userchange = data.owner != slackuser;
	var lastowner = data.owner;

	if (data.valid_till_timestamp && slackuser !== data.owner) {
		if(current_time < data.valid_till_timestamp) {
			return 'ERROR. ' + server + ' is owned by <@' + data.owner + '> till ' +
				     getDateFromTimestamp(data.valid_till_timestamp);
		}
	}	
	
	if (!data.server_created_timestamp) {
		createServerWebhook(server);
		data.server_created_timestamp = Date.now();
	}

	data.valid_till_timestamp = current_time + CLIAM_TIME;
	data.owner = slackuser;
	writeServerData(server, data);

	var result = 'OK. ' + server + ' is yours <@' + data.owner + '> till ' +
		           getDateFromTimestamp(data.valid_till_timestamp);

	if (userchange) {
		result += "\n<@" + lastowner + "> lost ownership\n";
	}
	return result;
}

//-----------------------------------------------------------
function unClaimServer(server, slackuser) {
	var data = readServerData(server);
	var current_time = Date.now();
	var expired = data.valid_till_timestamp < current_time;
	var lastowner = data.owner;

	if (!expired && slackuser !== data.owner) {
		return 'ERROR. ' + server + ' is owned by <@' + data.owner + '>';
	} 
	
	data.valid_till_timestamp = current_time;
	data.owner = undefined;
	writeServerData(server, data);

	var result = 'OK. ' + server + ' is free';
	if (lastowner) {
		result += '\n<@' + lastowner + '> lost ownership';
	}
	return result;
}

//-----------------------------------------------------------
function listServers() {
	var datas = readServersData();
	var result = [];
	var current_time = Date.now();

	datas.sort(function (a, b) {
		if (a < b) { return -1; }
		else if (a > b) { return 1; }
		else return 0;
	});

	for (var idx in datas) {
		var data = datas[idx];
		if (!data.valid_till_timestamp || data.valid_till_timestamp <= current_time) {
			result.push(data.server + ' is free');	
		} else {
			result.push(data.server + ' is owned by ' + data.owner + ' till ' + 
			            getDateFromTimestamp(data.valid_till_timestamp));
		}
	}

	return result.join('\n');
}

//-----------------------------------------------------------
function checkServersLoop() {
	if (!rtm.connected) {
		console.log('checkServersLoop: not connected');
		return;
	}
	console.log('checkServersLoop: do the job');

	var datas = readServersData();
	var result = [];
	var current_time = Date.now();

	for (var idx in datas) {
		var data = datas[idx];
		if (data.valid_till_timestamp < current_time) {
			freeServerByBot(data.server, data);
		}
		if (data.valid_till_timestamp < current_time + DESTROY_TIME) {
			destroyServerByBot(data.server, data);
		}
	}
}
setInterval(checkServersLoop, CHECK_SERVERS_STATUS_INTERVAL);

//-----------------------------------------------------------
function freeServerByBot(server, data) {
	if (data.owner) {
		var lastowner = data.owner;
		data.owner = undefined;
		writeServerData(server, data);
		rtm.sendMessage(server + "released by bot\n<@" + lastowner + "> lost ownership", BOT_CHANNEL);
	}
}

//-----------------------------------------------------------
function freeServerByBot(server, data) {
	if (data.server_created_timestamp) {
		destroyServerWebhook(server);
		data.server_created_timestamp = undefined;
		writeServerData(server, data);
		rtm.sendMessage(server + "destroyed by bot\n", BOT_CHANNEL);
	}
}

//-----------------------------------------------------------
function readServerData(server) {
	var serversList = fs.readdirSync(CLAIM_DIR);
	if (serversList.indexOf(server) === -1) {
		throw 'Unknown server: ' + server;
	}

	var serverFileName = [CLAIM_DIR, server].join('/');
	var data = fs.readFileSync(serverFileName);

	try {
		data = JSON.parse(data);
	} catch(e) {
		console.error(e);
		throw 'Internal error while reading: ' + server;
	}

	return data;
}

//-----------------------------------------------------------
function readServersData() {
	var serversList = fs.readdirSync(CLAIM_DIR);
	var result = [];

	for (var idx in serversList) {
		var server = serversList[idx];
		var serverFileName = [CLAIM_DIR, server].join('/');
		var data = fs.readFileSync(serverFileName);
		
		try {
			data = JSON.parse(data);
		} catch(e) {
			console.error(e);
			throw 'Internal error while reading: ' + server;
		}

		data.server = server;
		result.push(data);
	}

	return result;
}

//-----------------------------------------------------------
function writeServerData(server, data) {
	var serverFileName = [CLAIM_DIR, server].join('/');
	fs.writeFileSync(serverFileName, JSON.stringify(data));
}

//-----------------------------------------------------------
function createServerWebhook(server) {
	console.log('CREATE SERVER webhook', server);
}
function destroyServerWebhook(server) {
	console.log('DESTROY SERVER webhook', server);
}
//-----------------------------------------------------------
function getDateFromTimestamp(timestamp) {
	return new Date(timestamp).toJSON().slice(0,19).replace('T',' ') + ' (GMT)';
}
//-----------------------------------------------------------
function parseMessage(message) {
	if (!message) return;

	if (message[0] === '<' && message[1] === '@') {
		var username_end = message.indexOf('>');
		var user = message.slice(2, username_end);
		var slackuser = rtm.dataStore.getUserById(user).name;
		if (slackuser.indexOf(BOT_NAME) !== 0) {
			return;	
		}
	}
	else if (message.indexOf(BOT_NAME) !== 0) {
		return;
	}
 	
 	var parts = message.split(' ');

 	return {
 		cmd: parts[1],
 		params: parts.slice(2)
 	};
}




